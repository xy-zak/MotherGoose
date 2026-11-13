// Pages: listing, saving, opening, moving and deleting the files of a session.
package store

import (
	"bufio"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// FileInfo describes one page (HTML, PDF or image) in a session.
type FileInfo struct {
	Name     string    `json:"name"`
	Title    string    `json:"title"`
	Kind     Kind      `json:"kind"`
	Scope    Scope     `json:"scope"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
	HasState bool      `json:"hasState"`

	Description string   `json:"description"`
	Tags        []string `json:"tags"`
	// PerPlayer: every rostered player gets their own copy of the entries.
	PerPlayer bool `json:"perPlayer"`
	// PlayerState says, for a per-player page, which rostered players have
	// entries of their own (player id -> true).
	PlayerState map[string]bool `json:"playerState,omitempty"`
}

// validName accepts names that are safe as a single path element on every OS.
func validName(n string) bool {
	if n == "" || len(n) > 200 || n == "." || n == ".." || strings.HasPrefix(n, ".") {
		return false
	}
	if strings.ContainsAny(n, `/\<>:"|?*`) || strings.ContainsRune(n, 0) {
		return false
	}
	if strings.TrimSpace(n) != n || strings.HasSuffix(n, ".") {
		return false
	}
	return filepath.Base(n) == n
}

func isPage(name string) bool {
	_, ok := KindOf(name)
	return ok
}

var unsafeChars = regexp.MustCompile(`[/\\<>:"|?*\x00-\x1f]+`)

// CleanFileName turns an uploaded file name into a safe one, or errors.
func CleanFileName(n string) (string, error) {
	n = strings.ReplaceAll(n, "\\", "/")
	n = n[strings.LastIndex(n, "/")+1:]
	n = unsafeChars.ReplaceAllString(n, "-")
	n = strings.TrimLeft(strings.TrimSpace(n), ".")
	if !isPage(n) {
		return "", fmt.Errorf("%w: only .html, .pdf, .png and .jpg files can be added (got %q)", ErrInvalid, n)
	}
	if !validName(n) {
		return "", fmt.Errorf("%w: bad file name %q", ErrInvalid, n)
	}
	return n, nil
}

func (s *Store) filePath(id string, sc Scope, name string) (string, error) {
	if err := s.checkSession(id); err != nil {
		return "", err
	}
	if _, err := ParseScope(string(sc)); err != nil {
		return "", err
	}
	if !validName(name) || !isPage(name) {
		return "", fmt.Errorf("%w: bad file name", ErrInvalid)
	}
	return filepath.Join(s.dir(id), string(sc), name), nil
}

var titleRe = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)

func readTitle(p string) string {
	f, err := os.Open(p)
	if err != nil {
		return ""
	}
	defer f.Close()
	buf := make([]byte, 16<<10)
	n, _ := io.ReadFull(f, buf)
	m := titleRe.FindSubmatch(buf[:n])
	if m == nil {
		return ""
	}
	t := strings.Join(strings.Fields(html.UnescapeString(string(m[1]))), " ")
	if len(t) > 80 {
		t = t[:80]
	}
	return t
}

// ListFiles lists the HTML files in one scope of a session, by name.
func (s *Store) ListFiles(id string, sc Scope) ([]FileInfo, error) {
	if err := s.checkSession(id); err != nil {
		return nil, err
	}
	d := filepath.Join(s.dir(id), string(sc))
	entries, err := os.ReadDir(d)
	if errors.Is(err, os.ErrNotExist) {
		return []FileInfo{}, nil
	} else if err != nil {
		return nil, err
	}
	out := []FileInfo{}
	for _, e := range entries {
		if e.IsDir() || !validName(e.Name()) || !isPage(e.Name()) {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			continue // removed since ReadDir
		}
		kind, _ := KindOf(e.Name())
		info := FileInfo{Name: e.Name(), Kind: kind, Scope: sc, Size: fi.Size(), Modified: fi.ModTime(), Tags: []string{}}
		if kind == KindHTML {
			info.Title = readTitle(filepath.Join(d, e.Name()))
		} else {
			info.Title = strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))
		}
		if st, err := os.Stat(s.statePath(id, sc, e.Name(), "")); HasState(kind) && err == nil {
			info.HasState = st.Size() > 2
			if st.ModTime().After(info.Modified) {
				info.Modified = st.ModTime()
			}
		}
		out = append(out, info)
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out, nil
}

// Fingerprint summarises every session's file listing so pollers can detect
// files that were added or removed by hand.
func (s *Store) Fingerprint() string {
	var b strings.Builder
	b.WriteString("active=" + s.Active() + "\n")
	entries, _ := os.ReadDir(s.sessionsDir())
	for _, e := range entries {
		if !e.IsDir() || !validName(e.Name()) {
			continue
		}
		b.WriteString(e.Name() + ":")
		// session.json: names, game types and page details edited by hand.
		if fi, err := os.Stat(filepath.Join(s.dir(e.Name()), "session.json")); err == nil {
			fmt.Fprintf(&b, "meta@%d,", fi.ModTime().UnixNano())
		}
		for _, sc := range Scopes {
			files, _ := os.ReadDir(filepath.Join(s.dir(e.Name()), string(sc)))
			for _, f := range files {
				if !f.IsDir() && isPage(f.Name()) {
					fi, err := f.Info()
					if err == nil {
						fmt.Fprintf(&b, "%s/%s@%d,", sc, f.Name(), fi.ModTime().UnixNano())
					}
				}
			}
		}
		b.WriteString("\n")
	}
	return b.String()
}

// ReadFile returns the raw HTML of a file.
func (s *Store) ReadFile(id string, sc Scope, name string) ([]byte, error) {
	p, err := s.filePath(id, sc, name)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("file %q: %w", name, ErrNotFound)
	}
	return b, err
}

// SaveFile writes an uploaded file. An existing file with the same name is
// replaced but its saved state is kept. Returns the cleaned name.
func (s *Store) SaveFile(id string, sc Scope, name string, r io.Reader) (string, error) {
	name, err := CleanFileName(name)
	if err != nil {
		return "", err
	}
	p, err := s.filePath(id, sc, name)
	if err != nil {
		return "", err
	}
	other := GM
	if sc == GM {
		other = Shared
	}
	if op, _ := s.filePath(id, other, name); op != "" {
		if _, err := os.Stat(op); err == nil {
			return "", fmt.Errorf("%q %w in the %s pages", name, ErrExists, other.Label())
		}
	}
	kind, _ := KindOf(name)
	br := bufio.NewReaderSize(r, 1024)
	head, err := br.Peek(1024)
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	if err := checkContent(name, kind, head); err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return "", err
	}
	tooBig := fmt.Errorf("%w: %q is larger than %d MiB", ErrInvalid, name, MaxSize(kind)>>20)
	return name, writeAtomicFrom(p, &capReader{r: br, left: MaxSize(kind), err: tooBig})
}

// capReader fails with err once more than left bytes would be read, so an
// oversized upload is refused without being held in memory.
type capReader struct {
	r    io.Reader
	left int64
	err  error
}

func (c *capReader) Read(p []byte) (int, error) {
	if c.left <= 0 {
		var one [1]byte // probe: is there anything past the limit?
		n, err := c.r.Read(one[:])
		if n > 0 {
			return 0, c.err
		}
		return 0, err
	}
	if int64(len(p)) > c.left {
		p = p[:c.left]
	}
	n, err := c.r.Read(p)
	c.left -= int64(n)
	return n, err
}

// OpenFile opens a page for serving as-is (PDFs and images).
func (s *Store) OpenFile(id string, sc Scope, name string) (*os.File, os.FileInfo, error) {
	p, err := s.filePath(id, sc, name)
	if err != nil {
		return nil, nil, err
	}
	f, err := os.Open(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil, fmt.Errorf("file %q: %w", name, ErrNotFound)
	} else if err != nil {
		return nil, nil, err
	}
	fi, err := f.Stat()
	if err != nil || fi.IsDir() {
		f.Close()
		return nil, nil, fmt.Errorf("file %q: %w", name, ErrNotFound)
	}
	return f, fi, nil
}

// DeleteFile removes a file, its saved state and every player's copy of it.
func (s *Store) DeleteFile(id string, sc Scope, name string) error {
	p, err := s.filePath(id, sc, name)
	if err != nil {
		return err
	}
	if err := os.Remove(p); errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("file %q: %w", name, ErrNotFound)
	} else if err != nil {
		return err
	}
	s.movePageMeta(id, sc, name, "", "")
	s.dropCopies(id, name)
	return s.resetState(id, sc, name, "")
}

// MoveFile moves and/or renames a file, carrying its state and every
// player's copy of it along.
func (s *Store) MoveFile(id string, sc Scope, name string, toScope Scope, toName string) error {
	from, err := s.filePath(id, sc, name)
	if err != nil {
		return err
	}
	if toName == "" {
		toName = name
	}
	if toName != name {
		if toName, err = CleanFileName(toName); err != nil {
			return err
		}
		if a, b := kindOrEmpty(name), kindOrEmpty(toName); a != b {
			return fmt.Errorf("%w: can't rename a %s to a %s", ErrInvalid, a, b)
		}
	}
	to, err := s.filePath(id, toScope, toName)
	if err != nil {
		return err
	}
	if from == to {
		return nil
	}
	if _, err := os.Stat(from); err != nil {
		return fmt.Errorf("file %q: %w", name, ErrNotFound)
	}
	for _, sc2 := range Scopes {
		if p, _ := s.filePath(id, sc2, toName); p != from {
			if _, err := os.Stat(p); err == nil {
				return fmt.Errorf("%q %w in the %s pages", toName, ErrExists, sc2.Label())
			}
		}
	}
	if err := s.moveFileLocked(id, sc, name, toScope, toName, from, to); err != nil {
		return err
	}
	s.movePageMeta(id, sc, name, toScope, toName)
	return nil
}

func (s *Store) moveFileLocked(id string, sc Scope, name string, toScope Scope, toName, from, to string) error {
	s.ioMu.Lock()
	defer s.ioMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.flushLocked(stateKey(id, sc, name, ""))
	// Pending copies are written first so the renames below see them all.
	// Copies aren't kept per scope, so a move alone leaves them where they are.
	for _, pid := range s.copyOwnersLocked(id, name) {
		s.flushLocked(stateKey(id, Shared, name, pid))
		delete(s.states, stateKey(id, Shared, name, pid))
	}
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return err
	}
	if err := os.Rename(from, to); err != nil {
		return err
	}
	sp, tp := s.statePath(id, sc, name, ""), s.statePath(id, toScope, toName, "")
	if _, err := os.Stat(sp); err == nil {
		err := os.MkdirAll(filepath.Dir(tp), 0o755)
		if err == nil {
			err = os.Rename(sp, tp)
		}
		if err != nil {
			// The page has moved already: say so rather than fail, and
			// leave the entries where they are to be moved by hand.
			log.Printf("moving the entries of %s to %s: %v", sp, tp, err)
		}
	}
	delete(s.states, stateKey(id, sc, name, ""))
	if toName != name {
		for _, pid := range s.copyOwnersLocked(id, name) {
			sp, tp := s.statePath(id, Shared, name, pid), s.statePath(id, Shared, toName, pid)
			if err := os.Rename(sp, tp); err != nil && !errors.Is(err, os.ErrNotExist) {
				log.Printf("renaming %s's entries for %s: %v", pid, name, err)
			}
		}
	}
	return nil
}

// Exists reports whether a file is present.
func (s *Store) Exists(id string, sc Scope, name string) bool {
	p, err := s.filePath(id, sc, name)
	if err != nil {
		return false
	}
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir()
}
