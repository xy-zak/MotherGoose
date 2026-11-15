// Built-in templates: ready-made pages (web/templates/) the referee adds to a
// campaign from the dashboard, instead of writing one.
package server

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"mothergoose/internal/store"
	"mothergoose/web"
)

// template is one entry of web/templates/templates.json: the page, and the
// details it starts with once added.
type template struct {
	File        string   `json:"file"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Tags        []string `json:"tags"`
	Scope       string   `json:"scope"`
	PerPlayer   bool     `json:"perPlayer"`
	Hidden      bool     `json:"hidden"`
}

func templates() ([]template, error) {
	b, err := fs.ReadFile(web.FS, "templates/templates.json")
	if err != nil {
		return nil, err
	}
	var list []template
	return list, json.Unmarshal(b, &list)
}

func findTemplate(file string) (template, bool) {
	list, _ := templates()
	for _, t := range list {
		if t.File == file {
			return t, true
		}
	}
	return template{}, false
}

func (s *Server) apiTemplates(w http.ResponseWriter, r *http.Request) {
	list, err := templates()
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// apiTemplatePreview shows a template as it would look added, in the
// referee's theme (its fields work, but save nothing).
func (s *Server) apiTemplatePreview(w http.ResponseWriter, r *http.Request) {
	t, ok := findTemplate(r.PathValue("file"))
	if !ok {
		notFound(w, r)
		return
	}
	doc, err := fs.ReadFile(web.FS, "templates/"+t.File)
	if err != nil {
		notFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(withTheme(doc))
}

// apiAddTemplate copies a template into a campaign as a new page, under a
// name not yet used there ("character-sheet-2.html"), with the template's
// description, tags, per-player switch and visibility.
// Body: {"template": "<file>", "scope"?: "shared" | "gm"}.
func (s *Server) apiAddTemplate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct {
		Template string `json:"template"`
		Scope    string `json:"scope"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		bodyError(w, err, `{"template": "<file>", "scope"?: "shared" | "gm"}`)
		return
	}
	t, ok := findTemplate(body.Template)
	if !ok {
		jsonError(w, http.StatusNotFound, "no such template")
		return
	}
	scope := body.Scope
	if scope == "" {
		scope = t.Scope
	}
	sc, err := store.ParseScope(scope)
	if err != nil {
		storeError(w, err)
		return
	}
	doc, err := fs.ReadFile(web.FS, "templates/"+t.File)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	name, err := s.store.FreeName(id, t.File)
	if err != nil {
		storeError(w, err)
		return
	}
	if name, err = s.store.SaveFile(id, sc, name, bytes.NewReader(doc)); err != nil {
		storeError(w, err)
		return
	}
	up := store.PageUpdate{Description: &t.Description, Tags: &t.Tags}
	// A second copy gets a title of its own ("Notes 2"), so the two can be told apart.
	if name != t.File {
		n := strings.TrimSuffix(strings.TrimPrefix(name, strings.TrimSuffix(t.File, path.Ext(t.File))+"-"), path.Ext(name))
		title := t.Title + " " + n
		up.Title = &title
	}
	if sc == store.Shared {
		up.PerPlayer, up.Hidden = &t.PerPlayer, &t.Hidden
	}
	if sc == store.Shared && s.store.Active() == id {
		yes := true
		up.Hidden = &yes // added while live: hidden until revealed
	}
	pm, _, err := s.store.UpdatePageMeta(id, sc, name, up)
	if err != nil {
		storeError(w, err)
		return
	}
	s.changed()
	writeJSON(w, http.StatusCreated, map[string]any{"name": name, "scope": sc, "meta": pm})
}
