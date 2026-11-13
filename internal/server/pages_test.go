package server

import (
	"strings"
	"testing"
)

// HTML pages get one script, the sync core and the page's side together,
// both when served live and inlined into an exported copy.
func TestPageScript(t *testing.T) {
	f := setup(t)
	rec := f.do("GET", "/_mg/inject.js", player)
	body := rec.Body.String()
	if rec.Code != 200 || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/javascript") {
		t.Fatalf("inject.js: %d %s", rec.Code, rec.Header().Get("Content-Type"))
	}
	for _, want := range []string{"function createSync(", "window.MotherGoose = {"} {
		if !strings.Contains(body, want) {
			t.Errorf("inject.js lacks %q", want)
		}
	}
	// createSync is declared inside the wrapper, not in the page's globals.
	if !strings.HasPrefix(body, "(function () {\n") || !strings.HasSuffix(body, "})();\n") {
		t.Error("the page script isn't wrapped in a function")
	}

	exp := f.do("GET", "/api/admin/sessions/"+f.id+"/files/shared/sheet.html/export", host).Body.String()
	if !strings.Contains(exp, "function createSync(") || strings.Contains(exp, "data-mg-session") {
		t.Error("export should inline the whole page script, unbound to a session")
	}
}
