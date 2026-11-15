package store

import (
	"fmt"
	"log"
	"os"
	"slices"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// PageMeta is what the referee wrote about a page. It is shown to whoever can
// see the page, so a players' page's description is visible to players.
type PageMeta struct {
	// Title names the page in place of its own <title> (or heading, or
	// file name): two copies of one template can be told apart.
	Title       string   `json:"title,omitempty"`
	Description string   `json:"description,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	// PerPlayer gives every rostered player their own copy of the page's
	// entries. Switching it off keeps the copies on disk for later.
	PerPlayer bool `json:"perPlayer,omitempty"`
	// Hidden keeps a players' page from every player until the referee
	// reveals it. The audience below is kept for when it is revealed.
	Hidden bool `json:"hidden,omitempty"`
	// Audience is who sees a players' page once it isn't hidden: everyone
	// (AudienceAll) or only the players in Allowed (AudienceOnly). With
	// AudienceOnly and nobody allowed, only the referee sees it.
	Audience string   `json:"audience,omitempty"`
	Allowed  []string `json:"allowed,omitempty"`
}

// Who a players' page is for, once it isn't hidden.
const (
	AudienceAll  = ""
	AudienceOnly = "only"
)

// PageUpdate is a change to a page's details. Nil fields stay as they are.
type PageUpdate struct {
	Title       *string
	Description *string
	Tags        *[]string
	PerPlayer   *bool
	Hidden      *bool
	Audience    *string
	Allowed     *[]string
}

// PageChange says which of a page's switches an update changed, so the
// caller knows whom to tell.
type PageChange struct {
	PerPlayer  bool // switched on or off
	Visibility bool // hidden, audience or allowed players changed
}

const (
	MaxNameLen        = 120
	MaxTitleLen       = 80
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
	name, err := cleanText(name, MaxNameLen, "the campaign name", false)
	if err == nil && name == "" {
		err = fmt.Errorf("%w: the campaign name can't be empty", ErrInvalid)
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

// SetPageMeta replaces a page's description and tags, leaving its other
// settings as they are.
func (s *Store) SetPageMeta(id string, sc Scope, name string, pm PageMeta) (PageMeta, error) {
	tags := pm.Tags
	if tags == nil {
		tags = []string{}
	}
	pm, _, err := s.UpdatePageMeta(id, sc, name, PageUpdate{Description: &pm.Description, Tags: &tags})
	return pm, err
}

// CanBePerPlayer says whether a page may have a copy per player: only
// players' pages that keep entries. Referee pages are never shown to players.
func CanBePerPlayer(sc Scope, k Kind) bool { return sc == Shared && (k == KindHTML || k == KindPDF) }

// UpdatePageMeta changes a page's details: whatever the update sets, leaving
// the rest. It reports which switches changed. Entries for pages that no
// longer exist (removed by hand) are tidied away at the same time.
func (s *Store) UpdatePageMeta(id string, sc Scope, name string, up PageUpdate) (PageMeta, PageChange, error) {
	var ch PageChange
	if !s.Exists(id, sc, name) {
		return PageMeta{}, ch, fmt.Errorf("file %q: %w", name, ErrNotFound)
	}
	var title, desc string
	var tags []string
	var err error
	if up.Title != nil {
		if title, err = cleanText(*up.Title, MaxTitleLen, "the title", false); err != nil {
			return PageMeta{}, ch, err
		}
	}
	if up.Description != nil {
		if desc, err = cleanText(*up.Description, MaxDescriptionLen, "the description", true); err != nil {
			return PageMeta{}, ch, err
		}
	}
	if up.Tags != nil {
		if tags, err = cleanTags(*up.Tags); err != nil {
			return PageMeta{}, ch, err
		}
	}
	if up.PerPlayer != nil && *up.PerPlayer && !CanBePerPlayer(sc, kindOrEmpty(name)) {
		what := "referee pages"
		if sc == Shared {
			what = "images"
		}
		if kindOrEmpty(name) == KindMD {
			what = "Markdown pages"
		}
		return PageMeta{}, ch, fmt.Errorf("%w: only players' HTML pages and PDFs can have a copy per player, not %s", ErrInvalid, what)
	}
	if up.Audience != nil && *up.Audience != AudienceAll && *up.Audience != AudienceOnly {
		return PageMeta{}, ch, fmt.Errorf("%w: who sees a page is %q (everyone) or %q", ErrInvalid, AudienceAll, AudienceOnly)
	}
	restricts := (up.Hidden != nil && *up.Hidden) || (up.Audience != nil && *up.Audience == AudienceOnly)
	if sc != Shared && restricts {
		return PageMeta{}, ch, fmt.Errorf("%w: referee pages are never shown to players, so they can't be hidden from them", ErrInvalid)
	}
	var clean PageMeta
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
		was := m.Pages[pageKey(sc, name)]
		clean = was
		if up.Title != nil {
			clean.Title = title
		}
		if up.Description != nil {
			clean.Description = desc
		}
		if up.Tags != nil {
			clean.Tags = tags
		}
		if up.PerPlayer != nil {
			clean.PerPlayer = *up.PerPlayer
		}
		if up.Hidden != nil {
			clean.Hidden = *up.Hidden
		}
		if up.Audience != nil {
			clean.Audience = *up.Audience
		}
		if up.Allowed != nil {
			allowed := []string{}
			for _, pid := range *up.Allowed {
				if findPlayer(m.Players, pid) < 0 {
					return fmt.Errorf("%w: there is no player %q in this campaign", ErrInvalid, pid)
				}
				if !slices.Contains(allowed, pid) {
					allowed = append(allowed, pid)
				}
			}
			clean.Allowed = allowed
		}
		if clean.Audience == AudienceAll {
			clean.Allowed = nil // only kept while it means something
		}
		if len(clean.Allowed) == 0 {
			clean.Allowed = nil
		}
		ch.PerPlayer = clean.PerPlayer != was.PerPlayer
		ch.Visibility = clean.Hidden != was.Hidden || clean.Audience != was.Audience || !slices.Equal(clean.Allowed, was.Allowed)
		setPage(m, pageKey(sc, name), clean)
		return nil
	})
	if clean.Tags == nil {
		clean.Tags = []string{}
	}
	return clean, ch, err
}

// setPage stores a page's details, leaving no entry for a page without any.
func setPage(m *Session, key string, pm PageMeta) {
	if pm.Title == "" && pm.Description == "" && len(pm.Tags) == 0 && !pm.PerPlayer && !pm.Hidden && pm.Audience == AudienceAll {
		delete(m.Pages, key)
	} else {
		m.Pages[key] = pm
	}
}

// movePageMeta follows a page that was moved or renamed (to == "" drops it).
// A page moved to the referee's side stops being per-player, as if switched
// off, so its players' copies are kept for when it comes back. A page renamed
// in place keeps its position; one moved to the other scope goes after that
// scope's ordered pages until it is given a place. The file operation has
// already happened, so a failure here is logged rather than reported as if
// the move itself had failed.
func (s *Store) movePageMeta(id string, sc Scope, name string, toScope Scope, toName string) {
	_, err := s.updateMeta(id, func(m *Session) error {
		changed := moveInOrder(m, sc, name, toScope, toName)
		pm, ok := m.Pages[pageKey(sc, name)]
		if !ok {
			if changed {
				return nil
			}
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

// moveInOrder follows a moved, renamed or deleted page in the saved order,
// reporting whether the order changed.
func moveInOrder(m *Session, sc Scope, name string, toScope Scope, toName string) bool {
	list := m.Order[sc]
	at := slices.Index(list, name)
	if at < 0 {
		return false
	}
	if toName != "" && toScope == sc {
		list[at] = toName
		return true
	}
	list = slices.Delete(list, at, at+1)
	if len(list) == 0 {
		delete(m.Order, sc)
	} else {
		m.Order[sc] = list
	}
	return true
}

// MaxOrder is the most pages an order may list per scope.
const MaxOrder = 1000

// SetOrder sets the order one scope's pages are shown in, to the referee and
// to players. Names that aren't pages of that scope are left out; pages not
// named follow the named ones, by name.
func (s *Store) SetOrder(id string, sc Scope, names []string) error {
	if _, err := ParseScope(string(sc)); err != nil {
		return err
	}
	if len(names) > MaxOrder {
		return fmt.Errorf("%w: at most %d pages can be ordered", ErrInvalid, MaxOrder)
	}
	clean := []string{}
	for _, n := range names {
		if !slices.Contains(clean, n) && s.Exists(id, sc, n) {
			clean = append(clean, n)
		}
	}
	_, err := s.updateMeta(id, func(m *Session) error {
		if m.Order == nil {
			m.Order = map[Scope][]string{}
		}
		if len(clean) == 0 {
			delete(m.Order, sc)
		} else {
			m.Order[sc] = clean
		}
		return nil
	})
	return err
}

// sortByOrder puts files (sorted by name) into the saved order: listed
// pages first, in their order, then the rest as they were.
func sortByOrder(files []FileInfo, order []string) {
	if len(order) == 0 {
		return
	}
	pos := make(map[string]int, len(order))
	for i, n := range order {
		pos[n] = i
	}
	rank := func(f FileInfo) int {
		if i, ok := pos[f.Name]; ok {
			return i
		}
		return len(order)
	}
	sort.SliceStable(files, func(i, j int) bool { return rank(files[i]) < rank(files[j]) })
}

var errNoChange = fmt.Errorf("no change")
