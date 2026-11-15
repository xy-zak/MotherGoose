package store

import (
	"fmt"
	"log"
	"regexp"
	"slices"
	"strings"
)

// Player is someone on a session's roster. The id is a slug of the name the
// player was added with and never changes, because it names the folder their
// entries are kept in (state/players/<id>/) and the device cookie refers to it.
type Player struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

const (
	MaxPlayers       = 24
	MaxPlayerNameLen = 40
	maxPlayerIDLen   = 64 // a 40-character slug plus a suffix, with room for hand edits
)

var playerIDRe = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// ValidPlayerID accepts the ids MotherGoose makes: lower-case letters,
// digits and single dashes. Being a folder name, anything else is refused,
// including from a hand-edited session.json.
func ValidPlayerID(id string) bool {
	return len(id) <= maxPlayerIDLen && playerIDRe.MatchString(id)
}

func cleanPlayerName(name string) (string, error) {
	name, err := cleanText(name, MaxPlayerNameLen, "the player's name", false)
	if err == nil && name == "" {
		err = fmt.Errorf("%w: the player's name can't be empty", ErrInvalid)
	}
	return name, err
}

// cleanRoster tidies a roster read from session.json, which may have been
// edited by hand: players with an unusable id or a repeated one are left out
// (and logged), and a missing or unusable name falls back to the id.
func cleanRoster(in []Player) []Player {
	out := []Player{}
	seen := map[string]bool{}
	for _, p := range in {
		if !ValidPlayerID(p.ID) || seen[p.ID] {
			log.Printf("session.json: ignoring player %q: ids are lower-case letters, digits and dashes, and unique", p.ID)
			continue
		}
		seen[p.ID] = true
		if n, err := cleanPlayerName(p.Name); err == nil {
			p.Name = n
		} else {
			p.Name = p.ID
		}
		out = append(out, p)
	}
	return out
}

func findPlayer(ps []Player, id string) int {
	for i, p := range ps {
		if p.ID == id {
			return i
		}
	}
	return -1
}

func playerSlug(name string) string {
	s := strings.Trim(slugRe.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if len(s) > MaxPlayerNameLen {
		s = strings.Trim(s[:MaxPlayerNameLen], "-")
	}
	if s == "" {
		s = "player" // a name with no Latin letters or digits, e.g. "李"
	}
	return s
}

// Players returns a session's roster.
func (s *Store) Players(id string) ([]Player, error) {
	meta, err := s.loadMeta(id)
	if err != nil {
		return nil, err
	}
	return meta.Players, nil
}

// PageAccess is what deciding who may open a page needs, read in one go.
type PageAccess struct {
	PerPlayer bool
	Players   []Player
	// Hidden, Restricted and Allowed say which players see the page: nobody
	// while it is hidden, otherwise everyone, or only Allowed if Restricted.
	Hidden     bool
	Restricted bool
	Allowed    []string
}

// HasPlayer reports whether id is on the roster.
func (a PageAccess) HasPlayer(id string) bool { return id != "" && findPlayer(a.Players, id) >= 0 }

// Visible reports whether a player's device (me is the player it picked,
// "" for none) may see the page at all. The host always may: this is only
// asked about other devices.
func (a PageAccess) Visible(me string) bool {
	if a.Hidden {
		return false
	}
	if !a.Restricted {
		return true
	}
	return a.HasPlayer(me) && slices.Contains(a.Allowed, me)
}

// accessOf works out a page's access from its details. A hand edit of
// session.json can't make a referee page per-player or shown to players, and
// an audience it misspells counts as "only", which hides rather than shows.
func accessOf(pm PageMeta, sc Scope, name string, players []Player) PageAccess {
	a := PageAccess{
		PerPlayer: pm.PerPlayer && CanBePerPlayer(sc, kindOrEmpty(name)),
		Players:   players,
	}
	if sc == Shared {
		a.Hidden = pm.Hidden
		a.Restricted = pm.Audience != AudienceAll
		for _, pid := range pm.Allowed {
			if findPlayer(players, pid) >= 0 && !slices.Contains(a.Allowed, pid) {
				a.Allowed = append(a.Allowed, pid)
			}
		}
	}
	return a
}

// Access reads what deciding who may open a page needs: its per-player
// switch, who it is shown to, and the session's roster.
func (s *Store) Access(id string, sc Scope, name string) (PageAccess, error) {
	meta, err := s.loadMeta(id)
	if err != nil {
		return PageAccess{}, err
	}
	return accessOf(meta.Pages[pageKey(sc, name)], sc, name, meta.Players), nil
}

// AddPlayer puts a player on the roster, with an id made from their name
// ("ana", then "ana-2"). Entries kept from an earlier player with the same id
// become theirs, which is how re-adding a removed player restores them.
func (s *Store) AddPlayer(id, name string) (Player, error) {
	name, err := cleanPlayerName(name)
	if err != nil {
		return Player{}, err
	}
	var p Player
	_, err = s.updateMeta(id, func(m *Session) error {
		if len(m.Players) >= MaxPlayers {
			return fmt.Errorf("%w: a campaign can have at most %d players", ErrInvalid, MaxPlayers)
		}
		base := playerSlug(name)
		pid := base
		for i := 2; findPlayer(m.Players, pid) >= 0; i++ {
			pid = fmt.Sprintf("%s-%d", base, i)
		}
		p = Player{ID: pid, Name: name}
		m.Players = append(m.Players, p)
		return nil
	})
	return p, err
}

// RenamePlayer changes a player's display name; their id stays.
func (s *Store) RenamePlayer(id, player, name string) (Player, error) {
	name, err := cleanPlayerName(name)
	if err != nil {
		return Player{}, err
	}
	var p Player
	_, err = s.updateMeta(id, func(m *Session) error {
		i := findPlayer(m.Players, player)
		if i < 0 {
			return fmt.Errorf("player %q: %w", player, ErrNotFound)
		}
		m.Players[i].Name = name
		p = m.Players[i]
		return nil
	})
	return p, err
}
