package server

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// client is one open WebSocket.
type client struct {
	conn *websocket.Conn
	send chan []byte
	once sync.Once
	host bool // connected from the server machine
}

func newClient(c *websocket.Conn) *client {
	return &client{conn: c, send: make(chan []byte, 256)}
}

// queue sends without blocking; a client that cannot keep up is dropped.
func (c *client) queue(msg []byte) {
	select {
	case c.send <- msg:
	default:
		c.close(websocket.StatusPolicyViolation, "too slow")
	}
}

func (c *client) close(code websocket.StatusCode, reason string) {
	c.once.Do(func() { go c.conn.Close(code, reason) })
}

// heartbeatEvery is how often an idle socket hears from the server. The
// WebSocket ping checks the connection from this end; the {"type":"ping"}
// message lets the browser check it from its end, since pages can't see
// WebSocket pings. Clients reconnect after about 60 s of silence.
const heartbeatEvery = 25 * time.Second

var heartbeat = []byte(`{"type":"ping"}`)

// writeLoop drains the send queue and keeps the connection alive.
func (c *client) writeLoop(ctx context.Context) {
	ping := time.NewTicker(heartbeatEvery)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-c.send:
			wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := c.conn.Write(wctx, websocket.MessageText, msg)
			cancel()
			if err != nil {
				c.close(websocket.StatusGoingAway, "write failed")
				return
			}
		case <-ping.C:
			pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := c.conn.Write(pctx, websocket.MessageText, heartbeat)
			if err == nil {
				err = c.conn.Ping(pctx)
			}
			cancel()
			if err != nil {
				c.close(websocket.StatusGoingAway, "ping failed")
				return
			}
		}
	}
}

// Hub fans messages out to the clients of a file ("room") and to every
// shell/admin page listening for events.
type Hub struct {
	mu     sync.Mutex
	rooms  map[string]map[*client]struct{}
	events map[*client]struct{}
}

func NewHub() *Hub {
	return &Hub{rooms: map[string]map[*client]struct{}{}, events: map[*client]struct{}{}}
}

func roomKey(session, scope, file string) string { return session + "/" + scope + "/" + file }

// playerRoomKey is the room of one player's copy of a per-player page
// (player "" is the page's own room). File names can't contain "/", so the
// rooms of one file are exactly its own key and the keys under key + "/".
func playerRoomKey(session, scope, file, player string) string {
	k := roomKey(session, scope, file)
	if player != "" {
		k += "/" + player
	}
	return k
}

// toFile sends msg to everyone viewing a file, whichever copy of it.
func (h *Hub) toFile(session, scope, file string, msg any) {
	base := roomKey(session, scope, file)
	h.toRooms(func(k string) bool { return k == base || strings.HasPrefix(k, base+"/") }, msg)
}

// toPlayer sends msg to everyone viewing one player's copies in a session.
func (h *Hub) toPlayer(session, player string, msg any) {
	h.toRooms(func(k string) bool {
		rest, ok := strings.CutPrefix(k, session+"/")
		parts := strings.Split(rest, "/")
		return ok && len(parts) == 3 && parts[2] == player
	}, msg)
}

func (h *Hub) join(room string, c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.rooms[room] == nil {
		h.rooms[room] = map[*client]struct{}{}
	}
	h.rooms[room][c] = struct{}{}
}

func (h *Hub) leave(room string, c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.rooms[room], c)
	if len(h.rooms[room]) == 0 {
		delete(h.rooms, room)
	}
}

// toRoom sends msg to everyone in a room except one client.
func (h *Hub) toRoom(room string, msg any, except *client) {
	b, _ := json.Marshal(msg)
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.rooms[room] {
		if c != except {
			c.queue(b)
		}
	}
}

// toRoomsWithPrefix sends msg to every room whose key starts with prefix.
func (h *Hub) toRoomsWithPrefix(prefix string, msg any) {
	h.toRooms(func(k string) bool { return strings.HasPrefix(k, prefix) }, msg)
}

// toRooms sends msg to every room whose key matches.
func (h *Hub) toRooms(match func(string) bool, msg any) {
	b, _ := json.Marshal(msg)
	h.mu.Lock()
	defer h.mu.Unlock()
	for k, cs := range h.rooms {
		if match(k) {
			for c := range cs {
				c.queue(b)
			}
		}
	}
}

// kickPlayers tells non-host clients in matching rooms that the page is gone.
func (h *Hub) kickPlayers(prefix string) {
	b, _ := json.Marshal(map[string]string{"type": "gone"})
	h.mu.Lock()
	defer h.mu.Unlock()
	for k, cs := range h.rooms {
		if strings.HasPrefix(k, prefix) {
			for c := range cs {
				if !c.host {
					c.queue(b)
					cc := c
					time.AfterFunc(500*time.Millisecond, func() {
						cc.close(websocket.StatusNormalClosure, "session is no longer live")
					})
				}
			}
		}
	}
}

// RoomSize is the number of clients viewing a file.
func (h *Hub) RoomSize(room string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.rooms[room])
}

func (h *Hub) addListener(c *client) {
	h.mu.Lock()
	h.events[c] = struct{}{}
	h.mu.Unlock()
}

func (h *Hub) removeListener(c *client) {
	h.mu.Lock()
	delete(h.events, c)
	h.mu.Unlock()
}

// Event is pushed to every shell and admin page.
func (h *Hub) Event(kind string) {
	b, _ := json.Marshal(map[string]string{"type": kind})
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.events {
		c.queue(b)
	}
}
