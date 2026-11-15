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

// A deleted page goes to the trash with its details, place, entries and
// every copy (pending ones included), and comes back whole.
func TestTrashPageRoundTrip(t *testing.T) {
	s, id := perPlayerSheet(t)
	s.SaveFile(id, Shared, "intro.html", strings.NewReader("<p>"))
	s.SetOrder(id, Shared, []string{"intro.html", "sheet.html"})
	desc, only := "hers", AudienceOnly
	s.UpdatePageMeta(id, Shared, "sheet.html", PageUpdate{Description: &desc, Audience: &only, Allowed: &[]string{"ana", "ben"}})
	s.SetValue(id, Shared, "sheet.html", "", "#name", json.RawMessage(`"start"`))
	s.SetValue(id, Shared, "sheet.html", "ana", "#name", json.RawMessage(`"Ana"`)) // still pending

	tid, err := s.DeleteFile(id, Shared, "sheet.html")
	if err != nil || tid == "" {
		t.Fatalf("delete: %q %v", tid, err)
	}
	if s.Exists(id, Shared, "sheet.html") {
		t.Fatal("page still there")
	}
	items, _ := s.ListTrash()
	if len(items) != 1 || items[0].Kind != TrashPage || items[0].Name != "sheet.html" || items[0].SessionName != "Test" {
		t.Fatalf("trash: %+v", items)
	}
	// Ben leaves meanwhile: he isn't listed again.
	s.RemovePlayer(id, "ben", false)

	it, err := s.RestoreTrash(tid)
	if err != nil || it.Name != "sheet.html" {
		t.Fatalf("restore: %+v %v", it, err)
	}
	f := findFile(mustFiles(t, s, id, Shared), "sheet.html")
	if f == nil || f.Description != "hers" || !f.PerPlayer || f.Audience != AudienceOnly || strings.Join(f.Allowed, ",") != "ana" {
		t.Fatalf("details after restore: %+v", f)
	}
	if got := mustFiles(t, s, id, Shared); got[0].Name != "intro.html" || got[1].Name != "sheet.html" {
		t.Fatalf("order after restore: %v, %v", got[0].Name, got[1].Name)
	}
	if val(t, s, id, "", "#name") != `"start"` || val(t, s, id, "ana", "#name") != `"Ana"` {
		t.Fatal("entries not restored")
	}
	if items, _ := s.ListTrash(); len(items) != 1 || items[0].Kind != TrashPlayer {
		t.Fatalf("trash after restore (just Ben's removal): %+v", items)
	}
	if _, err := s.RestoreTrash(tid); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second restore: %v", err)
	}
}

// A page whose name was taken while it was in the trash comes back under a
// free one, its entries following it.
func TestTrashPageNameTaken(t *testing.T) {
	s := newStore(t)
	sess, _ := s.CreateSession("Test", "")
	s.SaveFile(sess.ID, GM, "map.html", strings.NewReader("<p>"))
	s.SetValue(sess.ID, GM, "map.html", "", "#a", json.RawMessage(`1`))
	tid, _ := s.DeleteFile(sess.ID, GM, "map.html")
	s.SaveFile(sess.ID, Shared, "map.html", strings.NewReader("<p>new"))
	it, err := s.RestoreTrash(tid)
	if err != nil || it.Name != "map-2.html" {
		t.Fatalf("restore: %+v %v", it, err)
	}
	if st, _ := s.GetState(sess.ID, GM, "map-2.html", ""); string(st["#a"]) != "1" {
		t.Fatalf("entries: %v", st)
	}
	if st, _ := s.GetState(sess.ID, Shared, "map.html", ""); len(st) != 0 {
		t.Fatalf("the new page got entries: %v", st)
	}
}

// Cleared entries, and one cleared copy, can be put back; clearing nothing
// leaves nothing in the trash.
func TestTrashEntries(t *testing.T) {
	s, id := perPlayerSheet(t)
	if tid, err := s.ResetState(id, Shared, "sheet.html", "ana"); err != nil || tid != "" {
		t.Fatalf("clearing an empty copy: %q %v", tid, err)
	}
	s.SetValue(id, Shared, "sheet.html", "ana", "#name", json.RawMessage(`"Ana"`))
	tid, err := s.ResetState(id, Shared, "sheet.html", "ana")
	if err != nil || tid == "" {
		t.Fatalf("clear: %q %v", tid, err)
	}
	if val(t, s, id, "ana", "#name") != "" {
		t.Fatal("not cleared")
	}
	s.SetValue(id, Shared, "sheet.html", "ana", "#name", json.RawMessage(`"typed since"`))
	if _, err := s.RestoreTrash(tid); err != nil {
		t.Fatal(err)
	}
	if val(t, s, id, "ana", "#name") != `"Ana"` {
		t.Fatalf("after restore: %s", val(t, s, id, "ana", "#name"))
	}
	// The page went: its entries can't come back on their own.
	s.SetValue(id, Shared, "sheet.html", "", "#x", json.RawMessage(`1`))
	tid, _ = s.ResetState(id, Shared, "sheet.html", "")
	s.DeleteFile(id, Shared, "sheet.html")
	if _, err := s.RestoreTrash(tid); !errors.Is(err, ErrNotFound) {
		t.Fatalf("entries of a deleted page: %v", err)
	}
}

// A removed player comes back in their place, with their copies and the
// pages shown only to them.
func TestTrashPlayer(t *testing.T) {
	s, id := perPlayerSheet(t)
	only := AudienceOnly
	s.UpdatePageMeta(id, Shared, "sheet.html", PageUpdate{Audience: &only, Allowed: &[]string{"ana"}})
	s.SetValue(id, Shared, "sheet.html", "ana", "#name", json.RawMessage(`"Ana"`))
	tid, err := s.RemovePlayer(id, "ana", true)
	if err != nil || tid == "" {
		t.Fatalf("remove: %q %v", tid, err)
	}
	if _, err := os.Stat(filepath.Join(s.Root(), "sessions", id, "state", "players", "ana")); !os.IsNotExist(err) {
		t.Fatal("copies left behind")
	}
	if _, err := s.RestoreTrash(tid); err != nil {
		t.Fatal(err)
	}
	ps, _ := s.Players(id)
	if len(ps) != 2 || ps[0].ID != "ana" {
		t.Fatalf("roster: %+v", ps)
	}
	f := findFile(mustFiles(t, s, id, Shared), "sheet.html")
	if strings.Join(f.Allowed, ",") != "ana" || val(t, s, id, "ana", "#name") != `"Ana"` {
		t.Fatalf("after restore: %+v %s", f, val(t, s, id, "ana", "#name"))
	}
	// Added back by hand first: the trash says so.
	tid, _ = s.RemovePlayer(id, "ben", false)
	s.AddPlayer(id, "Ben")
	if _, err := s.RestoreTrash(tid); !errors.Is(err, ErrExists) {
		t.Fatalf("restoring a player who is back: %v", err)
	}
}

// A deleted campaign comes back whole, under a free id if its own was taken.
func TestTrashCampaign(t *testing.T) {
	s, id := perPlayerSheet(t)
	s.SetValue(id, Shared, "sheet.html", "ana", "#name", json.RawMessage(`"Ana"`)) // pending
	s.SetActive(id)
	tid, err := s.DeleteSession(id)
	if err != nil {
		t.Fatal(err)
	}
	if s.Active() != "" {
		t.Fatal("still live")
	}
	if _, err := s.CreateSession("Test", ""); err != nil {
		t.Fatal(err)
	}
	it, err := s.RestoreTrash(tid)
	if err != nil || it.Session != id+"-2" {
		t.Fatalf("restore: %+v %v", it, err)
	}
	if st, _ := s.GetState(it.Session, Shared, "sheet.html", "ana"); string(st["#name"]) != `"Ana"` {
		t.Fatalf("entries: %v", st)
	}
	if ps, _ := s.Players(it.Session); len(ps) != 2 {
		t.Fatalf("party: %v", ps)
	}
}

// Opening the data folder empties items older than TrashKeep.
func TestTrashExpires(t *testing.T) {
	s := newStore(t)
	sess, _ := s.CreateSession("Test", "")
	s.SaveFile(sess.ID, GM, "a.html", strings.NewReader("<p>"))
	s.SaveFile(sess.ID, GM, "b.html", strings.NewReader("<p>"))
	old, _ := s.DeleteFile(sess.ID, GM, "a.html")
	recent, _ := s.DeleteFile(sess.ID, GM, "b.html")
	it, _ := s.readTrashItem(old)
	it.Deleted = time.Now().Add(-TrashKeep - time.Hour)
	writeTrashItem(filepath.Join(s.trashDir(), old), it)
	s2, err := Open(s.Root())
	if err != nil {
		t.Fatal(err)
	}
	items, _ := s2.ListTrash()
	if len(items) != 1 || items[0].ID != recent {
		t.Fatalf("after expiry: %+v", items)
	}
	if err := s2.EmptyTrash(); err != nil {
		t.Fatal(err)
	}
	if items, _ := s2.ListTrash(); len(items) != 0 {
		t.Fatal("not emptied")
	}
}

func TestTrashRefusesBadIDs(t *testing.T) {
	s := newStore(t)
	for _, id := range []string{"", "..", "../sessions", "20260101-000000000-zzzzzz"} {
		if _, err := s.RestoreTrash(id); !errors.Is(err, ErrNotFound) {
			t.Errorf("RestoreTrash(%q) = %v", id, err)
		}
	}
}

// A duplicate has the pages, details and order, the party only if asked,
// and never the entries.
func TestDuplicateSession(t *testing.T) {
	s, id := perPlayerSheet(t)
	s.SaveFile(id, GM, "secrets.html", strings.NewReader("<p>"))
	s.SaveFile(id, Shared, "intro.html", strings.NewReader("<p>"))
	s.SetOrder(id, Shared, []string{"sheet.html", "intro.html"})
	hidden, only := true, AudienceOnly
	s.UpdatePageMeta(id, Shared, "intro.html", PageUpdate{Hidden: &hidden, Audience: &only, Allowed: &[]string{"ben"}})
	s.SetValue(id, Shared, "sheet.html", "", "#a", json.RawMessage(`1`))
	s.SetValue(id, Shared, "sheet.html", "ana", "#a", json.RawMessage(`2`))
	s.Flush()

	d, err := s.DuplicateSession(id, "Test again", false)
	if err != nil {
		t.Fatal(err)
	}
	sum, _ := s.GetSession(d.ID)
	if len(sum.Players) != 0 || len(sum.Files[GM]) != 1 || len(sum.Files[Shared]) != 2 || sum.Files[Shared][0].Name != "sheet.html" {
		t.Fatalf("duplicate: %+v", sum)
	}
	in := findFile(sum.Files[Shared], "intro.html")
	if !in.Hidden || in.Audience != AudienceOnly || len(in.Allowed) != 0 {
		t.Fatalf("details without the party: %+v", in)
	}
	if st, _ := s.GetState(d.ID, Shared, "sheet.html", ""); len(st) != 0 {
		t.Fatalf("entries copied: %v", st)
	}
	d2, _ := s.DuplicateSession(id, "With party", true)
	sum, _ = s.GetSession(d2.ID)
	if len(sum.Players) != 2 || strings.Join(findFile(sum.Files[Shared], "intro.html").Allowed, ",") != "ben" {
		t.Fatalf("with the party: %+v", sum.Players)
	}
	if st, _ := s.GetState(d2.ID, Shared, "sheet.html", "ana"); len(st) != 0 {
		t.Fatalf("copy entries copied: %v", st)
	}
}
