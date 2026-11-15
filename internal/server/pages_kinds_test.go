package server

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"mothergoose/internal/store"
	"mothergoose/web"
)

func (f *fixture) uploadFiles(t *testing.T, scope string, files map[string]string) map[string]any {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	mw.WriteField("scope", scope)
	for name, b := range files {
		w, _ := mw.CreateFormFile("files", name)
		w.Write([]byte(b))
	}
	mw.Close()
	req := httptest.NewRequest("POST", "/api/admin/sessions/"+f.id+"/files", &body)
	req.Host, req.RemoteAddr = "localhost:8080", host
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	f.srv.ServeHTTP(rec, req)
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	out["status"] = rec.Code
	return out
}

func TestMarkdownPages(t *testing.T) {
	f := setup(t)
	res := f.uploadFiles(t, "shared", map[string]string{"quests.md": "# Quest log\n\n- [ ] Find the key\n- [x] Meet the duke\n\n<script>alert(1)</script>\n"})
	if res["status"] != 200 || !f.st.Exists(f.id, store.Shared, "quests.md") {
		t.Fatalf("upload: %v", res)
	}
	// Added while live, so it starts hidden; reveal it to look at it as a player.
	if h := res["hidden"].([]any); len(h) != 1 || h[0] != "quests.md" {
		t.Fatalf("not hidden on arrival while live: %v", res)
	}
	f.setVis(t, "quests.md", `{"hidden":false}`)
	sum, _ := f.st.GetSession(f.id)
	var md store.FileInfo
	for _, fi := range sum.Files[store.Shared] {
		if fi.Name == "quests.md" {
			md = fi
		}
	}
	if md.Kind != store.KindMD || md.Title != "Quest log" {
		t.Fatalf("listed as %+v", md)
	}
	f.st.SetValue(f.id, store.Shared, "quests.md", "", "#task-find-the-key", json.RawMessage(`true`))
	rec := f.request("GET", "/s/"+f.id+"/shared/quests.md", "", withCookie(nil))
	body := rec.Body.String()
	for _, want := range []string{
		`<input type="checkbox" class="task" id="task-find-the-key">`, `<title>Quest log</title>`,
		`/_mg/tokens.css`, `/_mg/page-theme.js`, `"#task-find-the-key":true`, `/_mg/inject.js`, `class="md"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("served page lacks %s", want)
		}
	}
	if strings.Contains(body, "<script>alert") || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/html") {
		t.Errorf("served: %s %s", rec.Header().Get("Content-Type"), body)
	}
	// The theme comes before the page's own CSS is overridden: in the head.
	if strings.Index(body, "/_mg/tokens.css") > strings.Index(body, "</head>") {
		t.Error("theme added outside the head")
	}
	// Exported filled in, as HTML that works offline.
	rec = f.request("GET", "/api/admin/sessions/"+f.id+"/files/shared/quests.md/export", "", nil)
	if rec.Code != 200 || !strings.Contains(rec.Header().Get("Content-Disposition"), "quests-filled.html") ||
		!strings.Contains(rec.Body.String(), `"#task-find-the-key":true`) {
		t.Fatalf("export: %d %s", rec.Code, rec.Header().Get("Content-Disposition"))
	}
	// Markdown pages can't be per player.
	if rec := f.request("PUT", "/api/admin/sessions/"+f.id+"/files/shared/quests.md/meta", `{"perPlayer":true}`, nil); rec.Code != 400 {
		t.Errorf("per-player markdown: %d", rec.Code)
	}
}

func TestPagesMustBeSelfContained(t *testing.T) {
	f := setup(t)
	res := f.uploadFiles(t, "shared", map[string]string{
		"broken.html": `<link rel="stylesheet" href="style.css"><img src="map.png">`,
		"broken.md":   "# Map\n\n![map](map.png)\n",
		"fonts.html":  `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"><input>`,
		"fine.html":   `<input id="hp"><img src="data:image/png;base64,AAAA">`,
	})
	errs := res["errors"].([]any)
	if len(errs) != 2 || !strings.Contains(errs[0].(string)+errs[1].(string), "style.css, map.png") {
		t.Fatalf("errors: %v", errs)
	}
	for _, name := range []string{"broken.html", "broken.md"} {
		if f.st.Exists(f.id, store.Shared, name) {
			t.Errorf("%s was saved", name)
		}
	}
	warn := res["warnings"].(map[string]any)
	if _, ok := warn["fine.html"]; ok || len(warn) != 1 {
		t.Fatalf("warnings: %v", warn)
	}
	w := warn["fonts.html"].(map[string]any)
	if w["web"].([]any)[0] != "fonts.googleapis.com" || w["unnamed"] != 1.0 {
		t.Errorf("fonts.html warning: %v", w)
	}
	// A page copied in by hand isn't checked on the way in: the check says.
	f.st.SaveFile(f.id, store.GM, "ok.html", strings.NewReader("<p>fine"))
	p := f.st.Root() + "/sessions/" + f.id + "/gm/hand.html"
	writeFile(t, p, `<script src="app.js"></script>`)
	rec := f.request("GET", "/api/admin/sessions/"+f.id+"/files/gm/hand.html/check", "", nil)
	if !strings.Contains(rec.Body.String(), "app.js") || !strings.Contains(rec.Body.String(), `"error"`) {
		t.Errorf("check: %s", rec.Body.String())
	}
}

// A page that asks to follow the theme gets it in its head; others don't.
func TestThemeOptIn(t *testing.T) {
	f := setup(t)
	f.st.SaveFile(f.id, store.Shared, "themed.html", strings.NewReader(`<!doctype html><html><head><meta content="theme" name="MotherGoose"><style>:root{--bg:#fff}</style></head><body><p>hi</p></body></html>`))
	body := f.request("GET", "/s/"+f.id+"/shared/themed.html", "", nil).Body.String()
	if i, j := strings.Index(body, "/_mg/tokens.css"), strings.Index(body, "</head>"); i < 0 || i > j || strings.Index(body, ":root{--bg") > i {
		t.Errorf("themed page: %s", body)
	}
	if body := f.request("GET", "/s/"+f.id+"/shared/sheet.html", "", nil).Body.String(); strings.Contains(body, "tokens.css") {
		t.Error("a page that didn't ask got the theme")
	}
}

func writeFile(t *testing.T, p, s string) {
	t.Helper()
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

// Every template is a valid, self-contained page that adds cleanly, under a
// free name, with its details.
func TestTemplates(t *testing.T) {
	f := setup(t)
	f.st.AddPlayer(f.id, "Ana")
	list, err := templates()
	if err != nil || len(list) < 7 {
		t.Fatalf("templates: %v %d", err, len(list))
	}
	for _, tp := range list {
		doc, err := fs.ReadFile(web.FS, "templates/"+tp.File)
		if err != nil {
			t.Fatalf("%s: %v", tp.File, err)
		}
		rep, err := store.CheckPage(tp.File, store.KindHTML, doc)
		if err != nil || len(rep.Web) > 0 || rep.Unnamed > 0 {
			t.Errorf("%s isn't self-contained: %v %+v", tp.File, err, rep)
		}
		if !strings.Contains(string(doc), `<meta name="mothergoose" content="theme">`) {
			t.Errorf("%s doesn't follow the theme", tp.File)
		}
		if rec := f.request("GET", "/api/admin/templates/"+tp.File, "", nil); rec.Code != 200 || !strings.Contains(rec.Body.String(), "/_mg/tokens.css") {
			t.Errorf("preview %s: %d", tp.File, rec.Code)
		}
	}
	add := func() map[string]any {
		rec := f.request("POST", "/api/admin/sessions/"+f.id+"/templates", `{"template":"character-sheet.html"}`, nil)
		if rec.Code != 201 {
			t.Fatalf("add: %d %s", rec.Code, rec.Body.String())
		}
		var out map[string]any
		json.Unmarshal(rec.Body.Bytes(), &out)
		return out
	}
	if a, b := add(), add(); a["name"] != "character-sheet.html" || b["name"] != "character-sheet-2.html" {
		t.Errorf("names: %v, %v", a["name"], b["name"])
	}
	sum, _ := f.st.GetSession(f.id)
	var sheet store.FileInfo
	for _, fi := range sum.Files[store.Shared] {
		if fi.Name == "character-sheet.html" {
			sheet = fi
		}
	}
	if !sheet.PerPlayer || sheet.Description == "" || sheet.Title != "Character sheet" {
		t.Errorf("added sheet: %+v", sheet)
	}
	rec := f.request("POST", "/api/admin/sessions/"+f.id+"/templates", `{"template":"handout.html"}`, nil)
	var h map[string]any
	json.Unmarshal(rec.Body.Bytes(), &h)
	if h["meta"].(map[string]any)["hidden"] != true {
		t.Errorf("handout isn't hidden: %s", rec.Body.String())
	}
	if rec := f.request("POST", "/api/admin/sessions/"+f.id+"/templates", `{"template":"../../go.mod"}`, nil); rec.Code != 404 {
		t.Errorf("unknown template: %d", rec.Code)
	}
}
