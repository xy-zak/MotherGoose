package server

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// A page that was deleted, or moved away, can't collect entries from a
// socket that was open on it: they would come back with the next page
// uploaded under that name.
func TestNoEntriesAfterDeleteOrMove(t *testing.T) {
	for _, tc := range []struct{ name, method, body string }{
		{"delete", "DELETE", ""},
		{"move", "PATCH", `{"name":"other.html"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := setup(t)
			ts := httptest.NewServer(f.srv)
			defer ts.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			c, _, err := websocket.Dial(ctx, wsURL(ts, f.id, "shared", "sheet.html", ""), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer c.CloseNow()
			readMsg(ctx, t, c) // snapshot

			if rec := f.request(tc.method, "/api/admin/sessions/"+f.id+"/files/shared/sheet.html", tc.body, nil); rec.Code != 204 {
				t.Fatalf("%s: %d %s", tc.method, rec.Code, rec.Body.String())
			}
			if m := readMsg(ctx, t, c); m["type"] != "gone" {
				t.Fatalf("got %v", m)
			}
			c.Write(ctx, websocket.MessageText, []byte(`{"type":"set","key":"#notes","value":"late","seq":1}`))
			time.Sleep(100 * time.Millisecond)
			f.st.Flush()
			if _, err := os.Stat(filepath.Join(f.st.Root(), "sessions", f.id, "state", "shared", "sheet.html.json")); !os.IsNotExist(err) {
				t.Fatalf("entries were saved for a page that is gone: %v", err)
			}
		})
	}
}
