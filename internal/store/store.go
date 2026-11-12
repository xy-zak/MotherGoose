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
	"bufio"
	"bytes"
	"encoding/json"
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

// Kind is what sort of page a file is, decided by its extension.
type Kind string

const (
	KindHTML  Kind = "html"  // a page with fields that are saved and synced
	KindPDF   Kind = "pdf"   // shown in the bundled PDF viewer
	KindImage Kind = "image" // a PNG or JPEG
)

// KindOf reports the kind of a file name, and whether it's one MotherGoose takes.
func KindOf(name string) (Kind, bool) {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".html", ".htm":
		return KindHTML, true
	case ".pdf":
		return KindPDF, true
	case ".png", ".jpg", ".jpeg":
		return KindImage, true
	}
	return "", false
}

// MaxSize is the largest file of each kind that can be added.
func MaxSize(k Kind) int64 {
	if k == KindPDF {
		return 100 << 20 // rulebooks and scanned maps get big
	}
	return 32 << 20
}

// ContentType is the media type a file is served with.
func ContentType(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".pdf":
		return "application/pdf"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	}
	return "text/html; charset=utf-8"
}

// checkContent makes sure a PDF or image really is one, so a file can't
// pretend to be an image to get served under a different type.
func checkContent(name string, k Kind, head []byte) error {
	ok := true
	what := "PDF"
	switch {
	case k == KindPDF:
		ok = bytes.Contains(head, []byte("%PDF-")) // may follow up to 1 KiB of junk
	case strings.EqualFold(filepath.Ext(name), ".png"):
		what, ok = "PNG", bytes.HasPrefix(head, []byte("\x89PNG\r\n\x1a\n"))
	case k == KindImage:
		what, ok = "JPEG", bytes.HasPrefix(head, []byte{0xFF, 0xD8, 0xFF})
	}
	if !ok {
		return fmt.Errorf("%w: %q isn't a valid %s", ErrInvalid, name, what)
	}
	return nil
}

const (
	MaxKeyLen    = 512
	MaxValueSize = 1 << 20 // 1 MiB per field value
	saveDelay    = 500 * time.Millisecond
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
}

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

// State is the saved field values of one file: field key -> JSON value.
type State map[string]json.RawMessage

type fileState struct {
	values  State
	timer   *time.Timer
	path    string // where it is saved
	session string
}

// Store is safe for concurrent use.
type Store struct {
	root   string
	metaMu sync.Mutex // serialises session.json read-modify-writes
	mu     sync.Mutex
	cfg    config
	states map[string]*fileState // key: id/scope/name
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

// quarantine moves aside a file that exists but can't be parsed, so the
// fresh copy written in its place never destroys what was in it. Every file
// MotherGoose reads follows this rule; a file that can't be read at all
// (permissions, disk errors) is an error instead and is left alone.
func quarantine(p string, cause error) error {
	stamp := time.Now().Format("20060102-150405")
	bak := p + ".corrupt-" + stamp
	for i := 2; ; i++ {
		if _, err := os.Lstat(bak); errors.Is(err, os.ErrNotExist) {
			break
		}
		bak = fmt.Sprintf("%s.corrupt-%s-%d", p, stamp, i)
	}
	if err := os.Rename(p, bak); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil // another request already moved it aside
		}
		return fmt.Errorf("%s can't be read (%v) and couldn't be moved aside: %w", p, cause, err)
	}
	log.Printf("%s could not be read (%v); kept it as %s and started fresh", p, cause, filepath.Base(bak))
	return nil
}

// Root is the absolute data directory.
func (s *Store) Root() string { return s.root }

func (s *Store) configPath() string   { return filepath.Join(s.root, "config.json") }
func (s *Store) sessionsDir() string  { return filepath.Join(s.root, "sessions") }
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

// ---- names ----------------------------------------------------------------

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

// ---- sessions --------------------------------------------------------------

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
				}
			}
		}
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
	base := slugify(name)
	id := base
	for i := 2; ; i++ {
		if _, err := os.Stat(s.dir(id)); errors.Is(err, os.ErrNotExist) {
			break
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

// ---- files -----------------------------------------------------------------

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

// HasState reports whether a kind of page can have saved entries: HTML pages
// (their form fields) and PDFs (their AcroForm fields). Images can't.
func HasState(k Kind) bool { return k == KindHTML || k == KindPDF }

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
			continue
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
		_ = os.MkdirAll(filepath.Dir(tp), 0o755)
		_ = os.Rename(sp, tp)
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

func kindOrEmpty(name string) Kind {
	k, _ := KindOf(name)
	return k
}

// ---- state -----------------------------------------------------------------

// checkState validates the target of a state operation. player "" is the
// page's own entries (the template, for a per-player page); otherwise it is
// that player's copy, which only players' pages have.
func (s *Store) checkState(id string, sc Scope, name, player string) error {
	if _, err := s.statefulPath(id, sc, name); err != nil {
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
		st.timer = time.AfterFunc(saveDelay, func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.flushLocked(k)
		})
	}
	return nil
}

// flushLocked writes a pending state file now.
func (s *Store) flushLocked(k string) {
	st, ok := s.states[k]
	if !ok || st.timer == nil {
		return
	}
	st.timer.Stop()
	st.timer = nil
	if _, err := os.Stat(s.dir(st.session)); err != nil {
		return // session deleted meanwhile
	}
	b, _ := json.MarshalIndent(st.values, "", "  ")
	if err := os.MkdirAll(filepath.Dir(st.path), 0o755); err == nil {
		if err := writeAtomic(st.path, b); err != nil {
			log.Printf("saving %s: %v", st.path, err)
		}
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
	s.mu.Lock()
	defer s.mu.Unlock()
	for k := range s.states {
		s.flushLocked(k)
	}
}

// fileMode is used for every file MotherGoose writes. The data folder is
// meant to be browsed and edited by hand, so files are readable like ones the
// user saved themselves (os.CreateTemp alone would leave them owner-only).
const fileMode = 0o644

// writeAtomic replaces p with b through a temp file in the same folder. The
// temp file is flushed to disk before it is renamed over p, and the rename is
// flushed after, so after a crash or power cut p holds either the old contents
// or the new ones, never a mix or an empty file.
func writeAtomic(p string, b []byte) error { return writeAtomicFrom(p, bytes.NewReader(b)) }

// writeAtomicFrom is writeAtomic for a stream. If reading r fails, p is left
// untouched.
func writeAtomicFrom(p string, r io.Reader) error {
	dir := filepath.Dir(p)
	f, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	fail := func(err error) error {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if _, err := io.Copy(f, r); err != nil {
		return fail(err)
	}
	if err := f.Chmod(fileMode); err != nil {
		return fail(err)
	}
	if err := f.Sync(); err != nil {
		return fail(err)
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, p); err != nil {
		os.Remove(tmp)
		return err
	}
	syncDir(dir)
	return nil
}

// syncDir makes a rename in dir durable. Windows can't sync a folder handle
// (NTFS journals the rename itself), so errors here are deliberately ignored.
func syncDir(dir string) {
	d, err := os.Open(dir)
	if err != nil {
		return
	}
	_ = d.Sync()
	d.Close()
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
