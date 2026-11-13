// Package store keeps MotherGoose sessions on disk in a layout that is meant
// to be browsed and edited by hand:
//
//	<root>/config.json
//	<root>/sessions/<id>/session.json
//	<root>/sessions/<id>/shared/*.html   (visible to players)
//	<root>/sessions/<id>/gm/*.html       (host machine only)
//	<root>/sessions/<id>/state/<scope>/<file>.json
//	<root>/sessions/<id>/state/players/<player>/<file>.json  (per-player copies)
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Scope says who may see a file.
type Scope string

const (
	Shared Scope = "shared"
	GM     Scope = "gm"
)

// Scopes lists every scope in display order.
var Scopes = []Scope{Shared, GM}

// ParseScope validates a scope string.
func ParseScope(s string) (Scope, error) {
	switch Scope(s) {
	case Shared, GM:
		return Scope(s), nil
	}
	return "", fmt.Errorf("%w: unknown scope %q", ErrInvalid, s)
}

var (
	ErrNotFound = errors.New("not found")
	ErrInvalid  = errors.New("invalid")
	ErrExists   = errors.New("already exists")
)

const (
	KindHTML  Kind = "html"  // a page with fields that are saved and synced
	KindPDF   Kind = "pdf"   // shown in the bundled PDF viewer
	KindImage Kind = "image" // a PNG or JPEG
)

// Session is the metadata stored in session.json.
type Session struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	GameType string    `json:"gameType"` // the game or rules, e.g. "Mörk Borg", "D&D 5e"
	Created  time.Time `json:"created"`
	// Players is the roster: who can have their own copy of a per-player page.
	Players []Player `json:"players"`
	// Pages holds descriptions, tags and the per-player switch, keyed
	// "shared/intro.html".
	Pages map[string]PageMeta `json:"pages,omitempty"`
	// Order is the order the referee dragged each scope's pages into. Pages
	// not listed (added later, or by hand) follow the listed ones, by name.
	Order map[Scope][]string `json:"order,omitempty"`
}

// Summary is a session plus derived information.
type Summary struct {
	Session
	Active     bool                 `json:"active"`
	LastEdited time.Time            `json:"lastEdited"`
	Dir        string               `json:"dir"`
	Files      map[Scope][]FileInfo `json:"files"`
}

type config struct {
	ActiveSession string `json:"activeSession"`
}

// Store is safe for concurrent use.
//
// Lock order: ioMu, then mu. metaMu is never held together with either.
type Store struct {
	root   string
	metaMu sync.Mutex // serialises session.json read-modify-writes
	// ioMu orders every write, move and removal of state files. Saves run
	// with it but without mu, so typing never waits on the disk, and a save
	// can still never land after a reset, move or delete of the same file.
	ioMu   sync.Mutex
	mu     sync.Mutex // the fields below
	cfg    config
	states map[string]*fileState // key: id/scope/name
	// onSaved runs after entries are written to disk (see OnEntriesSaved).
	onSaved func()
}

// Open prepares root (creating it if needed) and loads config.json.
func Open(root string) (*Store, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(abs, "sessions"), 0o755); err != nil {
		return nil, err
	}
	s := &Store{root: abs, states: map[string]*fileState{}}
	b, err := os.ReadFile(s.configPath())
	switch {
	case err == nil:
		if jerr := json.Unmarshal(b, &s.cfg); jerr == nil {
			return s, nil
		} else if err := quarantine(s.configPath(), jerr); err != nil {
			return nil, err
		}
		s.cfg = config{}
	case errors.Is(err, os.ErrNotExist):
	default:
		return nil, err
	}
	if err := s.saveConfig(); err != nil {
		return nil, err
	}
	return s, nil
}

// Root is the absolute data directory.
func (s *Store) Root() string { return s.root }

func (s *Store) configPath() string { return filepath.Join(s.root, "config.json") }

func (s *Store) sessionsDir() string { return filepath.Join(s.root, "sessions") }

func (s *Store) dir(id string) string { return filepath.Join(s.sessionsDir(), id) }

// SessionDir returns the folder of a session.
func (s *Store) SessionDir(id string) (string, error) {
	if err := s.checkSession(id); err != nil {
		return "", err
	}
	return s.dir(id), nil
}

func (s *Store) saveConfig() error {
	b, _ := json.MarshalIndent(s.cfg, "", "  ")
	return writeAtomic(s.configPath(), b)
}

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(name string) string {
	s := strings.Trim(slugRe.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if len(s) > 60 {
		s = strings.Trim(s[:60], "-")
	}
	if s == "" {
		s = "session"
	}
	return s
}

func (s *Store) checkSession(id string) error {
	if !validName(id) {
		return fmt.Errorf("%w: bad session id", ErrInvalid)
	}
	fi, err := os.Stat(s.dir(id))
	if err != nil || !fi.IsDir() {
		return fmt.Errorf("session %q: %w", id, ErrNotFound)
	}
	return nil
}

// loadMeta reads session.json, creating it (and the scope folders) for
// folders that were dropped in by hand.
func (s *Store) loadMeta(id string) (Session, error) {
	s.metaMu.Lock()
	defer s.metaMu.Unlock()
	return s.loadMetaLocked(id)
}

func (s *Store) loadMetaLocked(id string) (Session, error) {
	if err := s.checkSession(id); err != nil {
		return Session{}, err
	}
	p := filepath.Join(s.dir(id), "session.json")
	var meta Session
	b, err := os.ReadFile(p)
	switch {
	case err == nil:
		if jerr := json.Unmarshal(b, &meta); jerr != nil {
			if err := quarantine(p, jerr); err != nil {
				return Session{}, err
			}
			meta = Session{}
		} else if meta.Name != "" {
			meta.ID = id
			meta.Players = cleanRoster(meta.Players)
			return meta, nil
		}
	case errors.Is(err, os.ErrNotExist):
	default:
		return Session{}, err
	}
	// A folder dropped in by hand, or a session.json that had to be set aside:
	// fill in what's missing and write it back.
	meta.ID, meta.Name = id, id
	meta.Players = cleanRoster(meta.Players)
	if meta.Created.IsZero() {
		meta.Created = time.Now()
		if fi, err := os.Stat(s.dir(id)); err == nil {
			meta.Created = fi.ModTime()
		}
	}
	for _, sc := range Scopes {
		_ = os.MkdirAll(filepath.Join(s.dir(id), string(sc)), 0o755)
	}
	return meta, s.writeMeta(meta)
}

func (s *Store) writeMeta(m Session) error {
	if m.Players == nil {
		m.Players = []Player{} // "players": [] reads better by hand than null
	}
	b, _ := json.MarshalIndent(m, "", "  ")
	return writeAtomic(filepath.Join(s.dir(m.ID), "session.json"), b)
}

// ListSessions returns every session, newest edit first.
func (s *Store) ListSessions() ([]Summary, error) {
	entries, err := os.ReadDir(s.sessionsDir())
	if err != nil {
		return nil, err
	}
	out := []Summary{}
	for _, e := range entries {
		if !e.IsDir() || !validName(e.Name()) {
			continue
		}
		sum, err := s.GetSession(e.Name())
		if err != nil {
			// Listed on every dashboard refresh: say it once, not each time.
			logOnce("session "+e.Name()+": "+err.Error(), "leaving out session %q: %v", e.Name(), err)
			continue
		}
		out = append(out, sum)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastEdited.After(out[j].LastEdited) })
	return out, nil
}

// GetSession returns one session with its files.
func (s *Store) GetSession(id string) (Summary, error) {
	meta, err := s.loadMeta(id)
	if err != nil {
		return Summary{}, err
	}
	sum := Summary{Session: meta, Dir: s.dir(id), Files: map[Scope][]FileInfo{}, LastEdited: meta.Created}
	sum.Active = s.Active() == id
	for _, sc := range Scopes {
		files, err := s.ListFiles(id, sc)
		if err != nil {
			return Summary{}, err
		}
		for i := range files {
			pm := meta.Pages[pageKey(sc, files[i].Name)]
			files[i].Description = pm.Description
			if pm.Tags != nil {
				files[i].Tags = pm.Tags
			}
			if files[i].PerPlayer = pm.PerPlayer && CanBePerPlayer(sc, files[i].Kind); files[i].PerPlayer {
				files[i].PlayerState = map[string]bool{}
				for _, pl := range meta.Players {
					st, err := os.Stat(s.statePath(id, sc, files[i].Name, pl.ID))
					files[i].PlayerState[pl.ID] = err == nil && st.Size() > 2
					// A player's entries are an edit to the page too.
					if err == nil && st.ModTime().After(files[i].Modified) {
						files[i].Modified = st.ModTime()
					}
				}
			}
		}
		sortByOrder(files, meta.Order[sc])
		sum.Files[sc] = files
		for _, f := range files {
			if f.Modified.After(sum.LastEdited) {
				sum.LastEdited = f.Modified
			}
		}
	}
	return sum, nil
}

// CreateSession makes a new session folder with a unique id derived from
// name. gameType may be empty.
func (s *Store) CreateSession(name, gameType string) (Session, error) {
	name, err := cleanName(name)
	if err != nil {
		return Session{}, err
	}
	if gameType, err = cleanText(gameType, MaxGameTypeLen, "the game type", false); err != nil {
		return Session{}, err
	}
	if err := os.MkdirAll(s.sessionsDir(), 0o755); err != nil {
		return Session{}, err
	}
	// Claim the folder itself: Mkdir fails if it exists, so two sessions
	// created with the same name at once can't end up sharing one.
	base := slugify(name)
	id := base
	for i := 2; ; i++ {
		err := os.Mkdir(s.dir(id), 0o755)
		if err == nil {
			break
		}
		if !errors.Is(err, fs.ErrExist) {
			return Session{}, err
		}
		id = fmt.Sprintf("%s-%d", base, i)
	}
	for _, sub := range []string{"shared", "gm", "state"} {
		if err := os.MkdirAll(filepath.Join(s.dir(id), sub), 0o755); err != nil {
			return Session{}, err
		}
	}
	meta := Session{ID: id, Name: name, GameType: gameType, Created: time.Now().UTC()}
	return meta, s.writeMeta(meta)
}

// DeleteSession removes the folder and everything in it.
func (s *Store) DeleteSession(id string) error {
	if err := s.checkSession(id); err != nil {
		return err
	}
	s.ioMu.Lock()
	defer s.ioMu.Unlock()
	s.mu.Lock()
	for k, st := range s.states {
		if strings.HasPrefix(k, id+"/") {
			if st.timer != nil {
				st.timer.Stop()
			}
			delete(s.states, k)
		}
	}
	if s.cfg.ActiveSession == id {
		s.cfg.ActiveSession = ""
		_ = s.saveConfig()
	}
	s.mu.Unlock()
	return os.RemoveAll(s.dir(id))
}

// Active returns the active session id, or "" when none is active.
func (s *Store) Active() string {
	s.mu.Lock()
	id := s.cfg.ActiveSession
	s.mu.Unlock()
	if id == "" || s.checkSession(id) != nil {
		return ""
	}
	return id
}

// SetActive makes id the live session; "" deactivates.
func (s *Store) SetActive(id string) error {
	if id != "" {
		if err := s.checkSession(id); err != nil {
			return err
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cfg.ActiveSession = id
	return s.saveConfig()
}
