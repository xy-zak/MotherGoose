package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"mothergoose/internal/store"
)

type fixture struct {
	st  *store.Store
	srv *Server
	id  string
}

func setup(t *testing.T) *fixture {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	sess, _ := st.CreateSession("Night Market", "")
	st.SaveFile(sess.ID, store.Shared, "sheet.html", strings.NewReader("<html><body><textarea id=notes></textarea></BODY></html>"))
	st.SaveFile(sess.ID, store.GM, "secrets.html", strings.NewReader("<p>the duke is a lich"))
	st.SetActive(sess.ID)
	return &fixture{st: st, srv: New(st, 8080), id: sess.ID}
}

func (f *fixture) do(method, path, remote string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	req.Host = "localhost:8080"
	req.RemoteAddr = remote
	rec := httptest.NewRecorder()
	f.srv.ServeHTTP(rec, req)
	return rec
}

const (
	host   = "127.0.0.1:50000"
	player = "192.0.2.50:50000" // TEST-NET address: never one of ours
)

func TestAccessControl(t *testing.T) {
	f := setup(t)
	cases := []struct {
		path, remote string
		want         int
	}{
		{"/admin", host, 200},
		{"/admin", player, 403},
		{"/api/admin/sessions", player, 403},
		{"/api/info", player, 403},
		{"/s/" + f.id + "/gm/secrets.html", player, 403},
		{"/s/" + f.id + "/gm/secrets.html", host, 200},
		{"/s/" + f.id + "/shared/sheet.html", player, 200},
		{"/s/" + f.id + "/shared/missing.html", player, 404},
		{"/ws/file?session=" + f.id + "&scope=gm&file=secrets.html", player, 403},
		{"/", player, 200},
		{"/_mg/inject.js", player, 200},
	}
	for _, c := range cases {
		if got := f.do("GET", c.path, c.remote).Code; got != c.want {
			t.Errorf("GET %s from %s = %d, want %d", c.path, c.remote, got, c.want)
		}
	}

	// Players only see the GM's files list without GM entries.
	var active struct {
		IsHost bool             `json:"isHost"`
		Files  []store.FileInfo `json:"files"`
	}
	json.Unmarshal(f.do("GET", "/api/active", player).Body.Bytes(), &active)
	if active.IsHost || len(active.Files) != 1 || active.Files[0].Scope != store.Shared {
		t.Fatalf("player /api/active = %+v", active)
	}
	json.Unmarshal(f.do("GET", "/api/active", host).Body.Bytes(), &active)
	if !active.IsHost || len(active.Files) != 2 {
		t.Fatalf("host /api/active = %+v", active)
	}

	// Shared files of a session that is not live are hidden from players.
	f.st.SetActive("")
	if got := f.do("GET", "/s/"+f.id+"/shared/sheet.html", player).Code; got != 403 {
		t.Errorf("inactive shared file = %d, want 403", got)
	}
}

func TestInjection(t *testing.T) {
	f := setup(t)
	f.st.SetValue(f.id, store.Shared, "sheet.html", "", "#notes", json.RawMessage(`"</script><script>alert(1)</script>"`))
	body := f.do("GET", "/s/"+f.id+"/shared/sheet.html", player).Body.String()
	i := strings.Index(body, `<script src="/_mg/inject.js"`)
	j := strings.LastIndex(body, "</BODY>")
	if i < 0 || j < 0 || i > j {
		t.Fatalf("inject tag not before </body>:\n%s", body)
	}
	if strings.Contains(body, "<script>alert(1)") {
		t.Fatal("state value broke out of the JSON block")
	}
	if !strings.Contains(body, `</script>`) {
		t.Fatalf("state not embedded:\n%s", body)
	}

	// No </body>: appended at the end.
	gm := f.do("GET", "/s/"+f.id+"/gm/secrets.html", host).Body.String()
	if !strings.HasPrefix(gm, "<p>the duke is a lich\n") || !strings.Contains(gm, "inject.js") {
		t.Fatalf("append failed:\n%s", gm)
	}

	// Export inlines the script and carries no server binding.
	exp := f.do("GET", "/api/admin/sessions/"+f.id+"/files/shared/sheet.html/export", host)
	if !strings.Contains(exp.Header().Get("Content-Disposition"), "sheet-filled.html") {
		t.Errorf("disposition = %q", exp.Header().Get("Content-Disposition"))
	}
	if strings.Contains(exp.Body.String(), "data-mg-session") || !strings.Contains(exp.Body.String(), "window.MotherGoose") {
		t.Error("export should inline inject.js without session binding")
	}
}

func TestLiveSync(t *testing.T) {
	f := setup(t)
	ts := httptest.NewServer(f.srv)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws/file?session=" + f.id + "&scope=shared&file=sheet.html"

	dial := func() *websocket.Conn {
		c, _, err := websocket.Dial(ctx, url, nil)
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	read := func(c *websocket.Conn) map[string]any {
		_, b, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		json.Unmarshal(b, &m)
		return m
	}

	a, b := dial(), dial()
	defer a.CloseNow()
	defer b.CloseNow()
	if m := read(a); m["type"] != "snapshot" {
		t.Fatalf("a got %v", m)
	}
	if m := read(b); m["type"] != "snapshot" {
		t.Fatalf("b got %v", m)
	}

	a.Write(ctx, websocket.MessageText, []byte(`{"type":"set","key":"#notes","value":"rolled a 20"}`))
	if m := read(b); m["type"] != "set" || m["key"] != "#notes" || m["value"] != "rolled a 20" {
		t.Fatalf("b got %v", m)
	}

	// A new client gets it in its snapshot.
	c := dial()
	defer c.CloseNow()
	m := read(c)
	if st, _ := m["state"].(map[string]any); st["#notes"] != "rolled a 20" {
		t.Fatalf("snapshot = %v", m)
	}
}

func TestPlayerCannotSyncGMFile(t *testing.T) {
	f := setup(t)
	f.srv.isHost = func(*http.Request) bool { return false }
	ts := httptest.NewServer(f.srv)
	defer ts.Close()
	_, resp, err := websocket.Dial(context.Background(),
		"ws"+strings.TrimPrefix(ts.URL, "http")+"/ws/file?session="+f.id+"&scope=gm&file=secrets.html", nil)
	if err == nil || resp == nil || resp.StatusCode != 403 {
		t.Fatalf("err=%v resp=%v", err, resp)
	}
}

func TestUpload(t *testing.T) {
	f := setup(t)
	body := strings.NewReader("--x\r\nContent-Disposition: form-data; name=\"scope\"\r\n\r\ngm\r\n" +
		"--x\r\nContent-Disposition: form-data; name=\"files\"; filename=\"map.html\"\r\nContent-Type: text/html\r\n\r\n<h1>map</h1>\r\n" +
		"--x\r\nContent-Disposition: form-data; name=\"files\"; filename=\"bad.txt\"\r\n\r\nnope\r\n--x--\r\n")
	req := httptest.NewRequest("POST", "/api/admin/sessions/"+f.id+"/files", body)
	req.Header.Set("Content-Type", "multipart/form-data; boundary=x")
	req.Host = "localhost:8080"
	req.RemoteAddr = host
	rec := httptest.NewRecorder()
	f.srv.ServeHTTP(rec, req)
	var res struct {
		Saved  []string `json:"saved"`
		Errors []string `json:"errors"`
	}
	json.NewDecoder(rec.Body).Decode(&res)
	if rec.Code != 200 || len(res.Saved) != 1 || len(res.Errors) != 1 {
		t.Fatalf("code=%d res=%+v", rec.Code, res)
	}
	b, _ := f.st.ReadFile(f.id, store.GM, "map.html")
	if string(b) != "<h1>map</h1>" {
		t.Fatalf("stored %q", b)
	}
}

// A write that lands while a client is joining (after its snapshot was taken,
// before it is in the room) must still reach that client.
func TestJoinDuringWriteMissesNothing(t *testing.T) {
	f := setup(t)
	var joins atomic.Int32
	snapshotted := make(chan struct{}, 1)
	f.srv.testHookSnapshotted = func() {
		if joins.Add(1) == 2 { // the second client to connect
			snapshotted <- struct{}{}
			time.Sleep(100 * time.Millisecond) // the writer's edit is sent during this pause
		}
	}
	ts := httptest.NewServer(f.srv)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws/file?session=" + f.id + "&scope=shared&file=sheet.html"

	writer, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.CloseNow()
	writer.Read(ctx) // its snapshot

	joined := make(chan *websocket.Conn, 1)
	go func() {
		c, _, err := websocket.Dial(ctx, url, nil)
		if err != nil {
			t.Error(err)
		}
		joined <- c
	}()
	<-snapshotted
	writer.Write(ctx, websocket.MessageText, []byte(`{"type":"set","key":"#notes","value":"crit!"}`))
	c := <-joined
	if c == nil {
		t.FailNow()
	}
	defer c.CloseNow()

	// Apply messages in order, as inject.js does, until the value is current.
	rctx, rcancel := context.WithTimeout(ctx, time.Second)
	defer rcancel()
	var have string
	for have != `"crit!"` {
		_, b, err := c.Read(rctx)
		if err != nil {
			t.Fatalf("joining client never saw the edit (has %s): %v", have, err)
		}
		var m struct {
			Type  string                     `json:"type"`
			Key   string                     `json:"key"`
			Value json.RawMessage            `json:"value"`
			State map[string]json.RawMessage `json:"state"`
		}
		json.Unmarshal(b, &m)
		switch {
		case m.Type == "snapshot":
			have = string(m.State["#notes"])
		case m.Type == "set" && m.Key == "#notes":
			have = string(m.Value)
		}
	}
}
