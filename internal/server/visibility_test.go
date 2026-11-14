package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"mothergoose/internal/store"
)

// setVis changes who sees a page through the API, as the dashboard does.
func (f *fixture) setVis(t *testing.T, file, body string) {
	t.Helper()
	if rec := f.request("PUT", "/api/admin/sessions/"+f.id+"/files/shared/"+file+"/meta", body, nil); rec.Code != 200 {
		t.Fatalf("meta %s: %d %s", body, rec.Code, rec.Body.String())
	}
}

// activeNames lists the pages /api/active gives a device.
func (f *fixture) activeNames(t *testing.T, edit func(*http.Request)) []string {
	t.Helper()
	rec := f.request("GET", "/api/active", "", edit)
	var resp struct {
		Files []store.FileInfo `json:"files"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	var out []string
	for _, fi := range resp.Files {
		out = append(out, fi.Name)
		if edit != nil && (fi.Hidden || fi.Audience != "" || len(fi.Allowed) > 0) {
			t.Errorf("a player was told who sees %s: %+v", fi.Name, fi)
		}
	}
	return out
}

func has(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func TestPageVisibility(t *testing.T) {
	f := setup(t)
	f.addFiles(t) // shared/map.png
	f.st.AddPlayer(f.id, "Ana")
	f.st.AddPlayer(f.id, "Ben")
	f.st.SaveFile(f.id, store.Shared, "clue.html", strings.NewReader("<p>the key is under the mat"))
	f.st.SaveFile(f.id, store.Shared, "rules.pdf", strings.NewReader(tinyPDF))

	ana, ben := withCookie(whoCookieFor(f.id, "ana")), withCookie(whoCookieFor(f.id, "ben"))
	nobody := withCookie(nil)
	type dev struct {
		name string
		edit func(*http.Request)
	}
	devices := []dev{{"host", nil}, {"ana", ana}, {"ben", ben}, {"no pick", nobody}}

	check := func(file string, want map[string]bool) {
		t.Helper()
		for _, d := range devices {
			got := has(f.activeNames(t, d.edit), file)
			code := f.request("GET", "/s/"+f.id+"/shared/"+file, "", d.edit).Code
			if got != want[d.name] || (code == 200) != want[d.name] {
				t.Errorf("%s as %s: listed=%v status=%d, want %v", file, d.name, got, code, want[d.name])
			}
			if !want[d.name] && code != 404 {
				t.Errorf("%s as %s: refused with %d, want 404 so it can't be told apart from a missing page", file, d.name, code)
			}
		}
	}
	all := map[string]bool{"host": true, "ana": true, "ben": true, "no pick": true}
	hostOnly := map[string]bool{"host": true}
	anaOnly := map[string]bool{"host": true, "ana": true}

	for _, file := range []string{"clue.html", "map.png", "rules.pdf"} {
		check(file, all)
		f.setVis(t, file, `{"hidden":true}`)
		check(file, hostOnly)
		f.setVis(t, file, `{"hidden":false,"audience":"only","allowed":["ana"]}`)
		check(file, anaOnly)
		f.setVis(t, file, `{"allowed":[]}`)
		check(file, hostOnly) // only, with nobody: the referee alone
		f.setVis(t, file, `{"audience":"","allowed":["ben"]}`)
		check(file, all) // everyone again; the list isn't kept
	}

	// Hiding keeps the audience for when it is revealed.
	f.setVis(t, "clue.html", `{"audience":"only","allowed":["ana"]}`)
	f.setVis(t, "clue.html", `{"hidden":true}`)
	check("clue.html", hostOnly)
	f.setVis(t, "clue.html", `{"hidden":false}`)
	check("clue.html", anaOnly)

	// Bad updates are refused.
	for _, body := range []string{`{"audience":"some"}`, `{"allowed":["zed"]}`} {
		if rec := f.request("PUT", "/api/admin/sessions/"+f.id+"/files/shared/clue.html/meta", body, nil); rec.Code != 400 {
			t.Errorf("%s: %d", body, rec.Code)
		}
	}
	if rec := f.request("PUT", "/api/admin/sessions/"+f.id+"/files/gm/secrets.html/meta", `{"hidden":true}`, nil); rec.Code != 400 {
		t.Errorf("hiding a referee page: %d", rec.Code)
	}
}

func TestRevealKeepsDetails(t *testing.T) {
	f := setup(t)
	f.setVis(t, "sheet.html", `{"description":"read me","tags":["handout"]}`)
	f.setVis(t, "sheet.html", `{"hidden":true}`)
	f.setVis(t, "sheet.html", `{"hidden":false}`)
	sum, _ := f.st.GetSession(f.id)
	fi := sum.Files[store.Shared][0]
	if fi.Description != "read me" || len(fi.Tags) != 1 || fi.Hidden {
		t.Fatalf("after hide and reveal: %+v", fi)
	}
}

func TestRemovingAPlayerUnlistsThem(t *testing.T) {
	f := setup(t)
	f.st.AddPlayer(f.id, "Ana")
	f.setVis(t, "sheet.html", `{"audience":"only","allowed":["ana"]}`)
	if rec := f.request("DELETE", "/api/admin/sessions/"+f.id+"/players/ana", "", nil); rec.Code != 204 {
		t.Fatal(rec.Code)
	}
	// Ana coming back (or someone else called Ana) doesn't get it back...
	f.st.AddPlayer(f.id, "Ana")
	if has(f.activeNames(t, withCookie(whoCookieFor(f.id, "ana"))), "sheet.html") {
		t.Fatal("a re-added player still sees a page shown only to the old one")
	}
	// ...and it doesn't fall open to everyone either.
	if has(f.activeNames(t, withCookie(nil)), "sheet.html") {
		t.Fatal("removing the last allowed player showed the page to everyone")
	}
}

func TestVisibilitySockets(t *testing.T) {
	f := setup(t)
	f.st.AddPlayer(f.id, "Ana")
	f.st.AddPlayer(f.id, "Ben")
	f.srv.isHost = testIsHost
	ts := httptest.NewServer(f.srv)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ana, ben := whoCookieFor(f.id, "ana"), whoCookieFor(f.id, "ben")
	url := wsURL(ts, f.id, "shared", "sheet.html", "")
	dial := func(c *http.Cookie) *websocket.Conn {
		conn, _, err := dialAs(ctx, t, url, c)
		if err != nil {
			t.Fatal(err)
		}
		readMsg(ctx, t, conn) // snapshot
		return conn
	}
	a, b := dial(ana), dial(ben)
	defer a.CloseNow()
	defer b.CloseNow()

	// Showing it only to Ana closes Ben's socket, and leaves Ana's open.
	f.setVis(t, "sheet.html", `{"audience":"only","allowed":["ana"]}`)
	if m := readMsg(ctx, t, b); m["type"] != "gone" {
		t.Fatalf("ben got %v", m)
	}
	if _, _, err := b.Read(ctx); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("ben's socket: %v", err)
	}
	a.Write(ctx, websocket.MessageText, []byte(`{"type":"set","key":"#notes","value":"mine","seq":1}`))
	if m := readMsg(ctx, t, a); m["type"] != "ack" {
		t.Fatalf("ana got %v", m)
	}
	// Ben can't come back in.
	if _, resp, err := dialAs(ctx, t, url, ben); err == nil || resp == nil || resp.StatusCode != 404 {
		t.Fatalf("ben rejoined: err=%v resp=%v", err, resp)
	}

	// Hiding it closes Ana's too.
	f.setVis(t, "sheet.html", `{"hidden":true}`)
	if m := readMsg(ctx, t, a); m["type"] != "gone" {
		t.Fatalf("ana got %v", m)
	}
}

// A device left in the template room when the page goes per-player must not
// go on hearing the referee's template, even if it ignores the reload.
func TestSwitchToPerPlayerClosesTemplateSockets(t *testing.T) {
	f := setup(t)
	f.st.AddPlayer(f.id, "Ana")
	f.srv.isHost = testIsHost
	ts := httptest.NewServer(f.srv)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := wsURL(ts, f.id, "shared", "sheet.html", "")
	pl, _, err := dialAs(ctx, t, url, whoCookieFor(f.id, "ana"))
	if err != nil {
		t.Fatal(err)
	}
	defer pl.CloseNow()
	readMsg(ctx, t, pl)

	f.setVis(t, "sheet.html", `{"perPlayer":true}`)
	if m := readMsg(ctx, t, pl); m["type"] != "reload" {
		t.Fatalf("got %v", m)
	}
	if _, _, err := pl.Read(ctx); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("template socket still open: %v", err)
	}
}

// A player learns when a page's file changed, not when anyone's entries were
// saved: that would tell them when others type (and reload their PDFs).
func TestActiveModifiedIgnoresEntries(t *testing.T) {
	f := setup(t)
	f.perPlayer(t)
	old := time.Now().Add(-time.Hour)
	sheet := f.st.Root() + "/sessions/" + f.id + "/shared/sheet.html"
	if err := os.Chtimes(sheet, old, old); err != nil {
		t.Fatal(err)
	}
	modified := func() string {
		rec := f.request("GET", "/api/active", "", withCookie(whoCookieFor(f.id, "ana")))
		var resp struct {
			Files []struct {
				Modified string `json:"modified"`
			} `json:"files"`
		}
		json.Unmarshal(rec.Body.Bytes(), &resp)
		return resp.Files[0].Modified
	}
	before := modified()
	f.st.SetValue(f.id, store.Shared, "sheet.html", "ben", "#notes", json.RawMessage(`"typing"`))
	f.st.SetValue(f.id, store.Shared, "sheet.html", "", "#notes", json.RawMessage(`"template"`))
	f.st.Flush()
	if after := modified(); after != before {
		t.Fatalf("modified moved from %s to %s when entries were saved", before, after)
	}
}

// The per-player rule, end to end over HTTP: a player's device only ever
// gets its own copy, never another player's and never the template.
func TestPlayersOnlyGetTheirOwnCopy(t *testing.T) {
	f := setup(t)
	f.perPlayer(t)
	f.st.SetValue(f.id, store.Shared, "sheet.html", "ben", "#notes", json.RawMessage(`"ben's secret"`))
	f.st.SetValue(f.id, store.Shared, "sheet.html", "", "#notes", json.RawMessage(`"referee draft"`))
	f.st.SetValue(f.id, store.Shared, "sheet.html", "ana", "#notes", json.RawMessage(`"ana's own"`))
	ana := withCookie(whoCookieFor(f.id, "ana"))
	for _, q := range []string{"", "?player=ben", "?player=ana", "?player=zed"} {
		rec := f.request("GET", "/s/"+f.id+"/shared/sheet.html"+q, "", ana)
		body := rec.Body.String()
		if strings.Contains(body, "ben's secret") || strings.Contains(body, "referee draft") {
			t.Errorf("%q: a player got someone else's entries: %s", q, body)
		}
		if (rec.Code == 200) != (q == "?player=ana") {
			t.Errorf("%q: %d", q, rec.Code)
		}
	}
	// No pick at all: nothing.
	if rec := f.request("GET", "/s/"+f.id+"/shared/sheet.html", "", withCookie(nil)); rec.Code != 403 ||
		bytes.Contains(rec.Body.Bytes(), []byte("referee draft")) {
		t.Errorf("no pick: %d %s", rec.Code, rec.Body.String())
	}
}

// "Show to players" reaches only players' devices that can see the page,
// by the name each device had picked when it connected.
func TestShowPageReachesOnlyThoseWhoSeeIt(t *testing.T) {
	f := setup(t)
	f.st.AddPlayer(f.id, "Ana")
	f.st.AddPlayer(f.id, "Ben")
	f.srv.isHost = testIsHost
	ts := httptest.NewServer(f.srv)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	events := func(c *http.Cookie) *websocket.Conn {
		conn, _, err := dialAs(ctx, t, "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws/events", c)
		if err != nil {
			t.Fatal(err)
		}
		return conn
	}
	ana, ben, ref := events(whoCookieFor(f.id, "ana")), events(whoCookieFor(f.id, "ben")), events(nil)
	for _, c := range []*websocket.Conn{ana, ben, ref} {
		defer c.CloseNow()
	}
	// Let the listeners register before showing.
	time.Sleep(50 * time.Millisecond)
	show := func() (int, int) {
		rec := f.request("POST", "/api/admin/sessions/"+f.id+"/files/shared/sheet.html/show", "", nil)
		var r struct{ Devices int }
		json.Unmarshal(rec.Body.Bytes(), &r)
		return rec.Code, r.Devices
	}
	f.setVis(t, "sheet.html", `{"audience":"only","allowed":["ana"]}`)
	if code, n := show(); code != 200 || n != 1 {
		t.Fatalf("show: %d, %d devices", code, n)
	}
	// Ana hears "show"; Ben and the referee's dashboard don't (they may
	// hear "changed" from the visibility change, which is fine).
	for {
		m := readMsg(ctx, t, ana)
		if m["type"] == "show" {
			if m["key"] != "shared/sheet.html" {
				t.Fatalf("ana got %v", m)
			}
			break
		}
	}
	for name, c := range map[string]*websocket.Conn{"ben": ben, "referee": ref} {
		rctx, rcancel := context.WithTimeout(ctx, 300*time.Millisecond)
		for {
			_, b, err := c.Read(rctx)
			if err != nil {
				break
			}
			if strings.Contains(string(b), `"show"`) {
				t.Errorf("%s heard %s", name, b)
			}
		}
		rcancel()
	}

	f.setVis(t, "sheet.html", `{"hidden":true}`)
	if code, _ := show(); code != 409 {
		t.Errorf("showing a hidden page: %d", code)
	}
	f.st.SetActive("")
	f.setVis(t, "sheet.html", `{"hidden":false}`)
	if code, _ := show(); code != 409 {
		t.Errorf("showing while not live: %d", code)
	}
}
