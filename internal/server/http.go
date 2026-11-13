// HTTP plumbing shared by every handler: access checks, JSON in and out,
// and turning store errors into status codes.
package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"mime"
	"net/http"
	"strings"

	"mothergoose/internal/store"
)

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
