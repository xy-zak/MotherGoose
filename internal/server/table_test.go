package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"mothergoose/internal/store"
)

// The referee's dashboard hears which players' devices are connected, by
// the name each one picked; the host's own views don't count.
func TestPresence(t *testing.T) {
	f := setup(t)
	f.st.AddPlayer(f.id, "Ana")
	f.srv.isHost = testIsHost
	ts := httptest.NewServer(f.srv)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws/events"
	ref, _, err := dialAs(ctx, t, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ref.CloseNow()
	next := func() map[string]any {
		for {
			if m := readMsg(ctx, t, ref); m["type"] == "presence" {
				return m
			}
		}
	}
	if m := next(); m["unnamed"] != 0.0 || len(m["players"].(map[string]any)) != 0 {
		t.Fatalf("empty table: %v", m)
	}
	a1, _, _ := dialAs(ctx, t, url, whoCookieFor(f.id, "ana"))
	m := next()
	a2, _, _ := dialAs(ctx, t, url, whoCookieFor(f.id, "ana"))
	m = next()
	if m["players"].(map[string]any)["ana"] != 2.0 {
		t.Fatalf("two devices as Ana: %v", m)
	}
	x, _, _ := dialAs(ctx, t, url, &http.Cookie{Name: "other", Value: "1"})
	if m = next(); m["unnamed"] != 1.0 {
		t.Fatalf("a device with no name: %v", m)
	}
	a1.Close(websocket.StatusNormalClosure, "")
	if m = next(); m["players"].(map[string]any)["ana"] != 1.0 {
		t.Fatalf("after one left: %v", m)
	}
	a2.CloseNow()
	x.CloseNow()
	ref.CloseNow()
	// Let the closing handlers finish (each sends presence, which reads
	// session.json) before the test's folder is removed.
	for i := 0; i < 100; i++ {
		f.srv.hub.mu.Lock()
		n := len(f.srv.hub.events)
		f.srv.hub.mu.Unlock()
		if n == 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)
}

// ?as= lets the host see exactly what a player's device gets.
func TestViewAs(t *testing.T) {
	f := setup(t)
	f.st.AddPlayer(f.id, "Ana")
	f.st.AddPlayer(f.id, "Ben")
	f.st.SaveFile(f.id, store.Shared, "clue.html", strings.NewReader("<p>clue"))
	f.setVis(t, "clue.html", `{"audience":"only","allowed":["ben"]}`)
	f.st.SaveFile(f.id, store.Shared, "draft.html", strings.NewReader("<p>draft"))
	f.setVis(t, "draft.html", `{"hidden":true}`)
	names := func(q string, edit func(*http.Request)) string {
		rec := f.request("GET", "/api/active"+q, "", edit)
		var resp struct {
			Files  []store.FileInfo `json:"files"`
			ViewAs *string          `json:"viewAs"`
		}
		json.Unmarshal(rec.Body.Bytes(), &resp)
		var out []string
		for _, fi := range resp.Files {
			out = append(out, fi.Scope.Label()+":"+fi.Name)
		}
		return strings.Join(out, ",")
	}
	if got := names("", nil); !strings.Contains(got, "referee:secrets.html") || !strings.Contains(got, "draft.html") {
		t.Fatalf("host: %s", got)
	}
	if got, want := names("?as=ana", nil), "players:sheet.html"; got != want {
		t.Errorf("as Ana: %s, want %s", got, want)
	}
	if got, want := names("?as=ben", nil), "players:clue.html,players:sheet.html"; got != want {
		t.Errorf("as Ben: %s, want %s", got, want)
	}
	if got, want := names("?as=", nil), "players:sheet.html"; got != want {
		t.Errorf("as nobody: %s, want %s", got, want)
	}
	// A player can't use it to see more.
	if got := names("?as=ben", withCookie(whoCookieFor(f.id, "ana"))); strings.Contains(got, "clue") {
		t.Errorf("a player previewed as someone else: %s", got)
	}
}

// While a campaign is live, players' pages that arrive (uploaded, moved
// over, added from the ready-made pages) start hidden; replaced files say so.
func TestLiveArrivalsStartHidden(t *testing.T) {
	f := setup(t)
	res := f.uploadFiles(t, "shared", map[string]string{"new.html": "<p>new", "sheet.html": "<p>replaced"})
	if h := res["hidden"].([]any); len(h) != 1 || h[0] != "new.html" {
		t.Errorf("hidden: %v", res["hidden"])
	}
	if r := res["replaced"].([]any); len(r) != 1 || r[0] != "sheet.html" {
		t.Errorf("replaced: %v", res["replaced"])
	}
	rec := f.request("PATCH", "/api/admin/sessions/"+f.id+"/files/gm/secrets.html", `{"scope":"shared"}`, nil)
	if !strings.Contains(rec.Body.String(), `"hidden":true`) {
		t.Errorf("moved over while live: %s", rec.Body.String())
	}
	rec = f.request("POST", "/api/admin/sessions/"+f.id+"/templates", `{"template":"notes.html"}`, nil)
	if !strings.Contains(rec.Body.String(), `"hidden":true`) {
		t.Errorf("ready-made page while live: %s", rec.Body.String())
	}
	// Not live: they arrive shown.
	f.st.SetActive("")
	res = f.uploadFiles(t, "shared", map[string]string{"later.html": "<p>later"})
	if h := res["hidden"].([]any); len(h) != 0 {
		t.Errorf("hidden while not live: %v", h)
	}
}

// Hiding survives a trip to the referee's side and back.
func TestVisibilityKeptAcrossMoves(t *testing.T) {
	f := setup(t)
	f.st.SetActive("")
	f.st.AddPlayer(f.id, "Cass")
	f.setVis(t, "sheet.html", `{"audience":"only","allowed":["cass"]}`)
	f.request("PATCH", "/api/admin/sessions/"+f.id+"/files/shared/sheet.html", `{"scope":"gm"}`, nil)
	f.request("PATCH", "/api/admin/sessions/"+f.id+"/files/gm/sheet.html", `{"scope":"shared"}`, nil)
	sum, _ := f.st.GetSession(f.id)
	for _, fi := range sum.Files[store.Shared] {
		if fi.Name == "sheet.html" && (fi.Audience != store.AudienceOnly || len(fi.Allowed) != 1) {
			t.Errorf("after a round trip: %+v", fi)
		}
	}
}

// A page's details can rename it and set its title in one request; a
// second copy of a template gets a title of its own.
func TestRenameAndTitleTogether(t *testing.T) {
	f := setup(t)
	rec := f.request("PUT", "/api/admin/sessions/"+f.id+"/files/shared/sheet.html/meta", `{"name":"aria.html","title":"Aria's sheet","description":"hers"}`, nil)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"name":"aria.html"`) {
		t.Fatalf("rename and details: %d %s", rec.Code, rec.Body.String())
	}
	sum, _ := f.st.GetSession(f.id)
	got := sum.Files[store.Shared][0]
	if got.Name != "aria.html" || got.Title != "Aria's sheet" || got.DocTitle == "Aria's sheet" || got.Description != "hers" {
		t.Fatalf("after: %+v", got)
	}
	// A clash fails before anything changes.
	f.st.SaveFile(f.id, store.Shared, "taken.html", strings.NewReader("<p>x"))
	if rec := f.request("PUT", "/api/admin/sessions/"+f.id+"/files/shared/aria.html/meta", `{"name":"taken.html","description":"no"}`, nil); rec.Code != 409 {
		t.Errorf("clash: %d", rec.Code)
	}
	f.st.SetActive("")
	f.request("POST", "/api/admin/sessions/"+f.id+"/templates", `{"template":"notes.html"}`, nil)
	f.request("POST", "/api/admin/sessions/"+f.id+"/templates", `{"template":"notes.html"}`, nil)
	sum, _ = f.st.GetSession(f.id)
	titles := map[string]string{}
	for _, fi := range sum.Files[store.Shared] {
		titles[fi.Name] = fi.Title
	}
	if titles["notes.html"] != "Notes" || titles["notes-2.html"] != "Notes 2" {
		t.Errorf("template titles: %v", titles)
	}
}
