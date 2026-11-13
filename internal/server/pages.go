// Serving pages: the embedded UI, and game pages with their entries and the
// sync script added.
package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"html"
	"io/fs"
	"net/http"
	"net/url"
	"strings"

	"mothergoose/internal/store"
	"mothergoose/web"
)

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

// pageScript is the script added to every HTML page: sync.js (the connection,
// shared with the PDF viewer) and inject.js (the page's fields), wrapped in
// one function so that nothing but window.MotherGoose reaches the page's
// globals. It is served at /_mg/inject.js and inlined into exported copies.
func pageScript() ([]byte, error) {
	var b bytes.Buffer
	b.WriteString("(function () {\n")
	for _, name := range []string{"sync.js", "inject.js"} {
		src, err := fs.ReadFile(web.FS, name)
		if err != nil {
			return nil, err
		}
		b.Write(src)
		b.WriteString("\n")
	}
	b.WriteString("})();\n")
	return b.Bytes(), nil
}

func (s *Server) serveInject(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(s.injectJS)
}
