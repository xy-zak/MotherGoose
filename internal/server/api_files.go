// The API for a session's pages: upload, move, delete, order, details,
// resetting entries and exporting a filled copy.
package server

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"mothergoose/internal/store"
)

// requireHTML refuses a filled export of anything but an HTML page. A filled
// PDF is written by the PDF viewer in the browser, which already has PDF.js.
func requireHTML(w http.ResponseWriter, name string) bool {
	if k, _ := store.KindOf(name); k != store.KindHTML {
		jsonError(w, http.StatusBadRequest, fmt.Sprintf("%q is a %s: only HTML pages are exported here", name, k))
		return false
	}
	return true
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
				if len(saved) > 0 {
					s.changed() // the session went, but not before these arrived
				}
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
	s.syncMu.Lock()
	err := s.store.MoveFile(id, sc, name, to, body.Name)
	if err == nil {
		s.hub.toFile(id, string(sc), name, map[string]string{"type": "gone"})
	}
	s.syncMu.Unlock()
	if err != nil {
		storeError(w, err)
		return
	}
	s.changed()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) apiDeleteFile(w http.ResponseWriter, r *http.Request) {
	id, sc, name, ok := s.fileTarget(w, r)
	if !ok {
		return
	}
	s.syncMu.Lock()
	err := s.store.DeleteFile(id, sc, name)
	if err == nil {
		s.hub.toFile(id, string(sc), name, map[string]string{"type": "gone"})
	}
	s.syncMu.Unlock()
	if err != nil {
		storeError(w, err)
		return
	}
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
	s.syncMu.Lock()
	err := s.store.ResetState(id, sc, name, player)
	if err == nil {
		reload := map[string]string{"type": "reload"}
		if player != "" {
			s.hub.toRoom(playerRoomKey(id, string(sc), name, player), reload, nil)
		} else {
			// Copies nobody has written to yet show the template, so they change too.
			s.hub.toFile(id, string(sc), name, reload)
		}
	}
	s.syncMu.Unlock()
	if err != nil {
		storeError(w, err)
		return
	}
	s.changed()
	w.WriteHeader(http.StatusNoContent)
}

// apiSetOrder sets the order of one scope's pages: the dashboard's columns
// and the players' tabs follow it.
func (s *Server) apiSetOrder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Scope string   `json:"scope"`
		Names []string `json:"names"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		bodyError(w, err, `{"scope": "shared" | "gm", "names": ["..."]}`)
		return
	}
	sc, err := store.ParseScope(body.Scope)
	if err == nil {
		err = s.store.SetOrder(r.PathValue("id"), sc, body.Names)
	}
	if err != nil {
		storeError(w, err)
		return
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
	s.syncMu.Lock()
	pm, switched, err := s.store.UpdatePageMeta(id, sc, name, store.PageMeta{Description: body.Description, Tags: body.Tags}, body.PerPlayer)
	if err == nil && switched {
		// Everyone viewing it is now looking at the wrong entries.
		s.hub.toFile(id, string(sc), name, map[string]string{"type": "reload"})
	}
	s.syncMu.Unlock()
	if err != nil {
		storeError(w, err)
		return
	}
	s.changed()
	writeJSON(w, http.StatusOK, pm)
}

// apiExport returns a standalone copy of the page with all saved values
// baked in (state JSON + an inline copy of the page script running offline).
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
