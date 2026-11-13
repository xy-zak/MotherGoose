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

func TestSessionListAndOrder(t *testing.T) {
	f := setup(t)
	f.st.SaveFile(f.id, store.Shared, "intro.html", strings.NewReader("<p>hi"))
	if body := f.do("GET", "/api/admin/sessions", host).Body.String(); !strings.Contains(body, `"name":"Night Market"`) {
		t.Fatalf("list = %s", body)
	}

	order := "/api/admin/sessions/" + f.id + "/order"
	if rec := f.request("PUT", order, `{"scope":"shared","names":["sheet.html","intro.html"]}`, nil); rec.Code != 204 {
		t.Fatalf("order: %d %s", rec.Code, rec.Body.String())
	}
	sum, _ := f.st.GetSession(f.id)
	if got := sum.Files[store.Shared]; got[0].Name != "sheet.html" || got[1].Name != "intro.html" {
		t.Fatalf("order = %s, %s", got[0].Name, got[1].Name)
	}
	if rec := f.request("PUT", order, `{"scope":"attic","names":[]}`, nil); rec.Code != 400 {
		t.Errorf("bad scope = %d", rec.Code)
	}
}

func TestRenameMoveAndDeleteFiles(t *testing.T) {
	f := setup(t)
	f.st.SaveFile(f.id, store.Shared, "intro.html", strings.NewReader("<p>hi"))
	f.st.SetValue(f.id, store.Shared, "sheet.html", "", "#notes", json.RawMessage(`"kept"`))
	file := func(scope, name string) string {
		return "/api/admin/sessions/" + f.id + "/files/" + scope + "/" + name
	}

	if rec := f.request("PATCH", file("shared", "sheet.html"), `{"name":"notes.html"}`, nil); rec.Code != 204 {
		t.Fatalf("rename: %d %s", rec.Code, rec.Body.String())
	}
	if st, err := f.st.GetState(f.id, store.Shared, "notes.html", ""); err != nil || string(st["#notes"]) != `"kept"` {
		t.Fatalf("entries after rename: %v %v", st, err)
	}
	if rec := f.request("PATCH", file("shared", "notes.html"), `{"name":"intro.html"}`, nil); rec.Code != 409 {
		t.Errorf("rename onto another page = %d", rec.Code)
	}
	if rec := f.request("PATCH", file("shared", "notes.html"), `{"name":"notes.pdf"}`, nil); rec.Code != 400 {
		t.Errorf("rename to another kind = %d", rec.Code)
	}
	if rec := f.request("PATCH", file("shared", "notes.html"), `{"scope":"gm"}`, nil); rec.Code != 204 {
		t.Fatalf("move: %d %s", rec.Code, rec.Body.String())
	}
	if !f.st.Exists(f.id, store.GM, "notes.html") || f.st.Exists(f.id, store.Shared, "notes.html") {
		t.Fatal("move didn't move")
	}

	if rec := f.request("DELETE", file("gm", "notes.html"), "", nil); rec.Code != 204 {
		t.Fatalf("delete: %d", rec.Code)
	}
	if rec := f.request("DELETE", file("gm", "notes.html"), "", nil); rec.Code != 404 {
		t.Errorf("delete twice = %d", rec.Code)
	}
}

// Ending the session sends players away; the referee keeps the page open.
// Deleting the session sends everyone away.
func TestEndAndDeleteSession(t *testing.T) {
	f := setup(t)
	f.srv.isHost = testIsHost
	ts := httptest.NewServer(f.srv)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := wsURL(ts, f.id, "shared", "sheet.html", "")
	pl, _, err := dialAs(ctx, t, url, &http.Cookie{Name: "x", Value: "1"}) // a cookie makes it a player in testIsHost
	if err != nil {
		t.Fatal(err)
	}
	defer pl.CloseNow()
	ref, _, err := dialAs(ctx, t, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ref.CloseNow()
	readMsg(ctx, t, pl)
	readMsg(ctx, t, ref)

	if rec := f.request("DELETE", "/api/admin/active", "", nil); rec.Code != 204 {
		t.Fatalf("end: %d", rec.Code)
	}
	if m := readMsg(ctx, t, pl); m["type"] != "gone" {
		t.Fatalf("player got %v", m)
	}
	if _, _, err := pl.Read(ctx); websocket.CloseStatus(err) != websocket.StatusNormalClosure {
		t.Fatalf("player socket: %v", err)
	}
	if f.st.Active() != "" {
		t.Fatal("still live")
	}

	if rec := f.request("DELETE", "/api/admin/sessions/"+f.id, "", nil); rec.Code != 204 {
		t.Fatalf("delete: %d", rec.Code)
	}
	if m := readMsg(ctx, t, ref); m["type"] != "gone" {
		t.Fatalf("referee got %v", m)
	}
	if list, _ := f.st.ListSessions(); len(list) != 0 {
		t.Fatalf("sessions left: %v", list)
	}
}
