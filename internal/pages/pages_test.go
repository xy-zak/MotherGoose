package pages

import (
	"slices"
	"strings"
	"testing"
)

func TestMarkdown(t *testing.T) {
	src := "# The *Sunken* Keep\n\nA [map](https://example.com/m) and [up](#the-sunken-keep).\n\n" +
		"- [ ] Find the key\n- [x] Open the door\n- [ ] Find the key\n\n" +
		"<script>alert(1)</script>\n\n[bad](javascript:alert(1)) ![ok](data:image/png;base64,AAAA)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"
	body, title, err := Markdown([]byte(src))
	if err != nil {
		t.Fatal(err)
	}
	h := string(body)
	if title != "The Sunken Keep" {
		t.Errorf("title = %q", title)
	}
	for _, want := range []string{
		`<input type="checkbox" class="task" id="task-find-the-key" aria-label="Find the key">`,
		`<input type="checkbox" class="task" id="task-open-the-door" aria-label="Open the door" checked>`,
		`href="https://example.com/m" target="_blank" rel="noopener noreferrer"`,
		`<a href="#the-sunken-keep">up</a>`,
		`<table>`, `src="data:image/png;base64,AAAA"`,
	} {
		if !strings.Contains(h, want) {
			t.Errorf("missing %s in:\n%s", want, h)
		}
	}
	for _, bad := range []string{"<script", "javascript:", "disabled"} {
		if strings.Contains(h, bad) {
			t.Errorf("%q in:\n%s", bad, h)
		}
	}
}

func TestCheckHTML(t *testing.T) {
	doc := `<!doctype html><html><head>
<link rel="stylesheet" href="style.css"><link rel="canonical" href="page.html">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
<style>body { background: url('img/bg.png') } @import "more.css"; .x{background:url(data:image/png;base64,AA)}</style>
<script src="app.js"></script>
<script>var s = '<img src="nope.png">'; fetch('data.json')</script>
<!-- <img src="commented.png"> -->
</head><body>
<img src="map.png" srcset="map-2x.png 2x, data:image/png;base64,AA 3x">
<img src="data:image/png;base64,AAAA"><a href="other.html">link</a>
<div style="background-image: url(&quot;tile.png&quot;)"></div>
<svg><use href="#icon"></use><image href="pic.svg"/></svg>
<input id=name><input name=hp type=number><input><input type=hidden><input type=submit>
<textarea></textarea><select id=c></select><div contenteditable></div><div contenteditable="false"></div>
<input data-mg-ignore>
<script src="//cdn.example.com/x.js"></script>
</body></html>`
	r := CheckHTML([]byte(doc))
	wantLocal := []string{"style.css", "img/bg.png", "more.css", "app.js", "map.png", "map-2x.png", "tile.png", "pic.svg"}
	if !slices.Equal(r.Local, wantLocal) {
		t.Errorf("local = %q\nwant    %q", r.Local, wantLocal)
	}
	if !slices.Equal(r.Web, []string{"fonts.googleapis.com", "cdn.example.com"}) {
		t.Errorf("web = %q", r.Web)
	}
	if r.Fields != 6 || r.Unnamed != 3 {
		t.Errorf("fields = %d, unnamed = %d; want 6, 3", r.Fields, r.Unnamed)
	}
	if r := CheckHTML([]byte(`<p>Just text</p><img src="data:image/gif;base64,R0">`)); len(r.Local)+len(r.Web)+r.Fields != 0 {
		t.Errorf("a self-contained page: %+v", r)
	}
}
