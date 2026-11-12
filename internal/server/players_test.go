package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"mothergoose/internal/store"
)

// perPlayer makes sheet.html per-player, with Ana and Ben on the roster.
func (f *fixture) perPlayer(t *testing.T) {
	t.Helper()
	f.st.AddPlayer(f.id, "Ana")
	f.st.AddPlayer(f.id, "Ben")
	on := true
	if _, _, err := f.st.UpdatePageMeta(f.id, store.Shared, "sheet.html", store.PageMeta{}, &on); err != nil {
		t.Fatal(err)
	}
}

// whoCookieFor is the cookie of a device that picked player in the session.
func whoCookieFor(session, player string) *http.Cookie {
	b, _ := json.Marshal(map[string]string{session: player})
	return &http.Cookie{Name: whoCookie, Value: base64.RawURLEncoding.EncodeToString(b)}
}

func withCookie(c *http.Cookie) func(*http.Request) {
	return func(r *http.Request) {
		r.RemoteAddr = player
		if c != nil {
			r.AddCookie(c)
		}
	}
}

func TestPickingAName(t *testing.T) {
	f := setup(t)
	f.perPlayer(t)
	me := func(body string, c *http.Cookie) *httptest.ResponseRecorder {
		return f.request("POST", "/api/me", body, withCookie(c))
	}

	rec := me(`{"player":"ana"}`, nil)
	if rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"me":"ana"}` {
		t.Fatalf("pick: %d %s", rec.Code, rec.Body.String())
	}
	sc := rec.Result().Cookies()
	if len(sc) != 1 || sc[0].Name != whoCookie || !sc[0].HttpOnly || sc[0].SameSite != http.SameSiteStrictMode ||
		sc[0].Path != "/" || sc[0].MaxAge != 31536000 {
		t.Fatalf("cookie = %+v", sc)
	}
	cookie := sc[0]

	var active struct {
		Me      *string        `json:"me"`
		Players []store.Player `json:"players"`
		Files   []map[string]any
	}
	json.Unmarshal(f.request("GET", "/api/active", "", withCookie(cookie)).Body.Bytes(), &active)
	if active.Me == nil || *active.Me != "ana" || len(active.Players) != 2 || active.Players[1].Name != "Ben" {
		t.Fatalf("active = %+v", active)
	}
	if active.Files[0]["perPlayer"] != true || active.Files[0]["playerState"] != nil {
		t.Fatalf("active files = %+v", active.Files)
	}

	// Other sessions' picks in the cookie are kept.
	other, _ := f.st.CreateSession("Other", "")
	two := map[string]string{other.ID: "zed", f.id: "ben"}
	b, _ := json.Marshal(two)
	rec = me(`{"player":"ana"}`, &http.Cookie{Name: whoCookie, Value: base64.RawURLEncoding.EncodeToString(b)})
	b, _ = base64.RawURLEncoding.DecodeString(rec.Result().Cookies()[0].Value)
	if !strings.Contains(string(b), `"zed"`) || !strings.Contains(string(b), `"ana"`) {
		t.Fatalf("cookie lost another session: %s", b)
	}

	// Errors.
	if rec := me(`{"player":"nobody"}`, nil); rec.Code != 400 {
		t.Errorf("unknown player = %d", rec.Code)
	}
	if rec := me(`{}`, nil); rec.Code != 400 {
		t.Errorf("no player field = %d", rec.Code)
	}
	if rec := me(`{"player":7}`, nil); rec.Code != 400 {
		t.Errorf("number = %d", rec.Code)
	}

	// Clearing the only pick deletes the cookie.
	rec = me(`{"player":null}`, cookie)
	if rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"me":null}` || rec.Result().Cookies()[0].MaxAge >= 0 {
		t.Fatalf("clear: %d %s %+v", rec.Code, rec.Body.String(), rec.Result().Cookies())
	}

	f.st.SetActive("")
	if rec := me(`{"player":"ana"}`, nil); rec.Code != 409 {
		t.Errorf("no live session = %d", rec.Code)
	}
}

func TestTamperedCookieIsIgnored(t *testing.T) {
	f := setup(t)
	f.perPlayer(t)
	enc := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	for _, v := range []string{
		"garbage!!", enc("not json"), enc(`["ana"]`), enc(`{"` + f.id + `":"../../etc"}`),
		enc(`{"` + f.id + `":"ghost"}`), enc(`{"` + f.id + `":7}`), enc(`null`),
	} {
		c := &http.Cookie{Name: whoCookie, Value: v}
		rec := f.request("GET", "/api/active", "", withCookie(c))
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"me":null`) {
			t.Errorf("cookie %q: %d %s", v, rec.Code, rec.Body.String())
		}
		if got := f.request("GET", "/s/"+f.id+"/shared/sheet.html?player=ana", "", withCookie(c)).Code; got != 403 {
			t.Errorf("cookie %q opened Ana's copy: %d", v, got)
		}
		// Picking a name over a broken cookie replaces it.
		if rec := f.request("POST", "/api/me", `{"player":"ben"}`, withCookie(c)); rec.Code != 200 {
			t.Errorf("cookie %q: pick = %d", v, rec.Code)
		}
	}
	// A player taken off the roster is no longer anyone's "me".
	f.st.RemovePlayer(f.id, "ana", false)
	if body := f.request("GET", "/api/active", "", withCookie(whoCookieFor(f.id, "ana"))).Body.String(); !strings.Contains(body, `"me":null`) {
		t.Fatalf("removed player still me: %s", body)
	}
}

func TestPerPlayerAccess(t *testing.T) {
	f := setup(t)
	f.perPlayer(t)
	f.st.SetValue(f.id, store.Shared, "sheet.html", "", "#notes", json.RawMessage(`"template"`))
	f.st.SetValue(f.id, store.Shared, "sheet.html", "ana", "#notes", json.RawMessage(`"ana's"`))
	f.st.SaveFile(f.id, store.Shared, "rules.pdf", strings.NewReader(tinyPDF))
	on := true
	f.st.UpdatePageMeta(f.id, store.Shared, "rules.pdf", store.PageMeta{}, &on)
	ana := whoCookieFor(f.id, "ana")
	hostReq := func(r *http.Request) {}

	cases := []struct {
		who      string
		edit     func(*http.Request)
		query    string
		want     int
		contains string
	}{
		{"host", hostReq, "", 200, `"template"`},
		{"host", hostReq, "?player=ana", 200, `"ana's"`},
		{"host", hostReq, "?player=ben", 200, `"template"`}, // Ben hasn't written: his copy is the template's
		{"host", hostReq, "?player=ghost", 404, ""},
		{"no name", withCookie(nil), "", 403, "Pick your name first"},
		{"no name", withCookie(nil), "?player=ana", 403, "Pick your name first"},
		{"ana", withCookie(ana), "", 403, "own copy"},
		{"ana", withCookie(ana), "?player=ben", 403, "another player"},
		{"ana", withCookie(ana), "?player=ana", 200, `"ana's"`},
	}
	for _, c := range cases {
		rec := f.request("GET", "/s/"+f.id+"/shared/sheet.html"+c.query, "", c.edit)
		if rec.Code != c.want || !strings.Contains(rec.Body.String(), c.contains) {
			t.Errorf("%s GET sheet%s = %d, want %d with %q:\n%s", c.who, c.query, rec.Code, c.want, c.contains, rec.Body.String())
		}
	}

	// The copy is named in the inject tag; the template isn't.
	body := f.request("GET", "/s/"+f.id+"/shared/sheet.html?player=ana", "", withCookie(ana)).Body.String()
	if !strings.Contains(body, `data-mg-file="sheet.html" data-mg-player="ana"></script>`) {
		t.Fatalf("inject tag:\n%s", body)
	}
	if body := f.do("GET", "/s/"+f.id+"/shared/sheet.html", host).Body.String(); strings.Contains(body, "data-mg-player") {
		t.Fatal("template tagged with a player")
	}

	// Pages that aren't per-player ignore ?player=.
	off := false
	f.st.UpdatePageMeta(f.id, store.Shared, "sheet.html", store.PageMeta{}, &off)
	rec := f.request("GET", "/s/"+f.id+"/shared/sheet.html?player=ben", "", withCookie(nil))
	if rec.Code != 200 || strings.Contains(rec.Body.String(), "data-mg-player") || !strings.Contains(rec.Body.String(), `"template"`) {
		t.Fatalf("non-per-player page with ?player=: %d\n%s", rec.Code, rec.Body.String())
	}

	// A PDF's bytes are the same blank file for anyone who may see the page.
	if got := f.request("GET", "/s/"+f.id+"/shared/rules.pdf", "", withCookie(nil)).Code; got != 200 {
		t.Errorf("raw per-player pdf = %d", got)
	}
}

// testIsHost tells the host from players both for recorded requests (by
// address) and for real connections to an httptest server, which all come
// from 127.0.0.1: there, a device with a player's cookie is a player.
func testIsHost(r *http.Request) bool {
	switch r.RemoteAddr {
	case player:
		return false
	case host:
		return true
	}
	return r.Header.Get("Cookie") == ""
}

// wsURL is the /ws/file address of a page on ts.
func wsURL(ts *httptest.Server, id, scope, file, player string) string {
	u := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws/file?session=" + id + "&scope=" + scope + "&file=" + file
	if player != "" {
		u += "&player=" + player
	}
	return u
}

func dialAs(ctx context.Context, t *testing.T, url string, c *http.Cookie) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	h := http.Header{}
	if c != nil {
		h.Set("Cookie", c.String())
	}
	return websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: h})
}

func readMsg(ctx context.Context, t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	_, b, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	json.Unmarshal(b, &m)
	return m
}

func TestPerPlayerSyncIsIsolated(t *testing.T) {
	f := setup(t)
	f.perPlayer(t)
	f.st.SetValue(f.id, store.Shared, "sheet.html", "", "#notes", json.RawMessage(`"blank"`))
	f.srv.isHost = testIsHost
	ts := httptest.NewServer(f.srv)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ana, ben := whoCookieFor(f.id, "ana"), whoCookieFor(f.id, "ben")
	dial := func(player string, c *http.Cookie) *websocket.Conn {
		conn, _, err := dialAs(ctx, t, wsURL(ts, f.id, "shared", "sheet.html", player), c)
		if err != nil {
			t.Fatal(err)
		}
		if m := readMsg(ctx, t, conn); m["type"] != "snapshot" || m["state"].(map[string]any)["#notes"] != "blank" {
			t.Fatalf("%s snapshot = %v", player, m)
		}
		return conn
	}

	// A player can't open someone else's copy, or the template.
	for _, c := range []struct {
		player string
		cookie *http.Cookie
	}{{"ben", ana}, {"", ana}, {"ana", &http.Cookie{Name: "other", Value: "x"}}} {
		if _, resp, err := dialAs(ctx, t, wsURL(ts, f.id, "shared", "sheet.html", c.player), c.cookie); err == nil || resp == nil || resp.StatusCode != 403 {
			t.Errorf("ws %q as %s: err=%v resp=%v", c.player, c.cookie.Value, err, resp)
		}
	}

	a1, a2, b, ref := dial("ana", ana), dial("ana", ana), dial("ben", ben), dial("ana", nil)
	tpl := dial("", nil)
	for _, c := range []*websocket.Conn{a1, a2, b, ref, tpl} {
		defer c.CloseNow()
	}
	a1.Write(ctx, websocket.MessageText, []byte(`{"type":"set","key":"#notes","value":"ana was here"}`))
	b.Write(ctx, websocket.MessageText, []byte(`{"type":"set","key":"#notes","value":"ben was here"}`))
	for name, c := range map[string]*websocket.Conn{"ana's other device": a2, "referee on ana's copy": ref} {
		if m := readMsg(ctx, t, c); m["value"] != "ana was here" {
			t.Fatalf("%s got %v", name, m)
		}
	}
	// Ben and the template room hear nothing from Ana: the next message they
	// see is the referee's own template edit.
	tpl.Write(ctx, websocket.MessageText, []byte(`{"type":"set","key":"#hp","value":"9"}`))
	rctx, rcancel := context.WithTimeout(ctx, 200*time.Millisecond)
	defer rcancel()
	if _, msg, err := b.Read(rctx); err == nil {
		t.Fatalf("Ben's copy got %s", msg)
	}

	st := func(p string) string {
		s, _ := f.st.GetState(f.id, store.Shared, "sheet.html", p)
		return string(s["#notes"])
	}
	if st("ana") != `"ana was here"` || st("ben") != `"ben was here"` || st("") != `"blank"` {
		t.Fatalf("stored: ana=%s ben=%s template=%s", st("ana"), st("ben"), st(""))
	}
}

func TestRosterAPIAndEvents(t *testing.T) {
	f := setup(t)
	f.perPlayer(t)
	f.srv.isHost = testIsHost
	ts := httptest.NewServer(f.srv)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	base := "/api/admin/sessions/" + f.id + "/players"

	rec := f.request("POST", base, `{"name":"  Cy  "}`, nil)
	if rec.Code != 201 || !strings.Contains(rec.Body.String(), `{"id":"cy","name":"Cy"}`) {
		t.Fatalf("add: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.request("POST", base, `{"name":""}`, nil); rec.Code != 400 {
		t.Errorf("empty name = %d", rec.Code)
	}
	if rec := f.request("POST", base, `{"name":"Dee"}`, withCookie(nil)); rec.Code != 403 {
		t.Errorf("player adding = %d", rec.Code)
	}

	// Ana has her sheet open when she is renamed, then removed.
	ana := whoCookieFor(f.id, "ana")
	conn, _, err := dialAs(ctx, t, wsURL(ts, f.id, "shared", "sheet.html", "ana"), ana)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	readMsg(ctx, t, conn) // snapshot
	conn.Write(ctx, websocket.MessageText, []byte(`{"type":"set","key":"#notes","value":"mine"}`))
	time.Sleep(50 * time.Millisecond)

	rec = f.request("PATCH", base+"/ana", `{"name":"Ana B."}`, nil)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `{"id":"ana","name":"Ana B."}`) {
		t.Fatalf("rename: %d %s", rec.Code, rec.Body.String())
	}
	if m := readMsg(ctx, t, conn); m["type"] != "reload" {
		t.Fatalf("after rename got %v", m)
	}
	if rec := f.request("PATCH", base+"/ghost", `{"name":"x"}`, nil); rec.Code != 404 {
		t.Errorf("rename unknown = %d", rec.Code)
	}
	if rec := f.request("DELETE", base+"/ana?entries=maybe", "", nil); rec.Code != 400 {
		t.Errorf("bad entries = %d", rec.Code)
	}

	if rec := f.request("DELETE", base+"/ana?entries=delete", "", nil); rec.Code != 204 {
		t.Fatalf("remove: %d %s", rec.Code, rec.Body.String())
	}
	if m := readMsg(ctx, t, conn); m["type"] != "gone" {
		t.Fatalf("after removal got %v", m)
	}
	// A late edit from the removed player is refused, and doesn't bring the
	// deleted entries back.
	conn.Write(ctx, websocket.MessageText, []byte(`{"type":"set","key":"#notes","value":"too late"}`))
	if _, _, err := conn.Read(ctx); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("late edit: %v", err)
	}
	f.st.Flush()
	if _, err := os.Stat(filepath.Join(f.st.Root(), "sessions", f.id, "state", "players", "ana")); !os.IsNotExist(err) {
		t.Fatalf("deleted entries came back: %v", err)
	}
	if rec := f.request("DELETE", base+"/ana", "", nil); rec.Code != 404 {
		t.Errorf("remove twice = %d", rec.Code)
	}

	// Keep is the default.
	f.st.SetValue(f.id, store.Shared, "sheet.html", "ben", "#notes", json.RawMessage(`"ben's"`))
	if rec := f.request("DELETE", base+"/ben", "", nil); rec.Code != 204 {
		t.Fatalf("remove ben: %d", rec.Code)
	}
	if _, err := os.Stat(filepath.Join(f.st.Root(), "sessions", f.id, "state", "players", "ben", "sheet.html.json")); err != nil {
		t.Fatalf("kept entries: %v", err)
	}

	// The summary shows the roster and who has entries.
	f.request("POST", base, `{"name":"Ben"}`, nil)
	var sum struct {
		Players []store.Player `json:"players"`
		Files   map[string][]struct {
			Name        string          `json:"name"`
			PerPlayer   bool            `json:"perPlayer"`
			PlayerState map[string]bool `json:"playerState"`
		} `json:"files"`
	}
	json.Unmarshal(f.do("GET", "/api/admin/sessions/"+f.id, host).Body.Bytes(), &sum)
	sheet := sum.Files["shared"][0]
	if len(sum.Players) != 2 || !sheet.PerPlayer || !sheet.PlayerState["ben"] || sheet.PlayerState["cy"] || len(sheet.PlayerState) != 2 {
		t.Fatalf("summary = %+v", sum)
	}
	if gm := sum.Files["gm"][0]; gm.PerPlayer || gm.PlayerState != nil {
		t.Fatalf("gm file = %+v", gm)
	}
}

func TestPerPlayerSwitchAPI(t *testing.T) {
	f := setup(t)
	f.st.AddPlayer(f.id, "Ana")
	f.srv.isHost = testIsHost
	ts := httptest.NewServer(f.srv)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	meta := "/api/admin/sessions/" + f.id + "/files/shared/sheet.html/meta"
	put := func(path, body string) *httptest.ResponseRecorder { return f.request("PUT", path, body, nil) }

	// A player on the shared page is sent to reload when it becomes per-player.
	conn, _, err := dialAs(ctx, t, wsURL(ts, f.id, "shared", "sheet.html", ""), whoCookieFor(f.id, "ana"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	readMsg(ctx, t, conn)
	if rec := put(meta, `{"description":"yours","perPlayer":true}`); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"perPlayer":true`) {
		t.Fatalf("on: %d %s", rec.Code, rec.Body.String())
	}
	if m := readMsg(ctx, t, conn); m["type"] != "reload" {
		t.Fatalf("got %v", m)
	}
	// Its socket to the template no longer accepts edits.
	conn.Write(ctx, websocket.MessageText, []byte(`{"type":"set","key":"#notes","value":"x"}`))
	if _, _, err := conn.Read(ctx); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("template edit after switch: %v", err)
	}

	// Omitting perPlayer leaves it; only players' HTML and PDF pages qualify.
	put(meta, `{"description":"still yours"}`)
	if sum, _ := f.st.GetSession(f.id); !sum.Files[store.Shared][0].PerPlayer {
		t.Fatal("perPlayer dropped by a details edit")
	}
	if rec := put("/api/admin/sessions/"+f.id+"/files/gm/secrets.html/meta", `{"perPlayer":true}`); rec.Code != 400 {
		t.Errorf("gm per-player = %d", rec.Code)
	}

	// Export and reset of one copy.
	f.st.SetValue(f.id, store.Shared, "sheet.html", "ana", "#notes", json.RawMessage(`"ana's"`))
	exp := f.do("GET", "/api/admin/sessions/"+f.id+"/files/shared/sheet.html/export?player=ana", host)
	if !strings.Contains(exp.Header().Get("Content-Disposition"), `"sheet-ana-filled.html"`) || !strings.Contains(exp.Body.String(), "ana's") {
		t.Fatalf("export: %v", exp.Header())
	}
	if got := f.do("GET", "/api/admin/sessions/"+f.id+"/files/shared/sheet.html/export?player=ghost", host).Code; got != 404 {
		t.Errorf("export unknown player = %d", got)
	}
	if got := f.do("DELETE", "/api/admin/sessions/"+f.id+"/files/shared/sheet.html/state?player=ghost", host).Code; got != 404 {
		t.Errorf("reset unknown player = %d", got)
	}
	f.st.SetValue(f.id, store.Shared, "sheet.html", "", "#notes", json.RawMessage(`"template"`))
	if got := f.do("DELETE", "/api/admin/sessions/"+f.id+"/files/shared/sheet.html/state?player=ana", host).Code; got != 204 {
		t.Fatalf("reset copy = %d", got)
	}
	if st, _ := f.st.GetState(f.id, store.Shared, "sheet.html", ""); string(st["#notes"]) != `"template"` {
		t.Fatal("resetting a copy touched the template")
	}

	// Switching off keeps Ana's copy for later.
	f.st.SetValue(f.id, store.Shared, "sheet.html", "ana", "#notes", json.RawMessage(`"ana's"`))
	f.st.Flush()
	put(meta, `{"perPlayer":false}`)
	if rec := f.request("GET", "/s/"+f.id+"/shared/sheet.html?player=ana", "", withCookie(whoCookieFor(f.id, "ana"))); !strings.Contains(rec.Body.String(), `"template"`) {
		t.Fatalf("switched off, served:\n%s", rec.Body.String())
	}
	put(meta, `{"perPlayer":true}`)
	if rec := f.request("GET", "/s/"+f.id+"/shared/sheet.html?player=ana", "", withCookie(whoCookieFor(f.id, "ana"))); !strings.Contains(rec.Body.String(), `"ana's"`) {
		t.Fatalf("switched back on, served:\n%s", rec.Body.String())
	}
}
