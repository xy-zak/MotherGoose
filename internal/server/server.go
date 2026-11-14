// Package server exposes the MotherGoose HTTP API, the admin dashboard, the
// player shell, and the WebSocket sync for game pages.
package server

import (
	"context"
	"net/http"
	"sync"
	"time"

	"mothergoose/internal/store"
)

// Server wires the store to HTTP.
type Server struct {
	store   *store.Store
	hub     *Hub
	port    int
	handler http.Handler

	// isHost decides whether a request comes from the server machine.
	// Replaceable in tests.
	isHost func(*http.Request) bool
	// openFolder shows a folder in the computer's file explorer. Replaceable
	// in tests, which mustn't open windows.
	openFolder func(string) error

	injectJS []byte

	// syncMu makes "change the store, then tell the room" one step, and
	// "snapshot the state, then join the room" another. Without it a client
	// could miss an edit made while it joined, or see broadcasts arrive in a
	// different order from the writes that caused them. Every change to a
	// page's entries, or to whether a page or copy exists, takes it: an edit
	// arriving over /ws/file is checked and stored under it too, so it can't
	// slip in between a delete and the "gone" that follows.
	syncMu sync.Mutex
	// testHookSnapshotted runs between a joining client's snapshot and its
	// join, so tests can try to slip a write into that gap. Nil in production.
	testHookSnapshotted func()

	fpMu sync.Mutex
	fp   string

	// notify gathers "changed" events for the shells and dashboards.
	notify *notifier
}

// New builds a Server; port is only used to display join URLs.
func New(st *store.Store, port int) *Server {
	js, err := pageScript()
	if err != nil {
		panic(err)
	}
	s := &Server{store: st, hub: NewHub(), port: port, isHost: isHostRequest, openFolder: OpenInOS, injectJS: js}
	s.fp = st.Fingerprint()
	s.notify = &notifier{send: s.sendChanged}
	st.OnEntriesSaved(s.notify.entriesSaved)
	s.handler = s.guard(s.routes())
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.handler.ServeHTTP(w, r) }

func (s *Server) routes() *http.ServeMux {
	m := http.NewServeMux()
	m.HandleFunc("GET /{$}", s.page("shell/index.html"))
	m.HandleFunc("GET /admin", s.hostOnly(s.page("admin/index.html")))
	m.HandleFunc("GET /admin/", s.hostOnly(s.page("admin/index.html")))
	m.HandleFunc("GET /_mg/inject.js", s.serveInject)
	m.Handle("GET /_mg/", http.StripPrefix("/_mg/", staticHandler()))

	m.HandleFunc("GET /s/{session}/{scope}/{file}", s.serveGameFile)

	m.HandleFunc("GET /api/active", s.apiActive)
	m.HandleFunc("POST /api/me", s.apiMe)
	m.HandleFunc("GET /api/info", s.hostOnly(s.apiInfo))
	m.HandleFunc("GET /api/qr.png", s.hostOnly(s.apiQR))

	m.HandleFunc("GET /api/admin/sessions", s.hostOnly(s.apiListSessions))
	m.HandleFunc("POST /api/admin/sessions", s.hostOnly(s.apiCreateSession))
	m.HandleFunc("GET /api/admin/sessions/{id}", s.hostOnly(s.apiGetSession))
	m.HandleFunc("PATCH /api/admin/sessions/{id}", s.hostOnly(s.apiUpdateSession))
	m.HandleFunc("DELETE /api/admin/sessions/{id}", s.hostOnly(s.apiDeleteSession))
	m.HandleFunc("POST /api/admin/sessions/{id}/activate", s.hostOnly(s.apiActivate))
	m.HandleFunc("DELETE /api/admin/active", s.hostOnly(s.apiDeactivate))
	m.HandleFunc("POST /api/admin/sessions/{id}/reveal", s.hostOnly(s.apiReveal))
	m.HandleFunc("POST /api/admin/data/reveal", s.hostOnly(s.apiRevealData))
	m.HandleFunc("POST /api/admin/sessions/{id}/files", s.hostOnly(s.apiUpload))
	m.HandleFunc("PUT /api/admin/sessions/{id}/order", s.hostOnly(s.apiSetOrder))
	m.HandleFunc("POST /api/admin/sessions/{id}/players", s.hostOnly(s.apiAddPlayer))
	m.HandleFunc("PATCH /api/admin/sessions/{id}/players/{player}", s.hostOnly(s.apiRenamePlayer))
	m.HandleFunc("DELETE /api/admin/sessions/{id}/players/{player}", s.hostOnly(s.apiRemovePlayer))
	m.HandleFunc("PATCH /api/admin/sessions/{id}/files/{scope}/{file}", s.hostOnly(s.apiMoveFile))
	m.HandleFunc("DELETE /api/admin/sessions/{id}/files/{scope}/{file}", s.hostOnly(s.apiDeleteFile))
	m.HandleFunc("DELETE /api/admin/sessions/{id}/files/{scope}/{file}/state", s.hostOnly(s.apiResetState))
	m.HandleFunc("PUT /api/admin/sessions/{id}/files/{scope}/{file}/meta", s.hostOnly(s.apiSetPageMeta))
	m.HandleFunc("GET /api/admin/sessions/{id}/files/{scope}/{file}/export", s.hostOnly(s.apiExport))

	m.HandleFunc("GET /ws/file", s.wsFile)
	m.HandleFunc("GET /ws/events", s.wsEvents)
	return m
}

// changed tells every open shell/admin page to refresh, within changeDelay.
// Changes made close together share one event.
func (s *Server) changed() { s.notify.within(changeDelay) }

func (s *Server) sendChanged() {
	s.fpMu.Lock()
	s.fp = s.store.Fingerprint()
	s.fpMu.Unlock()
	s.hub.Event("changed")
}

// Watch polls the data folder so files dropped in by hand show up live.
func (s *Server) Watch(ctx context.Context) {
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			fp := s.store.Fingerprint()
			s.fpMu.Lock()
			diff := fp != s.fp
			s.fp = fp
			s.fpMu.Unlock()
			if diff {
				s.changed()
			}
		}
	}
}
