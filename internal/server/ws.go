// WebSockets: /ws/file syncs one page's entries, /ws/events tells the
// dashboards that something changed. The protocol is in docs/NETWORK.md.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"

	"github.com/coder/websocket"

	"mothergoose/internal/store"
)

// requireState refuses entry operations (syncing, resetting) on pages that
// have none: images. HTML pages and PDFs both keep entries.
func requireState(w http.ResponseWriter, name string) bool {
	if k, _ := store.KindOf(name); !store.HasState(k) {
		jsonError(w, http.StatusBadRequest, fmt.Sprintf("%q is an %s: only HTML pages and PDFs have saved entries", name, k))
		return false
	}
	return true
}

type wsMsg struct {
	Type  string          `json:"type"`
	Key   string          `json:"key"`
	Value json.RawMessage `json:"value"`
	// Seq numbers a client's sets. When it is given, the server answers
	// {"type":"ack","seq":n} once the set is handled, so the client knows
	// it can stop holding on to it.
	Seq int64 `json:"seq"`
}

// fileCopy is the copy of a page that one /ws/file socket works on.
type fileCopy struct {
	id     string
	sc     store.Scope
	name   string
	asked  string // the player named in the URL
	player string // the copy that resolved to: "" is the page's own entries
	room   string
}

func (s *Server) wsFile(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	fc := fileCopy{id: q.Get("session"), name: q.Get("file"), asked: q.Get("player")}
	sc, ok := s.gameParams(w, r, fc.id, q.Get("scope"), fc.name)
	if !ok {
		return
	}
	fc.sc = sc
	if !requireState(w, fc.name) {
		return
	}
	if !s.store.Exists(fc.id, fc.sc, fc.name) {
		jsonError(w, http.StatusNotFound, "file not found")
		return
	}
	player, err := s.copyFor(r, fc.id, fc.sc, fc.name, fc.asked)
	if err != nil {
		s.accessFail(w, r, err)
		return
	}
	fc.player = player
	fc.room = playerRoomKey(fc.id, string(fc.sc), fc.name, player)

	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(store.MaxValueSize + 8192)
	c := newClient(conn)
	c.host = s.isHost(r)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if !s.joinCopy(c, fc) {
		return
	}
	defer s.hub.leave(fc.room, c)
	go c.writeLoop(ctx)

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var m wsMsg
		if json.Unmarshal(data, &m) != nil || m.Type != "set" {
			continue
		}
		if !s.handleSet(r, c, fc, m) {
			return
		}
	}
}

// joinCopy sends the copy's entries and joins its room, as one step: an edit
// made meanwhile is either in the snapshot or broadcast to c after it.
func (s *Server) joinCopy(c *client, fc fileCopy) bool {
	s.syncMu.Lock()
	defer s.syncMu.Unlock()
	st, err := s.store.GetState(fc.id, fc.sc, fc.name, fc.player)
	if err != nil {
		log.Printf("loading %s: %v", fc.room, err)
		c.conn.Close(websocket.StatusInternalError, "could not load saved entries")
		return false
	}
	snap, _ := json.Marshal(map[string]any{"type": "snapshot", "state": st})
	c.queue(snap)
	if s.testHookSnapshotted != nil {
		s.testHookSnapshotted()
	}
	s.hub.join(fc.room, c)
	return true
}

// handleSet stores one edit, passes it on to the room and acknowledges it.
// It returns false when the socket has been closed: the page or copy is no
// longer this device's to write to.
func (s *Server) handleSet(r *http.Request, c *client, fc fileCopy, m wsMsg) bool {
	if !s.canView(r, fc.id, fc.sc) {
		c.close(websocket.StatusPolicyViolation, "session is no longer live")
		return false
	}
	s.syncMu.Lock()
	// The page may have been switched to or from per-player, or the
	// player taken off the roster, since this socket opened. Checked under
	// syncMu so a removal can't slip in between the check and the write.
	if now, err := s.copyFor(r, fc.id, fc.sc, fc.name, fc.asked); err != nil || now != fc.player {
		s.syncMu.Unlock()
		c.close(websocket.StatusPolicyViolation, "this copy of the page is no longer available")
		return false
	}
	err := s.store.SetValue(fc.id, fc.sc, fc.name, fc.player, m.Key, m.Value)
	if err == nil {
		s.hub.toRoom(fc.room, map[string]any{"type": "set", "key": m.Key, "value": m.Value}, c)
	}
	s.syncMu.Unlock()
	if errors.Is(err, store.ErrNotFound) {
		c.close(websocket.StatusPolicyViolation, "this page is no longer available")
		return false
	}
	if err != nil {
		log.Printf("rejected value for %s %q: %v", fc.room, m.Key, err)
	}
	// Rejected values are acknowledged too: sending them again wouldn't help.
	if m.Seq != 0 {
		ack, _ := json.Marshal(map[string]any{"type": "ack", "seq": m.Seq})
		c.queue(ack)
	}
	return true
}

func (s *Server) wsEvents(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(4096)
	c := newClient(conn)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.hub.addListener(c)
	defer s.hub.removeListener(c)
	go c.writeLoop(ctx)
	for {
		if _, _, err := conn.Read(ctx); err != nil {
			return
		}
	}
}
