// Entries: what people typed into a page, cached in memory and saved shortly
// after each change, for a page and for each player's copy of it.
package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	MaxKeyLen    = 512
	MaxValueSize = 1 << 20 // 1 MiB per field value
	saveDelay    = 500 * time.Millisecond
)

// State is the saved field values of one file: field key -> JSON value.
type State map[string]json.RawMessage

type fileState struct {
	values  State
	timer   *time.Timer
	path    string // where it is saved
	session string
}

// OnEntriesSaved registers fn to run each time saved entries are written to
// disk. It may run with the store locked, so it must return at once and must
// not call back into the store.
func (s *Store) OnEntriesSaved(fn func()) {
	s.mu.Lock()
	s.onSaved = fn
	s.mu.Unlock()
}

// statefulPath is filePath for the operations that only make sense on pages
// with entries: saving, syncing and resetting them.
func (s *Store) statefulPath(id string, sc Scope, name string) (string, error) {
	p, err := s.filePath(id, sc, name)
	if err != nil {
		return "", err
	}
	if k, _ := KindOf(name); !HasState(k) {
		return "", fmt.Errorf("%w: %q is an %s, which has no saved entries", ErrInvalid, name, k)
	}
	return p, nil
}

// statePath is where a file's entries are saved. Players' copies have no
// scope folder: file names are unique across scopes, and a copy stays put
// when its page moves between them.
func (s *Store) statePath(id string, sc Scope, name, player string) string {
	if player != "" {
		return filepath.Join(s.playersStateDir(id), player, name+".json")
	}
	return filepath.Join(s.dir(id), "state", string(sc), name+".json")
}

func (s *Store) playersStateDir(id string) string {
	return filepath.Join(s.dir(id), "state", "players")
}

// stateKey names a file's entries in the cache, mirroring statePath under
// the session id so that prefixes select a session or one player.
func stateKey(id string, sc Scope, name, player string) string {
	if player != "" {
		return id + "/players/" + player + "/" + name
	}
	return id + "/" + string(sc) + "/" + name
}

// checkState validates the target of a state operation. player "" is the
// page's own entries (the template, for a per-player page); otherwise it is
// that player's copy, which only players' pages have. Only a page that exists
// has entries: ones kept for a deleted page would turn up again in the next
// page uploaded with its name.
func (s *Store) checkState(id string, sc Scope, name, player string) error {
	p, err := s.statefulPath(id, sc, name)
	if err != nil {
		return err
	}
	if player != "" {
		if !ValidPlayerID(player) {
			return fmt.Errorf("%w: bad player id", ErrInvalid)
		}
		if sc != Shared {
			return fmt.Errorf("%w: only players' pages have a copy per player", ErrInvalid)
		}
	}
	if _, err := os.Stat(p); err != nil {
		return fmt.Errorf("file %q: %w", name, ErrNotFound)
	}
	return nil
}

// loadLocked returns the cached state for a file, reading it from disk once.
// A state file that can't be parsed is moved aside before starting empty; one
// that can't be read at all is an error, so it is never overwritten.
//
// A player's copy that has no file yet reads as the template's entries, which
// are its starting values. With seed it becomes a cached copy of them that the
// caller is about to change; without, the template itself is returned, so a
// copy nobody has written to keeps following the template.
func (s *Store) loadLocked(id string, sc Scope, name, player string, seed bool) (*fileState, error) {
	k := stateKey(id, sc, name, player)
	if st, ok := s.states[k]; ok {
		return st, nil
	}
	p := s.statePath(id, sc, name, player)
	st := &fileState{values: State{}, path: p, session: id}
	missing := false
	b, err := os.ReadFile(p)
	switch {
	case err == nil:
		if jerr := json.Unmarshal(b, &st.values); jerr != nil {
			if err := quarantine(p, jerr); err != nil {
				return nil, err
			}
			st.values, missing = State{}, true
		} else if st.values == nil {
			st.values = State{} // the file held null
		}
	case errors.Is(err, os.ErrNotExist):
		missing = true
	default:
		return nil, fmt.Errorf("reading saved entries: %w", err)
	}
	if missing && player != "" {
		tpl, err := s.loadLocked(id, sc, name, "", true)
		if err != nil {
			return nil, err
		}
		if !seed {
			return tpl, nil
		}
		for k, v := range tpl.values {
			st.values[k] = v
		}
	}
	s.states[k] = st
	return st, nil
}

// GetState returns a copy of the saved values of a file, or of one player's
// copy of it (player "" is the file's own).
func (s *Store) GetState(id string, sc Scope, name, player string) (State, error) {
	if err := s.checkState(id, sc, name, player); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.loadLocked(id, sc, name, player, false)
	if err != nil {
		return nil, err
	}
	out := make(State, len(st.values))
	for k, v := range st.values {
		out[k] = v
	}
	return out, nil
}

// SetValue stores one field value; the file is written shortly afterwards.
func (s *Store) SetValue(id string, sc Scope, name, player, key string, value json.RawMessage) error {
	if err := s.checkState(id, sc, name, player); err != nil {
		return err
	}
	if key == "" || len(key) > MaxKeyLen {
		return fmt.Errorf("%w: bad key", ErrInvalid)
	}
	if len(value) > MaxValueSize || !json.Valid(value) {
		return fmt.Errorf("%w: bad value for %q", ErrInvalid, key)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.loadLocked(id, sc, name, player, true)
	if err != nil {
		return err
	}
	if bytes.Equal(value, []byte("null")) {
		delete(st.values, key)
	} else {
		st.values[key] = append(json.RawMessage(nil), value...)
	}
	k := stateKey(id, sc, name, player)
	if st.timer == nil {
		st.timer = time.AfterFunc(saveDelay, func() { s.savePending(k) })
	}
	return nil
}

// pendingSave is one state file about to be written.
type pendingSave struct {
	session, path string
	data          []byte
	onSaved       func()
}

// takePendingLocked takes a file's unsaved entries, marking them saved. ok
// is false when there is nothing to save.
func (s *Store) takePendingLocked(k string) (p pendingSave, ok bool) {
	st, ok := s.states[k]
	if !ok || st.timer == nil {
		return p, false
	}
	st.timer.Stop()
	st.timer = nil
	b, _ := json.MarshalIndent(st.values, "", "  ")
	return pendingSave{session: st.session, path: st.path, data: b, onSaved: s.onSaved}, true
}

// write saves p to disk. The caller holds ioMu.
func (s *Store) write(p pendingSave) bool {
	if _, err := os.Stat(s.dir(p.session)); err != nil {
		return false // session deleted meanwhile
	}
	err := os.MkdirAll(filepath.Dir(p.path), 0o755)
	if err == nil {
		err = writeStateFile(p.path, p.data)
	}
	if err != nil {
		log.Printf("saving %s: %v", p.path, err)
		return false
	}
	return true
}

// writeStateFile writes one state file; tests replace it to make saving slow.
var writeStateFile = writeAtomic

// savePending is the save timer: it writes a file's entries without holding
// mu, so edits and page loads carry on while the disk works.
func (s *Store) savePending(k string) {
	s.ioMu.Lock()
	defer s.ioMu.Unlock()
	s.mu.Lock()
	p, ok := s.takePendingLocked(k)
	s.mu.Unlock()
	if ok && s.write(p) && p.onSaved != nil {
		p.onSaved()
	}
}

// flushLocked writes a pending state file now. The caller holds ioMu and mu.
func (s *Store) flushLocked(k string) {
	if p, ok := s.takePendingLocked(k); ok && s.write(p) && p.onSaved != nil {
		p.onSaved()
	}
}

// ResetState clears all saved values for a file, or for one player's copy
// of it. A reset copy starts again from the template's entries.
func (s *Store) ResetState(id string, sc Scope, name, player string) error {
	if err := s.checkState(id, sc, name, player); err != nil {
		return err
	}
	return s.resetState(id, sc, name, player)
}

// resetState drops any saved entries for a file, whatever its kind.
func (s *Store) resetState(id string, sc Scope, name, player string) error {
	s.ioMu.Lock()
	defer s.ioMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dropLocked(stateKey(id, sc, name, player))
	if err := os.Remove(s.statePath(id, sc, name, player)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// dropLocked forgets a cached state without writing it.
func (s *Store) dropLocked(k string) {
	if st, ok := s.states[k]; ok && st.timer != nil {
		st.timer.Stop()
	}
	delete(s.states, k)
}

// dropCopies removes every player's copy of a deleted file, including those
// of players who were taken off the roster with their entries kept: a new
// file with the same name must not inherit them.
func (s *Store) dropCopies(id, name string) {
	s.ioMu.Lock()
	defer s.ioMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, pid := range s.copyOwnersLocked(id, name) {
		s.dropLocked(stateKey(id, Shared, name, pid))
		if err := os.Remove(s.statePath(id, Shared, name, pid)); err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Printf("removing %s's entries for %s: %v", pid, name, err)
		}
	}
}

// copyOwnersLocked lists the players who may have a copy of a file: those
// with a folder under state/players/, and those with one waiting to be saved.
func (s *Store) copyOwnersLocked(id, name string) []string {
	seen := map[string]bool{}
	out := []string{}
	add := func(pid string) {
		if ValidPlayerID(pid) && !seen[pid] {
			seen[pid] = true
			out = append(out, pid)
		}
	}
	entries, _ := os.ReadDir(s.playersStateDir(id))
	for _, e := range entries {
		if e.IsDir() {
			add(e.Name())
		}
	}
	prefix := id + "/players/"
	for k := range s.states {
		if rest, ok := strings.CutPrefix(k, prefix); ok {
			if pid, file, ok := strings.Cut(rest, "/"); ok && file == name {
				add(pid)
			}
		}
	}
	return out
}

// Flush writes every pending state file; call it before exiting.
func (s *Store) Flush() {
	s.ioMu.Lock()
	defer s.ioMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	for k := range s.states {
		s.flushLocked(k)
	}
}
