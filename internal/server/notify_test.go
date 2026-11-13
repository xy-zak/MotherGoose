package server

import (
	"context"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func counting() (*notifier, *atomic.Int32) {
	var n atomic.Int32
	return &notifier{send: func() { n.Add(1) }}, &n
}

func TestNotifierGathersBursts(t *testing.T) {
	n, sent := counting()
	for i := 0; i < 10; i++ {
		n.within(30 * time.Millisecond)
	}
	time.Sleep(120 * time.Millisecond)
	if got := sent.Load(); got != 1 {
		t.Fatalf("a burst of 10 sent %d events", got)
	}
	n.within(10 * time.Millisecond)
	time.Sleep(60 * time.Millisecond)
	if got := sent.Load(); got != 2 {
		t.Fatalf("a later change: %d events in all", got)
	}
}

func TestNotifierBringsForward(t *testing.T) {
	n, sent := counting()
	n.within(300 * time.Millisecond)
	n.within(10 * time.Millisecond)
	time.Sleep(60 * time.Millisecond)
	if got := sent.Load(); got != 1 {
		t.Fatalf("the sooner request should have sent it: %d", got)
	}
	time.Sleep(350 * time.Millisecond)
	if got := sent.Load(); got != 1 {
		t.Fatalf("the replaced timer sent again: %d", got)
	}
}

func TestNotifierSpacesOutEntries(t *testing.T) {
	n, sent := counting()
	n.entriesSaved()
	time.Sleep(changeDelay + 60*time.Millisecond)
	if got := sent.Load(); got != 1 {
		t.Fatalf("first save: %d events", got)
	}
	// More typing straight away waits for entriesEvery...
	n.entriesSaved()
	time.Sleep(changeDelay + 60*time.Millisecond)
	if got := sent.Load(); got != 1 {
		t.Fatalf("second save so soon sent an event: %d", got)
	}
	// ...but a change by the referee doesn't.
	n.within(10 * time.Millisecond)
	time.Sleep(60 * time.Millisecond)
	if got := sent.Load(); got != 2 {
		t.Fatalf("a structural change waited behind the entries: %d", got)
	}
}

// A player's edit is acknowledged to them, and the dashboards hear about it
// once it's on disk, so a refetch sees it.
func TestEditsAreAckedAndAnnounced(t *testing.T) {
	f := setup(t)
	ts := httptest.NewServer(f.srv)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	events, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer events.CloseNow()
	page, _, err := websocket.Dial(ctx, wsURL(ts, f.id, "shared", "sheet.html", ""), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer page.CloseNow()
	readMsg(ctx, t, page) // snapshot

	page.Write(ctx, websocket.MessageText, []byte(`{"type":"set","key":"#notes","value":"hp 7","seq":1}`))
	if m := readMsg(ctx, t, page); m["type"] != "ack" || m["seq"] != 1.0 {
		t.Fatalf("got %v, want ack 1", m)
	}
	// A refused value is acknowledged too, or the client would resend it forever.
	page.Write(ctx, websocket.MessageText, []byte(`{"type":"set","key":"","value":1,"seq":2}`))
	if m := readMsg(ctx, t, page); m["type"] != "ack" || m["seq"] != 2.0 {
		t.Fatalf("got %v, want ack 2", m)
	}

	start := time.Now()
	if m := readMsg(ctx, t, events); m["type"] != "changed" {
		t.Fatalf("events got %v", m)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("event took %v", d)
	}
	if !strings.Contains(f.do("GET", "/api/admin/sessions/"+f.id, host).Body.String(), `"hasState":true`) {
		t.Error("the refetch after the event doesn't show the entry")
	}
}
