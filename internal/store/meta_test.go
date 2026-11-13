package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestGameType(t *testing.T) {
	s := newStore(t)
	sess, err := s.CreateSession("  The Sunken   Keep ", " Mörk  Borg ")
	if err != nil || sess.Name != "The Sunken Keep" || sess.GameType != "Mörk Borg" {
		t.Fatalf("create = %+v, %v", sess, err)
	}
	gt := "D&D 5e"
	if _, err := s.UpdateSession(sess.ID, nil, &gt); err != nil {
		t.Fatal(err)
	}
	got, _ := s.GetSession(sess.ID)
	if got.GameType != "D&D 5e" || got.Name != "The Sunken Keep" {
		t.Fatalf("after game type change: %+v", got.Session)
	}
	// Survives on disk, readable by hand.
	b, _ := os.ReadFile(filepath.Join(s.Root(), "sessions", sess.ID, "session.json"))
	if !strings.Contains(string(b), `"gameType": "D\u0026D 5e"`) {
		t.Fatalf("session.json = %s", b)
	}
	long := strings.Repeat("x", MaxGameTypeLen+1)
	if _, err := s.UpdateSession(sess.ID, nil, &long); !errors.Is(err, ErrInvalid) {
		t.Fatalf("long game type: %v", err)
	}
	empty := "   "
	if _, err := s.UpdateSession(sess.ID, &empty, nil); !errors.Is(err, ErrInvalid) {
		t.Fatalf("empty name: %v", err)
	}
}

func TestPageMeta(t *testing.T) {
	s := newStore(t)
	sess, _ := s.CreateSession("Test", "")
	s.SaveFile(sess.ID, Shared, "map.html", strings.NewReader("<p>"))
	s.SaveFile(sess.ID, GM, "notes.html", strings.NewReader("<p>"))

	pm, err := s.SetPageMeta(sess.ID, Shared, "map.html", PageMeta{
		Description: "  The lower levels.\r\nBring a torch.  ",
		Tags:        []string{" Map ", "dungeon", "map", "", "level  2"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if pm.Description != "The lower levels.\nBring a torch." || strings.Join(pm.Tags, "|") != "Map|dungeon|level 2" {
		t.Fatalf("cleaned = %+v", pm)
	}
	files := mustFiles(t, s, sess.ID, Shared)
	if files[0].Description != pm.Description || len(files[0].Tags) != 3 {
		t.Fatalf("listed = %+v", files[0])
	}
	if f := mustFiles(t, s, sess.ID, GM)[0]; f.Tags == nil || len(f.Tags) != 0 {
		t.Fatalf("untagged file tags = %#v (want empty, not nil)", f.Tags)
	}

	// Moving and renaming carries the details; the referee page keeps its own.
	if err := s.MoveFile(sess.ID, Shared, "map.html", GM, ""); err != nil {
		t.Fatal(err)
	}
	moved := findFile(mustFiles(t, s, sess.ID, GM), "map.html")
	if moved == nil || moved.Description != pm.Description {
		t.Fatalf("after move: %+v", moved)
	}
	if err := s.MoveFile(sess.ID, GM, "map.html", GM, "lower-map.html"); err != nil {
		t.Fatal(err)
	}
	if f := findFile(mustFiles(t, s, sess.ID, GM), "lower-map.html"); f == nil || len(f.Tags) != 3 {
		t.Fatalf("after rename: %+v", f)
	}

	// Deleting drops them, so a new file with the old name starts clean.
	if err := s.DeleteFile(sess.ID, GM, "lower-map.html"); err != nil {
		t.Fatal(err)
	}
	s.SaveFile(sess.ID, GM, "lower-map.html", strings.NewReader("<p>"))
	if f := findFile(mustFiles(t, s, sess.ID, GM), "lower-map.html"); f.Description != "" {
		t.Fatalf("stale details: %+v", f)
	}

	// Clearing both fields removes the entry from session.json.
	s.SetPageMeta(sess.ID, GM, "notes.html", PageMeta{Tags: []string{"secret"}})
	s.SetPageMeta(sess.ID, GM, "notes.html", PageMeta{})
	got, _ := s.GetSession(sess.ID)
	if len(got.Pages) != 0 {
		t.Fatalf("pages = %+v", got.Pages)
	}
}

func TestPageMetaLimits(t *testing.T) {
	s := newStore(t)
	sess, _ := s.CreateSession("Test", "")
	s.SaveFile(sess.ID, Shared, "a.html", strings.NewReader("<p>"))
	many := make([]string, MaxTags+1)
	for i := range many {
		many[i] = string(rune('a' + i))
	}
	bad := []PageMeta{
		{Description: strings.Repeat("x", MaxDescriptionLen+1)},
		{Tags: many},
		{Tags: []string{strings.Repeat("t", MaxTagLen+1)}},
		{Tags: []string{"one, two"}},
		{Description: "\xff\xfe"},
	}
	for _, pm := range bad {
		if _, err := s.SetPageMeta(sess.ID, Shared, "a.html", pm); !errors.Is(err, ErrInvalid) {
			t.Errorf("SetPageMeta(%.40q, %v) err = %v", pm.Description, pm.Tags, err)
		}
	}
	if _, err := s.SetPageMeta(sess.ID, Shared, "missing.html", PageMeta{}); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing file: %v", err)
	}
	// Control characters vanish; the line break stays.
	pm, _ := s.SetPageMeta(sess.ID, Shared, "a.html", PageMeta{Description: "a\x00b\x1bc\nd"})
	if pm.Description != "abc\nd" {
		t.Errorf("description = %q", pm.Description)
	}
}

func TestHandEditedMetaIsNoticed(t *testing.T) {
	s := newStore(t)
	sess, _ := s.CreateSession("Test", "")
	before := s.Fingerprint()
	p := filepath.Join(s.Root(), "sessions", sess.ID, "session.json")
	b, _ := os.ReadFile(p)
	var m map[string]any
	json.Unmarshal(b, &m)
	m["gameType"] = "Mothership"
	b, _ = json.Marshal(m)
	os.WriteFile(p, b, 0o644)
	os.Chtimes(p, timeIn(2), timeIn(2))
	if s.Fingerprint() == before {
		t.Fatal("hand edit of session.json not noticed")
	}
	if got, _ := s.GetSession(sess.ID); got.GameType != "Mothership" {
		t.Fatalf("game type = %q", got.GameType)
	}
}

func mustFiles(t *testing.T, s *Store, id string, sc Scope) []FileInfo {
	t.Helper()
	sum, err := s.GetSession(id)
	if err != nil {
		t.Fatal(err)
	}
	return sum.Files[sc]
}

func findFile(fs []FileInfo, name string) *FileInfo {
	for i := range fs {
		if fs[i].Name == name {
			return &fs[i]
		}
	}
	return nil
}

func timeIn(sec int) time.Time { return time.Now().Add(time.Duration(sec) * time.Second) }

func TestPageOrder(t *testing.T) {
	s := newStore(t)
	sess, _ := s.CreateSession("Test", "")
	for _, n := range []string{"a.html", "b.html", "c.html", "d.html"} {
		s.SaveFile(sess.ID, Shared, n, strings.NewReader("<p>"))
	}
	s.SaveFile(sess.ID, GM, "notes.html", strings.NewReader("<p>"))
	names := func(sc Scope) string {
		t.Helper()
		sum, err := s.GetSession(sess.ID)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, f := range sum.Files[sc] {
			out = append(out, f.Name)
		}
		return strings.Join(out, ",")
	}
	if got := names(Shared); got != "a.html,b.html,c.html,d.html" {
		t.Fatalf("by name = %s", got)
	}
	// Unknown and repeated names are dropped; unlisted pages follow, by name.
	if err := s.SetOrder(sess.ID, Shared, []string{"c.html", "nope.html", "a.html", "c.html", "notes.html"}); err != nil {
		t.Fatal(err)
	}
	if got := names(Shared); got != "c.html,a.html,b.html,d.html" {
		t.Fatalf("ordered = %s", got)
	}
	// A rename keeps its place.
	if err := s.MoveFile(sess.ID, Shared, "a.html", Shared, "z.html"); err != nil {
		t.Fatal(err)
	}
	if got := names(Shared); got != "c.html,z.html,b.html,d.html" {
		t.Fatalf("after rename = %s", got)
	}
	// Moved to the referee: out of the players' order, after the referee's ordered pages.
	s.SetOrder(sess.ID, GM, []string{"notes.html"})
	if err := s.MoveFile(sess.ID, Shared, "c.html", GM, ""); err != nil {
		t.Fatal(err)
	}
	if got := names(Shared); got != "z.html,b.html,d.html" {
		t.Fatalf("players after move = %s", got)
	}
	if got := names(GM); got != "notes.html,c.html" {
		t.Fatalf("referee after move = %s", got)
	}
	// Deleted: gone from the order too.
	if err := s.DeleteFile(sess.ID, Shared, "z.html"); err != nil {
		t.Fatal(err)
	}
	meta, _ := s.loadMeta(sess.ID)
	if got := strings.Join(meta.Order[Shared], ","); got != "" {
		t.Fatalf("order after delete = %q", got)
	}
	if err := s.SetOrder(sess.ID, Scope("nope"), nil); !errors.Is(err, ErrInvalid) {
		t.Fatalf("bad scope: %v", err)
	}
}
