// The API for a session's pages: upload, move, delete, order, details,
// resetting entries and exporting a filled copy.
package server

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"path"
	"strings"

	"github.com/coder/websocket"

	"mothergoose/internal/pages"
	"mothergoose/internal/store"
)

// requireHTML refuses a filled export of anything but an HTML or Markdown
// page (exported as HTML). A filled PDF is written by the PDF viewer in the
// browser, which already has PDF.js.
func requireHTML(w http.ResponseWriter, name string) bool {
	if k, _ := store.KindOf(name); !store.IsPage(k) {
		jsonError(w, http.StatusBadRequest, fmt.Sprintf("%q is a %s: only HTML and Markdown pages are exported here", name, k))
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
	// What checking each saved page found worth telling the referee about:
	// what it loads from the internet, and fields without a name.
	warnings := map[string]pages.Report{}
	// Files that replaced one of the same name (keeping its entries and
	// details), and new players' pages that start hidden because the
	// campaign is live: nothing appears on players' screens by accident.
	replaced, hidden := []string{}, []string{}
	live := sc == store.Shared && s.store.Active() == id
	for _, fh := range r.MultipartForm.File["files"] {
		f, err := fh.Open()
		if err != nil {
			failed = append(failed, fh.Filename+": "+err.Error())
			continue
		}
		existed := false
		if clean, err := store.CleanFileName(fh.Filename); err == nil {
			existed = s.store.Exists(id, sc, clean)
		}
		name, rep, err := s.store.SavePage(id, sc, fh.Filename, f)
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
		if existed {
			replaced = append(replaced, name)
		} else if live && s.hideNew(id, sc, name) {
			hidden = append(hidden, name)
		}
		if len(rep.Web) > 0 || rep.Unnamed > 0 {
			warnings[name] = rep
		}
		s.hub.toFile(id, string(sc), name, map[string]string{"type": "reload"})
	}
	if len(saved) > 0 {
		s.changed()
	}
	status := http.StatusOK
	if len(saved) == 0 && len(failed) > 0 {
		status = http.StatusBadRequest
	}
	writeJSON(w, status, map[string]any{"saved": saved, "errors": failed, "warnings": warnings, "replaced": replaced, "hidden": hidden})
}

// hideNew hides a players' page that just arrived while its campaign is
// live, so the referee reveals it when they choose. It reports whether it did.
func (s *Server) hideNew(id string, sc store.Scope, name string) bool {
	if sc != store.Shared || s.store.Active() != id {
		return false
	}
	yes := true
	if _, _, err := s.store.UpdatePageMeta(id, sc, name, store.PageUpdate{Hidden: &yes}); err != nil {
		log.Printf("hiding %s/%s: %v", id, name, err)
		return false
	}
	return true
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
	newName := name
	if body.Name != "" {
		newName, _ = store.CleanFileName(body.Name)
	}
	// A page moved to the players' side while live starts hidden.
	hidden := to != sc && s.hideNew(id, to, newName)
	s.changed()
	writeJSON(w, http.StatusOK, map[string]any{"name": newName, "scope": to, "hidden": hidden})
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
			jsonError(w, http.StatusNotFound, fmt.Sprintf("There is no player %q in this campaign.", player))
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

// apiSetPageMeta changes a page's details: whichever of its description,
// tags, per-player switch and who it is shown to the body gives.
func (s *Server) apiSetPageMeta(w http.ResponseWriter, r *http.Request) {
	id, sc, name, ok := s.fileTarget(w, r)
	if !ok {
		return
	}
	var body struct {
		Name        *string   `json:"name"`
		Title       *string   `json:"title"`
		Description *string   `json:"description"`
		Tags        *[]string `json:"tags"`
		PerPlayer   *bool     `json:"perPlayer"`
		Hidden      *bool     `json:"hidden"`
		Audience    *string   `json:"audience"`
		Allowed     *[]string `json:"allowed"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		bodyError(w, err, `{"name"?: "...", "title"?: "...", "description"?: "...", "tags"?: ["..."], "perPlayer"?: bool, "hidden"?: bool, "audience"?: "" | "only", "allowed"?: ["<player id>"]}`)
		return
	}
	s.syncMu.Lock()
	// A new file name and the details go together: renamed first, then the
	// details saved on the new name, so a failure can't leave half of it.
	if body.Name != nil && *body.Name != name {
		newName, err := store.CleanFileName(*body.Name)
		if err == nil {
			err = s.store.MoveFile(id, sc, name, sc, newName)
		}
		if err != nil {
			s.syncMu.Unlock()
			storeError(w, err)
			return
		}
		s.hub.toFile(id, string(sc), name, map[string]string{"type": "gone"})
		name = newName
	}
	pm, ch, err := s.store.UpdatePageMeta(id, sc, name, store.PageUpdate{
		Title: body.Title, Description: body.Description, Tags: body.Tags, PerPlayer: body.PerPlayer,
		Hidden: body.Hidden, Audience: body.Audience, Allowed: body.Allowed,
	})
	if err == nil && ch.PerPlayer {
		// Everyone viewing it is now looking at the wrong entries. Players'
		// sockets are closed too, so one that ignores the reload can't keep
		// hearing the template (or a copy) it now has no business with.
		s.hub.toFile(id, string(sc), name, map[string]string{"type": "reload"})
		base := roomKey(id, string(sc), name)
		s.hub.kick(func(k string) bool { return k == base || strings.HasPrefix(k, base+"/") },
			func(_ string, c *client) bool { return !c.host }, nil, websocket.StatusPolicyViolation, "this page changed: reload it")
	}
	if err == nil && ch.Visibility {
		s.enforceAccess(id)
	}
	s.syncMu.Unlock()
	if err != nil {
		storeError(w, err)
		return
	}
	s.changed()
	writeJSON(w, http.StatusOK, map[string]any{"name": name, "meta": pm})
}

// apiCheckPage reports what checking an HTML or Markdown page finds: files
// it loads from beside itself (which never load), from the internet, and
// fields without a name. It covers pages copied into the folder by hand,
// which no upload checked.
func (s *Server) apiCheckPage(w http.ResponseWriter, r *http.Request) {
	id, sc, name, ok := s.fileTarget(w, r)
	if !ok || !requireHTML(w, name) {
		return
	}
	doc, err := s.store.ReadFile(id, sc, name)
	if err != nil {
		storeError(w, err)
		return
	}
	k, _ := store.KindOf(name)
	rep, err := store.CheckPage(name, k, doc)
	resp := map[string]any{"report": rep}
	if err != nil {
		resp["error"] = err.Error()
	}
	writeJSON(w, http.StatusOK, resp)
}

// apiShowPage asks every player's device that can see a page to look at it
// now. Each one is asked, not switched: the player chooses. It answers how
// many devices were asked.
func (s *Server) apiShowPage(w http.ResponseWriter, r *http.Request) {
	id, sc, name, ok := s.fileTarget(w, r)
	if !ok {
		return
	}
	if sc != store.Shared {
		jsonError(w, http.StatusBadRequest, "Only players' pages can be shown to players.")
		return
	}
	if !s.store.Exists(id, sc, name) {
		jsonError(w, http.StatusNotFound, "file not found")
		return
	}
	if s.store.Active() != id {
		jsonError(w, http.StatusConflict, "This campaign isn't live: go live first.")
		return
	}
	a, err := s.store.Access(id, sc, name)
	if err != nil {
		storeError(w, err)
		return
	}
	if a.Hidden {
		jsonError(w, http.StatusConflict, "This page is hidden: reveal it first.")
		return
	}
	n := s.hub.EventTo(map[string]string{"type": "show", "key": string(sc) + "/" + name}, func(c *client) bool {
		return !c.host && a.Visible(c.who[id])
	})
	writeJSON(w, http.StatusOK, map[string]int{"devices": n})
}

// apiExport returns a standalone copy of the page with all saved values
// baked in (state JSON + an inline copy of the page script running offline).
func (s *Server) apiExport(w http.ResponseWriter, r *http.Request) {
	id, sc, name, ok := s.fileTarget(w, r)
	if !ok || !requireHTML(w, name) {
		return
	}
	doc, err := s.readPage(id, sc, name)
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
	base := strings.TrimSuffix(name, path.Ext(name))
	if player != "" {
		base += "-" + player
	}
	out := base + "-filled.html"
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`,
		strings.ReplaceAll(out, `"`, ""), url.PathEscape(out)))
	w.Write(injectBefore(doc, tag))
}
