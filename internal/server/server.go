// Package server exposes the MotherGoose HTTP API, the admin dashboard, the
// player shell, and the WebSocket sync for game pages.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	qrcode "github.com/skip2/go-qrcode"

	"mothergoose/internal/store"
	"mothergoose/web"
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

	injectJS []byte

	// syncMu makes "change the store, then tell the room" one step, and
	// "snapshot the state, then join the room" another. Without it a client
	// could miss an edit made while it joined, or see broadcasts arrive in a
	// different order from the writes that caused them.
	syncMu sync.Mutex
	// testHookSnapshotted runs between a joining client's snapshot and its
	// join, so tests can try to slip a write into that gap. Nil in production.
	testHookSnapshotted func()

	fpMu sync.Mutex
	fp   string
}

// New builds a Server; port is only used to display join URLs.
func New(st *store.Store, port int) *Server {
	js, err := fs.ReadFile(web.FS, "inject.js")
	if err != nil {
		panic(err)
	}
	s := &Server{store: st, hub: NewHub(), port: port, isHost: isHostRequest, injectJS: js}
	s.fp = st.Fingerprint()
	s.handler = s.guard(s.routes())
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.handler.ServeHTTP(w, r) }

func (s *Server) routes() *http.ServeMux {
	m := http.NewServeMux()
	m.HandleFunc("GET /{$}", s.page("shell/index.html"))
	m.HandleFunc("GET /admin", s.hostOnly(s.page("admin/index.html")))
	m.HandleFunc("GET /admin/", s.hostOnly(s.page("admin/index.html")))
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
	m.HandleFunc("POST /api/admin/sessions/{id}/files", s.hostOnly(s.apiUpload))
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

// ---- helpers -----------------------------------------------------------------

func staticHandler() http.Handler {
	fsrv := http.FileServerFS(web.FS)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Fonts never change, and vendored libraries carry their version in the path.
		if strings.HasPrefix(r.URL.Path, "fonts/") || strings.HasPrefix(r.URL.Path, "vendor/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		if strings.HasSuffix(r.URL.Path, ".mjs") {
			// Module scripts and workers refuse any other type, and Windows'
			// registry doesn't always know .mjs.
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		}
		fsrv.ServeHTTP(w, r)
	})
}

func (s *Server) page(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		b, err := fs.ReadFile(web.FS, name)
		if err != nil {
			http.Error(w, "missing page", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(b)
	}
}

const forbiddenPage = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MotherGoose</title><link rel="stylesheet" href="/_mg/theme.css"><script src="/_mg/prefs.js"></script>
<body class="mg-center"><main class="mg-notice"><p class="mg-eyebrow">403 · %s</p>
<h1>%s</h1><p>%s</p><p><a class="mg-btn players" href="/">Go to the player dashboard</a></p></main></body>`

func (s *Server) forbid(w http.ResponseWriter, r *http.Request, msg string) {
	s.forbidPage(w, r, "Host only", "Not from this device", msg)
}

// forbidPage refuses with a JSON error for API calls and WebSockets, and a
// readable page for anything shown in a browser tab or frame.
func (s *Server) forbidPage(w http.ResponseWriter, r *http.Request, eyebrow, heading, msg string) {
	if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/ws/") {
		jsonError(w, http.StatusForbidden, msg)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusForbidden)
	fmt.Fprintf(w, forbiddenPage, html.EscapeString(eyebrow), html.EscapeString(heading), html.EscapeString(msg))
}

func (s *Server) hostOnly(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.isHost(r) {
			s.forbid(w, r, "The referee's dashboard only opens on the computer running MotherGoose.")
			return
		}
		h(w, r)
	}
}

// canView: the host sees everything; players see shared files of the active session.
func (s *Server) canView(r *http.Request, id string, sc store.Scope) bool {
	if s.isHost(r) {
		return true
	}
	return sc == store.Shared && id != "" && id == s.store.Active()
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func jsonError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func storeError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, store.ErrNotFound):
		status = http.StatusNotFound
	case errors.Is(err, store.ErrInvalid):
		status = http.StatusBadRequest
	case errors.Is(err, store.ErrExists):
		status = http.StatusConflict
	}
	jsonError(w, status, err.Error())
}

var errNotJSON = errors.New("expected Content-Type: application/json")

// decodeBody reads a JSON request body. Requiring the JSON content type is a
// second line of defence against cross-site requests: browsers can only send
// it from another site after a CORS preflight, which this server never grants.
func decodeBody(w http.ResponseWriter, r *http.Request, v any) error {
	if mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mt != "application/json" {
		return errNotJSON
	}
	return json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(v)
}

func bodyError(w http.ResponseWriter, err error, want string) {
	if errors.Is(err, errNotJSON) {
		jsonError(w, http.StatusUnsupportedMediaType, err.Error())
		return
	}
	jsonError(w, http.StatusBadRequest, "expected "+want)
}

// changed tells every open shell/admin page to refresh.
func (s *Server) changed() {
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
				s.hub.Event("changed")
			}
		}
	}
}

// ---- game pages -------------------------------------------------------------

// injectBefore inserts tag before the last </body>, or appends it.
func injectBefore(doc []byte, tag string) []byte {
	i := lastIndexASCIIFold(doc, "</body")
	if i < 0 {
		out := make([]byte, 0, len(doc)+len(tag)+1)
		out = append(out, doc...)
		out = append(out, '\n')
		return append(out, tag...)
	}
	out := make([]byte, 0, len(doc)+len(tag))
	out = append(out, doc[:i]...)
	out = append(out, tag...)
	return append(out, doc[i:]...)
}

// lastIndexASCIIFold finds the last case-insensitive match of an ASCII,
// lower-case needle. It compares bytes in place, so the index is always an
// offset into doc itself. (Searching a lower-cased copy is wrong: lower-casing
// can change byte lengths, e.g. "İ" or any byte that isn't valid UTF-8.)
func lastIndexASCIIFold(doc []byte, needle string) int {
	n := len(needle)
outer:
	for i := len(doc) - n; i >= 0; i-- {
		for j := 0; j < n; j++ {
			c := doc[i+j]
			if 'A' <= c && c <= 'Z' {
				c += 'a' - 'A'
			}
			if c != needle[j] {
				continue outer
			}
		}
		return i
	}
	return -1
}

func stateTag(st store.State) string {
	b, _ := json.Marshal(st) // escapes <, > and & so it cannot close the tag
	return `<script type="application/json" id="mg-state">` + string(b) + "</script>\n"
}

func (s *Server) gameParams(w http.ResponseWriter, r *http.Request, id, scope, name string) (store.Scope, bool) {
	sc, err := store.ParseScope(scope)
	if err != nil {
		storeError(w, err)
		return "", false
	}
	if !s.canView(r, id, sc) {
		if sc == store.GM {
			s.forbid(w, r, "Referee pages only open on the computer running MotherGoose.")
		} else {
			s.forbid(w, r, "This session is not live right now.")
		}
		return "", false
	}
	return sc, true
}

func (s *Server) serveGameFile(w http.ResponseWriter, r *http.Request) {
	id, name := r.PathValue("session"), r.PathValue("file")
	sc, ok := s.gameParams(w, r, id, r.PathValue("scope"), name)
	if !ok {
		return
	}
	if k, _ := store.KindOf(name); k != store.KindHTML {
		// A PDF is the same blank file for everyone: its entries come over
		// /ws/file, which is where a player's copy is checked.
		s.serveRaw(w, r, id, sc, name)
		return
	}
	player, err := s.copyFor(r, id, sc, name, r.URL.Query().Get("player"))
	if err != nil {
		s.accessFail(w, r, err)
		return
	}
	doc, err := s.store.ReadFile(id, sc, name)
	if err != nil {
		storeError(w, err)
		return
	}
	st, err := s.store.GetState(id, sc, name, player)
	if err != nil {
		storeError(w, err)
		return
	}
	attrs := fmt.Sprintf(`data-mg-session="%s" data-mg-scope="%s" data-mg-file="%s"`,
		html.EscapeString(id), html.EscapeString(string(sc)), html.EscapeString(name))
	if player != "" {
		attrs += fmt.Sprintf(` data-mg-player="%s"`, html.EscapeString(player))
	}
	tag := stateTag(st) + `<script src="/_mg/inject.js" ` + attrs + "></script>\n"
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(injectBefore(doc, tag))
}

// serveRaw sends a PDF or image as it is on disk. http.ServeContent handles
// Range requests, which the PDF viewer uses to show the first pages of a big
// file before the rest has arrived.
func (s *Server) serveRaw(w http.ResponseWriter, r *http.Request, id string, sc store.Scope, name string) {
	f, fi, err := s.store.OpenFile(id, sc, name)
	if err != nil {
		storeError(w, err)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", store.ContentType(name))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename*=UTF-8''%s`, url.PathEscape(name)))
	http.ServeContent(w, r, name, fi.ModTime(), f)
}

// requireState refuses entry operations (syncing, resetting) on pages that
// have none: images. HTML pages and PDFs both keep entries.
func requireState(w http.ResponseWriter, name string) bool {
	if k, _ := store.KindOf(name); !store.HasState(k) {
		jsonError(w, http.StatusBadRequest, fmt.Sprintf("%q is an %s: only HTML pages and PDFs have saved entries", name, k))
		return false
	}
	return true
}

// requireHTML refuses a filled export of anything but an HTML page. A filled
// PDF is written by the PDF viewer in the browser, which already has PDF.js.
func requireHTML(w http.ResponseWriter, name string) bool {
	if k, _ := store.KindOf(name); k != store.KindHTML {
		jsonError(w, http.StatusBadRequest, fmt.Sprintf("%q is a %s: only HTML pages are exported here", name, k))
		return false
	}
	return true
}

// ---- API ---------------------------------------------------------------------

func (s *Server) apiActive(w http.ResponseWriter, r *http.Request) {
	host := s.isHost(r)
	resp := map[string]any{"isHost": host, "session": nil, "files": []store.FileInfo{}, "players": []store.Player{}, "me": nil}
	if id := s.store.Active(); id != "" {
		if sum, err := s.store.GetSession(id); err == nil {
			resp["session"] = map[string]string{"id": sum.ID, "name": sum.Name, "gameType": sum.GameType}
			files := append([]store.FileInfo{}, sum.Files[store.Shared]...)
			if host {
				files = append(files, sum.Files[store.GM]...)
			}
			for i := range files {
				files[i].PlayerState = nil // who has filled in what is the referee's business
			}
			resp["files"] = files
			resp["players"] = sum.Players
			if me := s.me(r, id, sum.Players); me != "" {
				resp["me"] = me
			}
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) apiInfo(w http.ResponseWriter, r *http.Request) {
	urls := LANURLs(s.port)
	primary := fmt.Sprintf("http://localhost:%d/", s.port)
	if len(urls) > 0 {
		primary = urls[0]
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"port": s.port, "urls": urls, "primary": primary, "dataDir": s.store.Root(),
	})
}

func (s *Server) apiQR(w http.ResponseWriter, r *http.Request) {
	urls := LANURLs(s.port)
	target := fmt.Sprintf("http://localhost:%d/", s.port)
	if len(urls) > 0 {
		target = urls[0]
	}
	if u := r.URL.Query().Get("u"); u != "" {
		for _, known := range urls {
			if u == known {
				target = u
			}
		}
	}
	png, err := qrcode.Encode(target, qrcode.Medium, 512)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(png)
}

func (s *Server) apiListSessions(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.ListSessions()
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) apiGetSession(w http.ResponseWriter, r *http.Request) {
	sum, err := s.store.GetSession(r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, sum)
}

func (s *Server) apiCreateSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name     string `json:"name"`
		GameType string `json:"gameType"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		bodyError(w, err, `{"name": ..., "gameType"?: ...}`)
		return
	}
	meta, err := s.store.CreateSession(body.Name, body.GameType)
	if err != nil {
		storeError(w, err)
		return
	}
	s.changed()
	writeJSON(w, http.StatusCreated, meta)
}

// apiUpdateSession changes the name and/or game type; absent fields stay.
func (s *Server) apiUpdateSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name     *string `json:"name"`
		GameType *string `json:"gameType"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		bodyError(w, err, `{"name"?: ..., "gameType"?: ...}`)
		return
	}
	meta, err := s.store.UpdateSession(r.PathValue("id"), body.Name, body.GameType)
	if err != nil {
		storeError(w, err)
		return
	}
	s.changed()
	writeJSON(w, http.StatusOK, meta)
}

func (s *Server) apiDeleteSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.store.DeleteSession(id); err != nil {
		storeError(w, err)
		return
	}
	s.hub.toRoomsWithPrefix(id+"/", map[string]string{"type": "gone"})
	s.changed()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) apiActivate(w http.ResponseWriter, r *http.Request) {
	prev := s.store.Active()
	if err := s.store.SetActive(r.PathValue("id")); err != nil {
		storeError(w, err)
		return
	}
	if prev != "" && prev != r.PathValue("id") {
		s.hub.kickPlayers(prev + "/")
	}
	s.changed()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) apiDeactivate(w http.ResponseWriter, r *http.Request) {
	prev := s.store.Active()
	if err := s.store.SetActive(""); err != nil {
		storeError(w, err)
		return
	}
	if prev != "" {
		s.hub.kickPlayers(prev + "/")
	}
	s.changed()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) apiReveal(w http.ResponseWriter, r *http.Request) {
	dir, err := s.store.SessionDir(r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	if err := OpenInOS(dir); err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) apiUpload(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	r.Body = http.MaxBytesReader(w, r.Body, 512<<20) // per-file limits are in the store
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		jsonError(w, http.StatusBadRequest, "upload too large or malformed")
		return
	}
	defer r.MultipartForm.RemoveAll()
	sc, err := store.ParseScope(r.FormValue("scope"))
	if err != nil {
		storeError(w, err)
		return
	}
	saved, failed := []string{}, []string{}
	for _, fh := range r.MultipartForm.File["files"] {
		f, err := fh.Open()
		if err != nil {
			failed = append(failed, fh.Filename+": "+err.Error())
			continue
		}
		name, err := s.store.SaveFile(id, sc, fh.Filename, f)
		f.Close()
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				storeError(w, err)
				return
			}
			failed = append(failed, err.Error())
			continue
		}
		saved = append(saved, name)
		s.hub.toFile(id, string(sc), name, map[string]string{"type": "reload"})
	}
	if len(saved) > 0 {
		s.changed()
	}
	status := http.StatusOK
	if len(saved) == 0 && len(failed) > 0 {
		status = http.StatusBadRequest
	}
	writeJSON(w, status, map[string]any{"saved": saved, "errors": failed})
}

func (s *Server) fileTarget(w http.ResponseWriter, r *http.Request) (string, store.Scope, string, bool) {
	sc, err := store.ParseScope(r.PathValue("scope"))
	if err != nil {
		storeError(w, err)
		return "", "", "", false
	}
	return r.PathValue("id"), sc, r.PathValue("file"), true
}

func (s *Server) apiMoveFile(w http.ResponseWriter, r *http.Request) {
	id, sc, name, ok := s.fileTarget(w, r)
	if !ok {
		return
	}
	var body struct {
		Scope string `json:"scope"`
		Name  string `json:"name"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		bodyError(w, err, `{"scope"?, "name"?}`)
		return
	}
	to := sc
	if body.Scope != "" {
		var err error
		if to, err = store.ParseScope(body.Scope); err != nil {
			storeError(w, err)
			return
		}
	}
	if err := s.store.MoveFile(id, sc, name, to, body.Name); err != nil {
		storeError(w, err)
		return
	}
	s.hub.toFile(id, string(sc), name, map[string]string{"type": "gone"})
	s.changed()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) apiDeleteFile(w http.ResponseWriter, r *http.Request) {
	id, sc, name, ok := s.fileTarget(w, r)
	if !ok {
		return
	}
	if err := s.store.DeleteFile(id, sc, name); err != nil {
		storeError(w, err)
		return
	}
	s.hub.toFile(id, string(sc), name, map[string]string{"type": "gone"})
	s.changed()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) apiResetState(w http.ResponseWriter, r *http.Request) {
	id, sc, name, ok := s.fileTarget(w, r)
	if !ok {
		return
	}
	// ?player= resets one copy. It names the copy exactly, even while the
	// page isn't per-player, so it can never fall back to resetting the
	// template instead.
	player := r.URL.Query().Get("player")
	if player != "" {
		a, err := s.store.Access(id, sc, name)
		if err != nil {
			storeError(w, err)
			return
		}
		if !a.HasPlayer(player) {
			jsonError(w, http.StatusNotFound, fmt.Sprintf("There is no player %q in this session.", player))
			return
		}
	}
	if err := s.store.ResetState(id, sc, name, player); err != nil {
		storeError(w, err)
		return
	}
	reload := map[string]string{"type": "reload"}
	if player != "" {
		s.hub.toRoom(playerRoomKey(id, string(sc), name, player), reload, nil)
	} else {
		// Copies nobody has written to yet show the template, so they change too.
		s.hub.toFile(id, string(sc), name, reload)
	}
	s.changed()
	w.WriteHeader(http.StatusNoContent)
}

// apiSetPageMeta replaces a page's description and tags, and sets its
// per-player switch when perPlayer is given.
func (s *Server) apiSetPageMeta(w http.ResponseWriter, r *http.Request) {
	id, sc, name, ok := s.fileTarget(w, r)
	if !ok {
		return
	}
	var body struct {
		Description string   `json:"description"`
		Tags        []string `json:"tags"`
		PerPlayer   *bool    `json:"perPlayer"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		bodyError(w, err, `{"description": "...", "tags": ["..."], "perPlayer"?: bool}`)
		return
	}
	pm, switched, err := s.store.UpdatePageMeta(id, sc, name, store.PageMeta{Description: body.Description, Tags: body.Tags}, body.PerPlayer)
	if err != nil {
		storeError(w, err)
		return
	}
	if switched {
		// Everyone viewing it is now looking at the wrong entries.
		s.hub.toFile(id, string(sc), name, map[string]string{"type": "reload"})
	}
	s.changed()
	writeJSON(w, http.StatusOK, pm)
}

// apiExport returns a standalone copy of the page with all saved values
// baked in (state JSON + an inline copy of inject.js running offline).
func (s *Server) apiExport(w http.ResponseWriter, r *http.Request) {
	id, sc, name, ok := s.fileTarget(w, r)
	if !ok || !requireHTML(w, name) {
		return
	}
	doc, err := s.store.ReadFile(id, sc, name)
	if err != nil {
		storeError(w, err)
		return
	}
	player, err := s.copyFor(r, id, sc, name, r.URL.Query().Get("player"))
	if err != nil {
		s.accessFail(w, r, err)
		return
	}
	st, err := s.store.GetState(id, sc, name, player)
	if err != nil {
		storeError(w, err)
		return
	}
	tag := stateTag(st) + "<script>\n" + string(s.injectJS) + "\n</script>\n"
	base := strings.TrimSuffix(strings.TrimSuffix(name, ".html"), ".htm")
	if player != "" {
		base += "-" + player
	}
	out := base + "-filled.html"
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`,
		strings.ReplaceAll(out, `"`, ""), url.PathEscape(out)))
	w.Write(injectBefore(doc, tag))
}

// ---- WebSockets ----------------------------------------------------------------

type wsMsg struct {
	Type  string          `json:"type"`
	Key   string          `json:"key"`
	Value json.RawMessage `json:"value"`
}

func (s *Server) wsFile(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	id, name := q.Get("session"), q.Get("file")
	sc, ok := s.gameParams(w, r, id, q.Get("scope"), name)
	if !ok {
		return
	}
	if !requireState(w, name) {
		return
	}
	if !s.store.Exists(id, sc, name) {
		jsonError(w, http.StatusNotFound, "file not found")
		return
	}
	asked := q.Get("player")
	player, err := s.copyFor(r, id, sc, name, asked)
	if err != nil {
		s.accessFail(w, r, err)
		return
	}
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(store.MaxValueSize + 8192)
	c := newClient(conn)
	c.host = s.isHost(r)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	room := playerRoomKey(id, string(sc), name, player)
	s.syncMu.Lock()
	st, err := s.store.GetState(id, sc, name, player)
	if err != nil {
		s.syncMu.Unlock()
		log.Printf("loading %s: %v", room, err)
		conn.Close(websocket.StatusInternalError, "could not load saved entries")
		return
	}
	snap, _ := json.Marshal(map[string]any{"type": "snapshot", "state": st})
	c.queue(snap)
	if s.testHookSnapshotted != nil {
		s.testHookSnapshotted()
	}
	s.hub.join(room, c)
	s.syncMu.Unlock()
	defer s.hub.leave(room, c)
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
		if !s.canView(r, id, sc) {
			c.close(websocket.StatusPolicyViolation, "session is no longer live")
			return
		}
		s.syncMu.Lock()
		// The page may have been switched to or from per-player, or the
		// player taken off the roster, since this socket opened. Checked under
		// syncMu so a removal can't slip in between the check and the write.
		if now, err := s.copyFor(r, id, sc, name, asked); err != nil || now != player {
			s.syncMu.Unlock()
			c.close(websocket.StatusPolicyViolation, "this copy of the page is no longer available")
			return
		}
		setErr := s.store.SetValue(id, sc, name, player, m.Key, m.Value)
		if setErr == nil {
			s.hub.toRoom(room, map[string]any{"type": "set", "key": m.Key, "value": m.Value}, c)
		}
		s.syncMu.Unlock()
		if setErr != nil {
			log.Printf("rejected value for %s %q: %v", room, m.Key, setErr)
		}
	}
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

// ---- OS integration ----------------------------------------------------------

// OpenInOS opens a folder or URL with the platform's default handler.
func OpenInOS(target string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		if strings.HasPrefix(target, "http") {
			cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
		} else {
			cmd = exec.Command("explorer", target)
		}
	case "darwin":
		cmd = exec.Command("open", target)
	default:
		cmd = exec.Command("xdg-open", target)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}
