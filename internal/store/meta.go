package store

import (
	"fmt"
	"log"
	"os"
	"strings"
	"unicode"
	"unicode/utf8"
)

// PageMeta is what the referee wrote about a page. It is shown to whoever can
// see the page, so a players' page's description is visible to players.
type PageMeta struct {
	Description string   `json:"description,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	// PerPlayer gives every rostered player their own copy of the page's
	// entries. Switching it off keeps the copies on disk for later.
	PerPlayer bool `json:"perPlayer,omitempty"`
}

const (
	MaxNameLen        = 120
	MaxGameTypeLen    = 60
	MaxDescriptionLen = 1000
	MaxTags           = 12
	MaxTagLen         = 32
)

// Label is how a scope is named to people. The folders on disk keep their
// original names (shared/, gm/) so existing data folders keep working.
func (sc Scope) Label() string {
	if sc == GM {
		return "referee"
	}
	return "players"
}

// pageKey identifies a page inside session.json's "pages".
func pageKey(sc Scope, name string) string { return string(sc) + "/" + name }

// cleanText trims and validates free text typed into the dashboard. Single
// lines have all whitespace runs folded to one space; multi-line text keeps
// its line breaks. Other control characters are always removed.
func cleanText(s string, max int, what string, multiline bool) (string, error) {
	if !utf8.ValidString(s) {
		return "", fmt.Errorf("%w: %s isn't valid text", ErrInvalid, what)
	}
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.Map(func(r rune) rune {
		switch {
		case r == '\n' && multiline:
			return r
		case unicode.IsSpace(r):
			return ' '
		case unicode.IsControl(r):
			return -1
		}
		return r
	}, s)
	if multiline {
		lines := strings.Split(s, "\n")
		for i, l := range lines {
			lines[i] = strings.TrimRight(l, " ")
		}
		s = strings.TrimSpace(strings.Join(lines, "\n"))
	} else {
		s = strings.Join(strings.Fields(s), " ")
	}
	if n := utf8.RuneCountInString(s); n > max {
		return "", fmt.Errorf("%w: %s must be at most %d characters (it's %d)", ErrInvalid, what, max, n)
	}
	return s, nil
}

// cleanTags trims tags, drops empty ones and case-insensitive duplicates.
// Commas aren't allowed inside a tag, since the dashboard uses them to split.
func cleanTags(in []string) ([]string, error) {
	out := []string{}
	seen := map[string]bool{}
	for _, t := range in {
		t, err := cleanText(t, MaxTagLen, "a tag", false)
		if err != nil {
			return nil, err
		}
		if strings.Contains(t, ",") {
			return nil, fmt.Errorf("%w: tags can't contain commas", ErrInvalid)
		}
		if t == "" {
			continue
		}
		k := strings.ToLower(t)
		if !seen[k] {
			seen[k] = true
			out = append(out, t)
		}
	}
	if len(out) > MaxTags {
		return nil, fmt.Errorf("%w: at most %d tags", ErrInvalid, MaxTags)
	}
	return out, nil
}

func cleanName(name string) (string, error) {
	name, err := cleanText(name, MaxNameLen, "the session name", false)
	if err == nil && name == "" {
		err = fmt.Errorf("%w: the session name can't be empty", ErrInvalid)
	}
	return name, err
}

// updateMeta changes a session's session.json. Updates are applied one at a
// time so two edits made at once can't overwrite each other.
func (s *Store) updateMeta(id string, fn func(*Session) error) (Session, error) {
	s.metaMu.Lock()
	defer s.metaMu.Unlock()
	meta, err := s.loadMetaLocked(id)
	if err != nil {
		return Session{}, err
	}
	if err := fn(&meta); err != nil {
		return Session{}, err
	}
	return meta, s.writeMeta(meta)
}

// UpdateSession changes the display name and/or game type; nil leaves a
// field as it is. The folder id never changes.
func (s *Store) UpdateSession(id string, name, gameType *string) (Session, error) {
	var n, g string
	var err error
	if name != nil {
		if n, err = cleanName(*name); err != nil {
			return Session{}, err
		}
	}
	if gameType != nil {
		if g, err = cleanText(*gameType, MaxGameTypeLen, "the game type", false); err != nil {
			return Session{}, err
		}
	}
	return s.updateMeta(id, func(m *Session) error {
		if name != nil {
			m.Name = n
		}
		if gameType != nil {
			m.GameType = g
		}
		return nil
	})
}

// RenameSession changes the display name (the folder id stays stable).
func (s *Store) RenameSession(id, name string) (Session, error) {
	return s.UpdateSession(id, &name, nil)
}

// SetPageMeta replaces a page's description and tags, leaving its per-player
// switch as it is.
func (s *Store) SetPageMeta(id string, sc Scope, name string, pm PageMeta) (PageMeta, error) {
	pm, _, err := s.UpdatePageMeta(id, sc, name, pm, nil)
	return pm, err
}

// CanBePerPlayer says whether a page may have a copy per player: only
// players' pages that keep entries. Referee pages are never shown to players.
func CanBePerPlayer(sc Scope, k Kind) bool { return sc == Shared && HasState(k) }

// UpdatePageMeta replaces a page's description and tags and, unless perPlayer
// is nil, sets its per-player switch; it reports whether that switch changed.
// Entries for pages that no longer exist (removed by hand) are tidied away at
// the same time.
func (s *Store) UpdatePageMeta(id string, sc Scope, name string, pm PageMeta, perPlayer *bool) (PageMeta, bool, error) {
	if !s.Exists(id, sc, name) {
		return PageMeta{}, false, fmt.Errorf("file %q: %w", name, ErrNotFound)
	}
	desc, err := cleanText(pm.Description, MaxDescriptionLen, "the description", true)
	if err != nil {
		return PageMeta{}, false, err
	}
	tags, err := cleanTags(pm.Tags)
	if err != nil {
		return PageMeta{}, false, err
	}
	if perPlayer != nil && *perPlayer && !CanBePerPlayer(sc, kindOrEmpty(name)) {
		what := "referee pages"
		if sc == Shared {
			what = "images"
		}
		return PageMeta{}, false, fmt.Errorf("%w: only players' HTML pages and PDFs can have a copy per player, not %s", ErrInvalid, what)
	}
	clean := PageMeta{Description: desc, Tags: tags}
	changed := false
	_, err = s.updateMeta(id, func(m *Session) error {
		if m.Pages == nil {
			m.Pages = map[string]PageMeta{}
		}
		for k := range m.Pages {
			sc, file, _ := strings.Cut(k, "/")
			if !s.Exists(id, Scope(sc), file) {
				delete(m.Pages, k)
			}
		}
		was := m.Pages[pageKey(sc, name)].PerPlayer
		clean.PerPlayer = was
		if perPlayer != nil {
			clean.PerPlayer = *perPlayer
		}
		changed = clean.PerPlayer != was
		setPage(m, pageKey(sc, name), clean)
		return nil
	})
	return clean, changed, err
}

// setPage stores a page's details, leaving no entry for a page without any.
func setPage(m *Session, key string, pm PageMeta) {
	if pm.Description == "" && len(pm.Tags) == 0 && !pm.PerPlayer {
		delete(m.Pages, key)
	} else {
		m.Pages[key] = pm
	}
}

// movePageMeta follows a page that was moved or renamed (to == "" drops it).
// A page moved to the referee's side stops being per-player, as if switched
// off, so its players' copies are kept for when it comes back. The file
// operation has already happened, so a failure here is logged rather than
// reported as if the move itself had failed.
func (s *Store) movePageMeta(id string, sc Scope, name string, toScope Scope, toName string) {
	_, err := s.updateMeta(id, func(m *Session) error {
		pm, ok := m.Pages[pageKey(sc, name)]
		if !ok {
			return errNoChange
		}
		delete(m.Pages, pageKey(sc, name))
		if toName != "" {
			if !CanBePerPlayer(toScope, kindOrEmpty(toName)) {
				pm.PerPlayer = false
			}
			setPage(m, pageKey(toScope, toName), pm)
		}
		return nil
	})
	if err != nil && err != errNoChange && !os.IsNotExist(err) {
		log.Printf("updating details of %s/%s: %v", id, name, err)
	}
}

var errNoChange = fmt.Errorf("no change")
