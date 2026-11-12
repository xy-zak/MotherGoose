package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRosterAndSlugIDs(t *testing.T) {
	s := newStore(t)
	sess, _ := s.CreateSession("Test", "")
	add := func(name string) Player {
		t.Helper()
		p, err := s.AddPlayer(sess.ID, name)
		if err != nil {
			t.Fatalf("AddPlayer(%q): %v", name, err)
		}
		return p
	}
	if p := add("  Ana  "); p.ID != "ana" || p.Name != "Ana" {
		t.Fatalf("ana = %+v", p)
	}
	if p := add("ANA"); p.ID != "ana-2" {
		t.Fatalf("second ana = %+v", p)
	}
	if p := add("Zoë O'Brien"); p.ID != "zo-o-brien" {
		t.Fatalf("punctuated = %+v", p)
	}
	if p := add("李"); p.ID != "player" {
		t.Fatalf("no latin letters = %+v", p)
	}
	for _, bad := range []string{"", "   ", strings.Repeat("x", MaxPlayerNameLen+1), "\xff"} {
		if _, err := s.AddPlayer(sess.ID, bad); !errors.Is(err, ErrInvalid) {
			t.Errorf("AddPlayer(%q) err = %v", bad, err)
		}
	}

	// Renaming keeps the id, which names the folder of their entries.
	p, err := s.RenamePlayer(sess.ID, "ana", "Ana B.")
	if err != nil || p.ID != "ana" || p.Name != "Ana B." {
		t.Fatalf("rename = %+v, %v", p, err)
	}
	if _, err := s.RenamePlayer(sess.ID, "nobody", "X"); !errors.Is(err, ErrNotFound) {
		t.Errorf("rename unknown: %v", err)
	}
	if err := s.RemovePlayer(sess.ID, "ana-2", false); err != nil {
		t.Fatal(err)
	}
	if err := s.RemovePlayer(sess.ID, "ana-2", false); !errors.Is(err, ErrNotFound) {
		t.Errorf("remove twice: %v", err)
	}
	got, _ := s.GetSession(sess.ID)
	if len(got.Players) != 3 || got.Players[0] != (Player{"ana", "Ana B."}) || got.Players[1].ID != "zo-o-brien" {
		t.Fatalf("roster = %+v", got.Players)
	}

	// At most MaxPlayers.
	for len(got.Players) < MaxPlayers {
		add("Extra")
		got, _ = s.GetSession(sess.ID)
	}
	if _, err := s.AddPlayer(sess.ID, "One Too Many"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("25th player: %v", err)
	}
}

func TestEmptyRosterIsAList(t *testing.T) {
	s := newStore(t)
	sess, _ := s.CreateSession("Test", "")
	b, _ := os.ReadFile(filepath.Join(s.Root(), "sessions", sess.ID, "session.json"))
	if !strings.Contains(string(b), `"players": []`) {
		t.Fatalf("session.json = %s", b)
	}
	got, _ := s.GetSession(sess.ID)
	if out, _ := json.Marshal(got); !strings.Contains(string(out), `"players":[]`) {
		t.Fatalf("summary = %s", out)
	}
}

// Player ids name folders, so a hand-edited roster can't smuggle in a path.
func TestHandEditedRosterIsChecked(t *testing.T) {
	s := newStore(t)
	sess, _ := s.CreateSession("Test", "")
	p := filepath.Join(s.Root(), "sessions", sess.ID, "session.json")
	os.WriteFile(p, []byte(`{"name":"Test","players":[
		{"id":"ana","name":"  Ana  "},{"id":"../../etc","name":"x"},{"id":"Ben","name":"Ben"},
		{"id":"ana","name":"dup"},{"id":"cy","name":""}]}`), 0o644)
	got, err := s.GetSession(sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	want := []Player{{"ana", "Ana"}, {"cy", "cy"}}
	if len(got.Players) != len(want) || got.Players[0] != want[0] || got.Players[1] != want[1] {
		t.Fatalf("roster = %+v", got.Players)
	}
	if _, err := s.GetState(sess.ID, Shared, "a.html", "../../etc"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("path in player id: %v", err)
	}
}

// perPlayerSheet makes a session with a per-player sheet and Ana and Ben.
func perPlayerSheet(t *testing.T) (*Store, string) {
	t.Helper()
	s := newStore(t)
	sess, _ := s.CreateSession("Test", "")
	s.SaveFile(sess.ID, Shared, "sheet.html", strings.NewReader("<p>"))
	s.AddPlayer(sess.ID, "Ana")
	s.AddPlayer(sess.ID, "Ben")
	on := true
	if _, _, err := s.UpdatePageMeta(sess.ID, Shared, "sheet.html", PageMeta{}, &on); err != nil {
		t.Fatal(err)
	}
	return s, sess.ID
}

func val(t *testing.T, s *Store, id, player, key string) string {
	t.Helper()
	st, err := s.GetState(id, Shared, "sheet.html", player)
	if err != nil {
		t.Fatal(err)
	}
	return string(st[key])
}

func TestCopyStartsFromTemplate(t *testing.T) {
	s, id := perPlayerSheet(t)
	s.SetValue(id, Shared, "sheet.html", "", "#hp", json.RawMessage(`"10"`))
	// Until Ana writes, her copy follows the template.
	if got := val(t, s, id, "ana", "#hp"); got != `"10"` {
		t.Fatalf("unwritten copy hp = %s", got)
	}
	s.SetValue(id, Shared, "sheet.html", "", "#hp", json.RawMessage(`"11"`))
	if got := val(t, s, id, "ana", "#hp"); got != `"11"` {
		t.Fatalf("unwritten copy after template edit = %s", got)
	}
	// Her first write seeds the copy with the template's entries.
	if err := s.SetValue(id, Shared, "sheet.html", "ana", "#name", json.RawMessage(`"Ana"`)); err != nil {
		t.Fatal(err)
	}
	s.SetValue(id, Shared, "sheet.html", "", "#hp", json.RawMessage(`"12"`))
	if got := val(t, s, id, "ana", "#hp"); got != `"11"` {
		t.Fatalf("written copy followed the template: hp = %s", got)
	}
	if val(t, s, id, "", "#name") != "" || val(t, s, id, "ben", "#name") != "" {
		t.Fatal("Ana's entry leaked into the template or Ben's copy")
	}
	s.Flush()

	// On disk, and survives a restart.
	p := filepath.Join(s.Root(), "sessions", id, "state", "players", "ana", "sheet.html.json")
	if b, err := os.ReadFile(p); err != nil || !strings.Contains(string(b), `"Ana"`) {
		t.Fatalf("copy on disk = %s, %v", b, err)
	}
	s2, _ := Open(s.Root())
	if got := val(t, s2, id, "ana", "#name"); got != `"Ana"` {
		t.Fatalf("after reopen = %s", got)
	}
	got, _ := s2.GetSession(id)
	f := findFile(got.Files[Shared], "sheet.html")
	if !f.PerPlayer || !f.PlayerState["ana"] || f.PlayerState["ben"] || len(f.PlayerState) != 2 {
		t.Fatalf("listed = %+v", f)
	}

	// Resetting a copy sends it back to the template's entries.
	if err := s2.ResetState(id, Shared, "sheet.html", "ana"); err != nil {
		t.Fatal(err)
	}
	if got := val(t, s2, id, "ana", "#hp"); got != `"12"` {
		t.Fatalf("reset copy hp = %s", got)
	}
	if _, err := os.Stat(p); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("reset copy still on disk: %v", err)
	}
	// Referee pages have no copies.
	if err := s2.SetValue(id, GM, "sheet.html", "ana", "k", json.RawMessage(`1`)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("gm copy: %v", err)
	}
}

func TestCorruptCopyIsKept(t *testing.T) {
	s, id := perPlayerSheet(t)
	s.SetValue(id, Shared, "sheet.html", "", "#hp", json.RawMessage(`"10"`))
	p := s.statePath(id, Shared, "sheet.html", "ana")
	os.MkdirAll(filepath.Dir(p), 0o755)
	os.WriteFile(p, []byte(`{"#hp": `), 0o644)
	if got := val(t, s, id, "ana", "#hp"); got != `"10"` {
		t.Fatalf("corrupt copy reads %s, want the template's", got)
	}
	if len(backups(t, p)) != 1 {
		t.Fatal("corrupt copy not kept")
	}
}

func TestPerPlayerSwitch(t *testing.T) {
	s, id := perPlayerSheet(t)
	s.SetValue(id, Shared, "sheet.html", "ana", "#name", json.RawMessage(`"Ana"`))
	s.Flush()

	// Editing the details leaves the switch alone.
	if _, err := s.SetPageMeta(id, Shared, "sheet.html", PageMeta{Description: "fill me"}); err != nil {
		t.Fatal(err)
	}
	if f := findFile(mustFiles(t, s, id, Shared), "sheet.html"); !f.PerPlayer {
		t.Fatal("details edit switched per-player off")
	}

	// Off keeps the copies; on again brings them back.
	off, on := false, true
	if _, changed, err := s.UpdatePageMeta(id, Shared, "sheet.html", PageMeta{}, &off); err != nil || !changed {
		t.Fatalf("off: changed=%v err=%v", changed, err)
	}
	if f := findFile(mustFiles(t, s, id, Shared), "sheet.html"); f.PerPlayer || f.PlayerState != nil {
		t.Fatalf("after off: %+v", f)
	}
	got, _ := s.GetSession(id)
	if _, ok := got.Pages["shared/sheet.html"]; ok {
		t.Fatalf("empty page entry kept: %+v", got.Pages)
	}
	if _, changed, _ := s.UpdatePageMeta(id, Shared, "sheet.html", PageMeta{}, &off); changed {
		t.Fatal("off twice reported a change")
	}
	s.UpdatePageMeta(id, Shared, "sheet.html", PageMeta{}, &on)
	if f := findFile(mustFiles(t, s, id, Shared), "sheet.html"); !f.PerPlayer || !f.PlayerState["ana"] {
		t.Fatalf("after on again: %+v", f)
	}
	if got := val(t, s, id, "ana", "#name"); got != `"Ana"` {
		t.Fatalf("copy after off and on = %s", got)
	}

	// Only players' HTML pages and PDFs.
	s.SaveFile(id, GM, "notes.html", strings.NewReader("<p>"))
	s.SaveFile(id, Shared, "map.png", strings.NewReader(string(pngBytes(t))))
	for _, f := range []struct {
		sc   Scope
		name string
	}{{GM, "notes.html"}, {Shared, "map.png"}} {
		if _, _, err := s.UpdatePageMeta(id, f.sc, f.name, PageMeta{}, &on); !errors.Is(err, ErrInvalid) {
			t.Errorf("per-player %s/%s: %v", f.sc, f.name, err)
		}
		if _, _, err := s.UpdatePageMeta(id, f.sc, f.name, PageMeta{}, &off); err != nil {
			t.Errorf("switching off %s/%s: %v", f.sc, f.name, err)
		}
	}
	s.SaveFile(id, Shared, "form.pdf", strings.NewReader(tinyPDF))
	if _, _, err := s.UpdatePageMeta(id, Shared, "form.pdf", PageMeta{}, &on); err != nil {
		t.Errorf("per-player pdf: %v", err)
	}
}

func TestRemovePlayerKeepsOrDeletesEntries(t *testing.T) {
	s, id := perPlayerSheet(t)
	s.SetValue(id, Shared, "sheet.html", "ana", "#name", json.RawMessage(`"Ana"`))
	s.SetValue(id, Shared, "sheet.html", "ben", "#name", json.RawMessage(`"Ben"`))
	dir := func(p string) string { return filepath.Join(s.Root(), "sessions", id, "state", "players", p) }

	// Keep (the default): pending entries are written, and re-adding the
	// same name restores them.
	if err := s.RemovePlayer(id, "ana", false); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(filepath.Join(dir("ana"), "sheet.html.json")); err != nil || !strings.Contains(string(b), "Ana") {
		t.Fatalf("kept entries = %s, %v", b, err)
	}
	if f := findFile(mustFiles(t, s, id, Shared), "sheet.html"); len(f.PlayerState) != 1 {
		t.Fatalf("removed player still listed: %+v", f.PlayerState)
	}
	if p, _ := s.AddPlayer(id, "Ana"); p.ID != "ana" {
		t.Fatalf("re-added as %q", p.ID)
	}
	if got := val(t, s, id, "ana", "#name"); got != `"Ana"` {
		t.Fatalf("restored = %s", got)
	}

	// Delete: gone from disk, and a pending write doesn't bring it back.
	if err := s.RemovePlayer(id, "ben", true); err != nil {
		t.Fatal(err)
	}
	s.Flush()
	if _, err := os.Stat(dir("ben")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("deleted entries still there: %v", err)
	}
	s.AddPlayer(id, "Ben")
	if got := val(t, s, id, "ben", "#name"); got != "" {
		t.Fatalf("deleted entries came back: %s", got)
	}
}

func TestMoveRenameDeleteCarryCopies(t *testing.T) {
	s, id := perPlayerSheet(t)
	s.SetValue(id, Shared, "sheet.html", "ana", "#name", json.RawMessage(`"Ana"`))
	// Ben's is still waiting to be written when the page is renamed.
	s.Flush()
	s.SetValue(id, Shared, "sheet.html", "ben", "#name", json.RawMessage(`"Ben"`))

	if err := s.MoveFile(id, Shared, "sheet.html", Shared, "hero.html"); err != nil {
		t.Fatal(err)
	}
	if f := findFile(mustFiles(t, s, id, Shared), "hero.html"); f == nil || !f.PerPlayer || !f.PlayerState["ana"] || !f.PlayerState["ben"] {
		t.Fatalf("after rename: %+v", f)
	}
	hero := func(p string) string {
		st, _ := s.GetState(id, Shared, "hero.html", p)
		return string(st["#name"])
	}
	if hero("ana") != `"Ana"` || hero("ben") != `"Ben"` {
		t.Fatalf("copies after rename: %s %s", hero("ana"), hero("ben"))
	}
	if old, _ := filepath.Glob(filepath.Join(s.Root(), "sessions", id, "state", "players", "*", "sheet.html.json")); len(old) != 0 {
		t.Fatalf("old copies left: %v", old)
	}

	// To the referee's side: no longer per-player, copies kept for coming back.
	if err := s.MoveFile(id, Shared, "hero.html", GM, ""); err != nil {
		t.Fatal(err)
	}
	if f := findFile(mustFiles(t, s, id, GM), "hero.html"); f.PerPlayer {
		t.Fatal("referee page is per-player")
	}
	s.MoveFile(id, GM, "hero.html", Shared, "")
	on := true
	s.UpdatePageMeta(id, Shared, "hero.html", PageMeta{}, &on)
	if hero("ana") != `"Ana"` {
		t.Fatalf("copy after round trip = %s", hero("ana"))
	}

	// Deleting removes every copy, even of a player no longer on the roster,
	// so a new page with the same name starts clean.
	s.RemovePlayer(id, "ben", false)
	if err := s.DeleteFile(id, Shared, "hero.html"); err != nil {
		t.Fatal(err)
	}
	if left, _ := filepath.Glob(filepath.Join(s.Root(), "sessions", id, "state", "players", "*", "*")); len(left) != 0 {
		t.Fatalf("copies left after delete: %v", left)
	}
	s.SaveFile(id, Shared, "hero.html", strings.NewReader("<p>"))
	if hero("ana") != "" {
		t.Fatal("new page inherited a copy")
	}
}
