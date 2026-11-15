package store

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"
)

// The trash: what the referee deletes or clears is moved to data/trash/
// rather than removed, so a slip can be undone straight away and anything
// can be put back for TrashKeep. Each item is a folder:
//
//	trash/<item>/item.json      what it was and where it goes back to
//	trash/<item>/page/<name>    a deleted page
//	trash/<item>/state.json     its entries (or the entries that were cleared)
//	trash/<item>/copies/        players' copies (<player>.json), or a removed player's folder
//	trash/<item>/campaign/      a deleted campaign's whole folder
//
// Lock order: trashMu, then metaMu or ioMu (then mu). Every trash operation
// holds trashMu, so an item is never restored twice or emptied mid-restore.

// TrashKeep is how long the trash keeps an item before Open empties it.
const TrashKeep = 30 * 24 * time.Hour

// What a trash item is.
const (
	TrashPage     = "page"     // a page, with its entries and every copy
	TrashCampaign = "campaign" // a whole campaign
	TrashEntries  = "entries"  // what was typed into a page or one copy, cleared
	TrashPlayer   = "player"   // a player taken off the party (and their copies, if deleted)
)

// TrashItem describes one thing in the trash.
type TrashItem struct {
	ID          string    `json:"id"`
	Kind        string    `json:"kind"`
	Session     string    `json:"session"`
	SessionName string    `json:"sessionName"`
	Deleted     time.Time `json:"deleted"`
	// Scope and Name are the page (TrashPage, TrashEntries).
	Scope Scope  `json:"scope,omitempty"`
	Name  string `json:"name,omitempty"`
	// Title is what the page or player was called, for the list.
	Title string `json:"title,omitempty"`
	// Player is whose copy was cleared (TrashEntries; "" is the page's own
	// entries) or who was removed (TrashPlayer).
	Player string `json:"player,omitempty"`

	// What putting it back needs.
	Meta      *PageMeta `json:"meta,omitempty"`      // the page's details
	Index     int       `json:"index"`               // its place in the scope's order, -1 if none
	Record    *Player   `json:"record,omitempty"`    // the removed player
	AllowedOn []string  `json:"allowedOn,omitempty"` // pages shown only to some players that listed them
	Copies    bool      `json:"copies,omitempty"`    // the removed player's copies were deleted with them
}

var trashIDRe = regexp.MustCompile(`^\d{8}-\d{9}-[0-9a-f]{6}$`)

func (s *Store) trashDir() string { return filepath.Join(s.root, "trash") }

// newTrashItem claims a fresh folder for an item. Its name sorts by time.
func (s *Store) newTrashItem() (string, string, error) {
	var r [3]byte
	_, _ = rand.Read(r[:])
	tid := time.Now().UTC().Format("20060102-150405.000")
	tid = strings.Replace(tid, ".", "", 1) + "-" + hex.EncodeToString(r[:])
	dir := filepath.Join(s.trashDir(), tid)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", "", err
	}
	return tid, dir, nil
}

func writeTrashItem(dir string, it TrashItem) error {
	b, _ := json.MarshalIndent(it, "", "  ")
	return writeAtomic(filepath.Join(dir, "item.json"), b)
}

// moveIfThere renames from to to, creating to's folder, and reports whether
// there was anything to move.
func moveIfThere(from, to string) (bool, error) {
	if _, err := os.Stat(from); errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return false, err
	}
	return true, os.Rename(from, to)
}

// pageInfo is what a page's trash item records about it: its details, its
// place in the order, and the campaign's name.
func (s *Store) pageInfo(id string, sc Scope, name string) (TrashItem, error) {
	m, err := s.loadMeta(id)
	if err != nil {
		return TrashItem{}, err
	}
	it := TrashItem{Session: id, SessionName: m.Name, Scope: sc, Name: name, Index: slices.Index(m.Order[sc], name), Deleted: time.Now().UTC()}
	if pm, ok := m.Pages[pageKey(sc, name)]; ok {
		it.Meta = &pm
		it.Title = pm.Title
	}
	return it, nil
}

// DeleteFile moves a page to the trash, with its entries and every player's
// copy of it (so a new page with the same name starts empty). It returns
// the trash item's id.
func (s *Store) DeleteFile(id string, sc Scope, name string) (string, error) {
	p, err := s.filePath(id, sc, name)
	if err != nil {
		return "", err
	}
	s.trashMu.Lock()
	defer s.trashMu.Unlock()
	if _, err := os.Stat(p); err != nil {
		return "", fmt.Errorf("file %q: %w", name, ErrNotFound)
	}
	it, err := s.pageInfo(id, sc, name)
	if err != nil {
		return "", err
	}
	it.Kind = TrashPage
	tid, dir, err := s.newTrashItem()
	if err != nil {
		return "", err
	}
	it.ID = tid
	if err := writeTrashItem(dir, it); err != nil {
		os.RemoveAll(dir)
		return "", err
	}
	if err := s.trashPageFiles(id, sc, name, p, dir); err != nil {
		os.RemoveAll(dir)
		return "", err
	}
	s.movePageMeta(id, sc, name, "", "")
	return tid, nil
}

// trashPageFiles moves a page, its entries and its copies into dir. Pending
// entries are written first, so the trash holds the latest of them.
func (s *Store) trashPageFiles(id string, sc Scope, name, p, dir string) error {
	s.ioMu.Lock()
	defer s.ioMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	own := stateKey(id, sc, name, "")
	s.flushLocked(own)
	owners := s.copyOwnersLocked(id, name)
	for _, pid := range owners {
		s.flushLocked(stateKey(id, Shared, name, pid))
	}
	if _, err := moveIfThere(p, filepath.Join(dir, "page", name)); err != nil {
		return err
	}
	s.dropLocked(own)
	if _, err := moveIfThere(s.statePath(id, sc, name, ""), filepath.Join(dir, "state.json")); err != nil {
		log.Printf("moving the entries of %s/%s to the trash: %v", id, name, err)
	}
	for _, pid := range owners {
		s.dropLocked(stateKey(id, Shared, name, pid))
		if _, err := moveIfThere(s.statePath(id, Shared, name, pid), filepath.Join(dir, "copies", pid+".json")); err != nil {
			log.Printf("moving %s's entries for %s to the trash: %v", pid, name, err)
		}
	}
	return nil
}

// DeleteSession moves a campaign's whole folder to the trash, and returns
// the trash item's id.
func (s *Store) DeleteSession(id string) (string, error) {
	if err := s.checkSession(id); err != nil {
		return "", err
	}
	s.trashMu.Lock()
	defer s.trashMu.Unlock()
	m, err := s.loadMeta(id)
	if err != nil {
		return "", err
	}
	tid, dir, err := s.newTrashItem()
	if err != nil {
		return "", err
	}
	it := TrashItem{ID: tid, Kind: TrashCampaign, Session: id, SessionName: m.Name, Index: -1, Deleted: time.Now().UTC()}
	if err := writeTrashItem(dir, it); err != nil {
		os.RemoveAll(dir)
		return "", err
	}
	s.ioMu.Lock()
	defer s.ioMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, st := range s.states {
		if strings.HasPrefix(k, id+"/") {
			s.flushLocked(k)
			if st.timer != nil {
				st.timer.Stop()
			}
			delete(s.states, k)
		}
	}
	if err := os.Rename(s.dir(id), filepath.Join(dir, "campaign")); err != nil {
		os.RemoveAll(dir)
		return "", err
	}
	if s.cfg.ActiveSession == id {
		s.cfg.ActiveSession = ""
		_ = s.saveConfig()
	}
	return tid, nil
}

// ResetState clears all saved values for a file, or for one player's copy
// of it, moving them to the trash. A cleared copy starts again from the
// template's entries. It returns the trash item's id, or "" when there was
// nothing saved to clear.
func (s *Store) ResetState(id string, sc Scope, name, player string) (string, error) {
	if err := s.checkState(id, sc, name, player); err != nil {
		return "", err
	}
	s.trashMu.Lock()
	defer s.trashMu.Unlock()
	it, err := s.pageInfo(id, sc, name)
	if err != nil {
		return "", err
	}
	it.Kind, it.Player = TrashEntries, player
	s.ioMu.Lock()
	defer s.ioMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	k, sp := stateKey(id, sc, name, player), s.statePath(id, sc, name, player)
	s.flushLocked(k)
	s.dropLocked(k)
	if _, err := os.Stat(sp); errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	tid, dir, err := s.newTrashItem()
	if err != nil {
		return "", err
	}
	it.ID = tid
	if err := writeTrashItem(dir, it); err != nil {
		os.RemoveAll(dir)
		return "", err
	}
	if err := os.Rename(sp, filepath.Join(dir, "state.json")); err != nil {
		os.RemoveAll(dir)
		return "", err
	}
	return tid, nil
}

// RemovePlayer takes a player off the roster, recording them in the trash
// so they can be put back with the pages that were shown only to them.
// Their copies of per-player pages stay in state/players/<id>/, unless
// deleteEntries is set: then they go to the trash too. It returns the trash
// item's id.
func (s *Store) RemovePlayer(id, player string, deleteEntries bool) (string, error) {
	s.trashMu.Lock()
	defer s.trashMu.Unlock()
	var it TrashItem
	m, err := s.updateMeta(id, func(m *Session) error {
		i := findPlayer(m.Players, player)
		if i < 0 {
			return fmt.Errorf("player %q: %w", player, ErrNotFound)
		}
		rec := m.Players[i]
		it = TrashItem{Kind: TrashPlayer, Session: id, Player: player, Title: rec.Name, Record: &rec, Index: i, Copies: deleteEntries, Deleted: time.Now().UTC()}
		m.Players = slices.Delete(m.Players, i, i+1)
		// Pages shown only to some players stop listing them. A page left
		// with nobody stays shown to nobody but the referee.
		for k, pm := range m.Pages {
			if j := slices.Index(pm.Allowed, player); j >= 0 {
				it.AllowedOn = append(it.AllowedOn, k)
				pm.Allowed = slices.Delete(slices.Clone(pm.Allowed), j, j+1)
				if len(pm.Allowed) == 0 {
					pm.Allowed = nil
				}
				m.Pages[k] = pm
			}
		}
		sort.Strings(it.AllowedOn)
		return nil
	})
	if err != nil {
		return "", err
	}
	it.SessionName = m.Name
	tid, dir, err := s.newTrashItem()
	if err == nil {
		it.ID = tid
		err = writeTrashItem(dir, it)
	}
	if err != nil {
		// The player is off the roster already: say so rather than fail.
		log.Printf("recording %s's removal in the trash: %v", player, err)
		tid, dir = "", ""
	}
	s.ioMu.Lock()
	defer s.ioMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	prefix := id + "/players/" + player + "/"
	for k := range s.states {
		if strings.HasPrefix(k, prefix) {
			// Pending entries are written now: kept ones would otherwise
			// never be flushed once nobody can open the copy, and deleted
			// ones go to the trash whole.
			s.flushLocked(k)
			delete(s.states, k)
		}
	}
	if !deleteEntries {
		return tid, nil
	}
	from := filepath.Join(s.playersStateDir(id), player)
	if dir == "" {
		if err := os.RemoveAll(from); err != nil && !errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("removing %s's entries: %w", player, err)
		}
		return "", nil
	}
	if _, err := moveIfThere(from, filepath.Join(dir, "copies")); err != nil {
		return tid, fmt.Errorf("moving %s's entries to the trash: %w", player, err)
	}
	return tid, nil
}

// ListTrash lists what is in the trash, newest first.
func (s *Store) ListTrash() ([]TrashItem, error) {
	s.trashMu.Lock()
	defer s.trashMu.Unlock()
	return s.listTrashLocked()
}

func (s *Store) listTrashLocked() ([]TrashItem, error) {
	entries, err := os.ReadDir(s.trashDir())
	if errors.Is(err, os.ErrNotExist) {
		return []TrashItem{}, nil
	} else if err != nil {
		return nil, err
	}
	out := []TrashItem{}
	for _, e := range entries {
		if !e.IsDir() || !trashIDRe.MatchString(e.Name()) {
			continue
		}
		if it, err := s.readTrashItem(e.Name()); err == nil {
			out = append(out, it)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID > out[j].ID })
	return out, nil
}

func (s *Store) readTrashItem(tid string) (TrashItem, error) {
	if !trashIDRe.MatchString(tid) {
		return TrashItem{}, fmt.Errorf("%w: that isn't in the trash", ErrNotFound)
	}
	b, err := os.ReadFile(filepath.Join(s.trashDir(), tid, "item.json"))
	if err != nil {
		return TrashItem{}, fmt.Errorf("%w: that isn't in the trash (any more)", ErrNotFound)
	}
	var it TrashItem
	if err := json.Unmarshal(b, &it); err != nil {
		return TrashItem{}, fmt.Errorf("%w: that trash item can't be read", ErrInvalid)
	}
	it.ID = tid
	if !validName(it.Session) || (it.Name != "" && !validName(it.Name)) || (it.Player != "" && !ValidPlayerID(it.Player)) {
		return TrashItem{}, fmt.Errorf("%w: that trash item can't be read", ErrInvalid)
	}
	return it, nil
}

// EmptyTrash deletes everything in the trash for good.
func (s *Store) EmptyTrash() error {
	s.trashMu.Lock()
	defer s.trashMu.Unlock()
	return os.RemoveAll(s.trashDir())
}

// purgeTrash empties items older than keep, and folders left half-made.
func (s *Store) purgeTrash(keep time.Duration) {
	s.trashMu.Lock()
	defer s.trashMu.Unlock()
	entries, _ := os.ReadDir(s.trashDir())
	cutoff := time.Now().Add(-keep)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		old := false
		if it, err := s.readTrashItem(e.Name()); err == nil {
			old = it.Deleted.Before(cutoff)
		} else if fi, err := e.Info(); err == nil {
			old = fi.ModTime().Before(time.Now().Add(-24 * time.Hour))
		}
		if old {
			if err := os.RemoveAll(filepath.Join(s.trashDir(), e.Name())); err != nil {
				log.Printf("emptying the trash: %v", err)
			}
		}
	}
}

// RestoreTrash puts an item back where it came from, and returns it as
// restored: a page whose name was taken in the meantime comes back under a
// free one (Name), a campaign whose folder was taken under a free id
// (Session).
func (s *Store) RestoreTrash(tid string) (TrashItem, error) {
	s.trashMu.Lock()
	defer s.trashMu.Unlock()
	it, err := s.readTrashItem(tid)
	if err != nil {
		return TrashItem{}, err
	}
	dir := filepath.Join(s.trashDir(), tid)
	switch it.Kind {
	case TrashPage:
		err = s.restorePage(&it, dir)
	case TrashCampaign:
		err = s.restoreCampaign(&it, dir)
	case TrashEntries:
		err = s.restoreEntries(it, dir)
	case TrashPlayer:
		err = s.restorePlayer(it, dir)
	default:
		err = fmt.Errorf("%w: that trash item can't be read", ErrInvalid)
	}
	if err != nil {
		return TrashItem{}, err
	}
	if err := os.RemoveAll(dir); err != nil {
		log.Printf("emptying restored trash item %s: %v", tid, err)
	}
	return it, nil
}

func (s *Store) campaignThere(it TrashItem) error {
	if err := s.checkSession(it.Session); err != nil {
		return fmt.Errorf("%w: the campaign %q is gone; put it back first", ErrNotFound, it.SessionName)
	}
	return nil
}

func (s *Store) restorePage(it *TrashItem, dir string) error {
	if _, err := ParseScope(string(it.Scope)); err != nil {
		return err
	}
	if err := s.campaignThere(*it); err != nil {
		return err
	}
	name, err := s.FreeName(it.Session, it.Name)
	if err != nil {
		return err
	}
	to, err := s.filePath(it.Session, it.Scope, name)
	if err != nil {
		return err
	}
	if err := s.restorePageFiles(*it, dir, name, to); err != nil {
		return err
	}
	_, err = s.updateMeta(it.Session, func(m *Session) error {
		if it.Meta != nil {
			if m.Pages == nil {
				m.Pages = map[string]PageMeta{}
			}
			pm := *it.Meta
			// Players who left meanwhile aren't listed again.
			pm.Allowed = slices.DeleteFunc(slices.Clone(pm.Allowed), func(p string) bool { return findPlayer(m.Players, p) < 0 })
			if len(pm.Allowed) == 0 {
				pm.Allowed = nil
			}
			setPage(m, pageKey(it.Scope, name), pm)
		}
		if list := m.Order[it.Scope]; it.Index >= 0 && len(list) > 0 && !slices.Contains(list, name) {
			at := min(it.Index, len(list))
			m.Order[it.Scope] = slices.Insert(slices.Clone(list), at, name)
		}
		return nil
	})
	if err != nil {
		log.Printf("restoring the details of %s/%s: %v", it.Session, name, err)
	}
	it.Name = name
	return nil
}

func (s *Store) restorePageFiles(it TrashItem, dir, name, to string) error {
	s.ioMu.Lock()
	defer s.ioMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	moved, err := moveIfThere(filepath.Join(dir, "page", it.Name), to)
	if err != nil {
		return err
	}
	if !moved {
		return fmt.Errorf("%w: the page is missing from the trash", ErrNotFound)
	}
	k := stateKey(it.Session, it.Scope, name, "")
	s.dropLocked(k)
	if _, err := moveIfThere(filepath.Join(dir, "state.json"), s.statePath(it.Session, it.Scope, name, "")); err != nil {
		log.Printf("restoring the entries of %s/%s: %v", it.Session, name, err)
	}
	copies, _ := os.ReadDir(filepath.Join(dir, "copies"))
	for _, c := range copies {
		pid, ok := strings.CutSuffix(c.Name(), ".json")
		if !ok || !ValidPlayerID(pid) {
			continue
		}
		s.dropLocked(stateKey(it.Session, Shared, name, pid))
		if _, err := moveIfThere(filepath.Join(dir, "copies", c.Name()), s.statePath(it.Session, Shared, name, pid)); err != nil {
			log.Printf("restoring %s's entries for %s: %v", pid, name, err)
		}
	}
	return nil
}

func (s *Store) restoreCampaign(it *TrashItem, dir string) error {
	from := filepath.Join(dir, "campaign")
	if _, err := os.Stat(from); err != nil {
		return fmt.Errorf("%w: the campaign is missing from the trash", ErrNotFound)
	}
	if err := os.MkdirAll(s.sessionsDir(), 0o755); err != nil {
		return err
	}
	id := it.Session
	for i := 2; ; i++ {
		if _, err := os.Stat(s.dir(id)); errors.Is(err, os.ErrNotExist) {
			break
		}
		id = fmt.Sprintf("%s-%d", it.Session, i)
	}
	if err := os.Rename(from, s.dir(id)); err != nil {
		return err
	}
	it.Session = id
	return nil
}

func (s *Store) restoreEntries(it TrashItem, dir string) error {
	if err := s.campaignThere(it); err != nil {
		return err
	}
	if err := s.checkState(it.Session, it.Scope, it.Name, it.Player); err != nil {
		return fmt.Errorf("%w: the page %q is gone; put it back first", ErrNotFound, it.Name)
	}
	s.ioMu.Lock()
	defer s.ioMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	// Whatever was typed since the clear is replaced by what was cleared.
	s.dropLocked(stateKey(it.Session, it.Scope, it.Name, it.Player))
	moved, err := moveIfThere(filepath.Join(dir, "state.json"), s.statePath(it.Session, it.Scope, it.Name, it.Player))
	if err == nil && !moved {
		err = fmt.Errorf("%w: the entries are missing from the trash", ErrNotFound)
	}
	return err
}

func (s *Store) restorePlayer(it TrashItem, dir string) error {
	if it.Record == nil || it.Record.ID != it.Player {
		return fmt.Errorf("%w: that trash item can't be read", ErrInvalid)
	}
	if err := s.campaignThere(it); err != nil {
		return err
	}
	_, err := s.updateMeta(it.Session, func(m *Session) error {
		if findPlayer(m.Players, it.Player) >= 0 {
			return fmt.Errorf("%w: %s is in the party again already", ErrExists, it.Record.Name)
		}
		if len(m.Players) >= MaxPlayers {
			return fmt.Errorf("%w: a campaign can have at most %d players", ErrInvalid, MaxPlayers)
		}
		m.Players = slices.Insert(m.Players, min(max(it.Index, 0), len(m.Players)), *it.Record)
		for _, k := range it.AllowedOn {
			if pm, ok := m.Pages[k]; ok && pm.Audience == AudienceOnly && !slices.Contains(pm.Allowed, it.Player) {
				pm.Allowed = append(slices.Clone(pm.Allowed), it.Player)
				m.Pages[k] = pm
			}
		}
		return nil
	})
	if err != nil || !it.Copies {
		return err
	}
	s.ioMu.Lock()
	defer s.ioMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	from, to := filepath.Join(dir, "copies"), filepath.Join(s.playersStateDir(it.Session), it.Player)
	files, _ := os.ReadDir(from)
	for _, f := range files {
		// A copy already there is kept.
		if _, err := os.Stat(filepath.Join(to, f.Name())); err == nil {
			continue
		}
		if _, err := moveIfThere(filepath.Join(from, f.Name()), filepath.Join(to, f.Name())); err != nil {
			log.Printf("restoring %s's entries: %v", it.Player, err)
		}
	}
	return nil
}
