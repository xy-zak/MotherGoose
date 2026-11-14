package pages

import (
	"html"
	"net/url"
	"regexp"
	"strings"
)

// Report is what CheckHTML found in a page.
type Report struct {
	// Local lists files the page loads from beside itself (style.css,
	// img/map.png). A MotherGoose page is one file, so these never load.
	Local []string `json:"local"`
	// Web lists what it loads from the internet: it works only while the
	// device viewing it has internet access.
	Web []string `json:"web"`
	// Fields counts the fields the page script saves and syncs; Unnamed,
	// those with neither id nor name, which are matched by their place in
	// the page and lose their values if the layout changes.
	Fields  int `json:"fields"`
	Unnamed int `json:"unnamed"`
}

// maxListed keeps reports short: a page with a hundred images needs to hear
// about a few to know what's wrong.
const maxListed = 12

var (
	commentRe = regexp.MustCompile(`(?s)<!--.*?-->`)
	tagRe     = regexp.MustCompile(`(?s)<([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>` + "`" + `]+))?)*)\s*/?>`)
	attrRe    = regexp.MustCompile(`([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>` + "`" + `]+)))?`)
	cssURLRe  = regexp.MustCompile(`(?i)url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)`)
	importRe  = regexp.MustCompile(`(?i)@import\s+(?:"([^"]*)"|'([^']*)')`)
	schemeRe  = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.-]*:`)
)

// Attributes that load something, per element ("*" for any element).
var resourceAttrs = map[string][]string{
	"*":       {"src", "background"},
	"img":     {"srcset"},
	"source":  {"srcset"},
	"video":   {"poster"},
	"object":  {"data"},
	"use":     {"href", "xlink:href"},
	"image":   {"href", "xlink:href"},
	"feimage": {"href", "xlink:href"},
}

// <link rel=…> that load something; others (canonical, alternate) are just
// information.
var loadingRels = []string{"stylesheet", "icon", "preload", "prefetch", "modulepreload", "manifest", "apple-touch-icon", "mask-icon"}

// Inputs the page script doesn't save (it skips these types).
var unsavedInputs = map[string]bool{"hidden": true, "submit": true, "button": true, "reset": true, "image": true, "file": true, "password": true}

// CheckHTML looks through a page for what it loads from outside itself and
// for fields it saves without a name. It reads the markup, CSS in <style>
// and style="", and the src of scripts; it doesn't run anything, so what a
// script fetches by itself goes unseen. Links (<a href>) only navigate, so
// they don't count.
func CheckHTML(doc []byte) Report {
	var r Report
	local, web := map[string]bool{}, map[string]bool{}
	note := func(raw string) {
		u := strings.TrimSpace(html.UnescapeString(raw))
		switch kind := classify(u); kind {
		case "local":
			if !local[u] {
				local[u] = true
				if len(r.Local) < maxListed {
					r.Local = append(r.Local, u)
				}
			}
		case "web":
			host, full := u, u
			if strings.HasPrefix(full, "//") {
				full = "https:" + full
			}
			if p, err := url.Parse(full); err == nil && p.Host != "" {
				host = p.Host
			}
			if !web[host] {
				web[host] = true
				if len(r.Web) < maxListed {
					r.Web = append(r.Web, host)
				}
			}
		}
	}
	css := func(s string) {
		for _, m := range cssURLRe.FindAllStringSubmatch(s, -1) {
			note(m[1] + m[2] + m[3])
		}
		for _, m := range importRe.FindAllStringSubmatch(s, -1) {
			note(m[1] + m[2])
		}
	}

	s := commentRe.ReplaceAllString(string(doc), "")
	for len(s) > 0 {
		loc := tagRe.FindStringSubmatchIndex(s)
		if loc == nil {
			break
		}
		name := strings.ToLower(s[loc[2]:loc[3]])
		attrs := parseAttrs(s[loc[4]:loc[5]])
		s = s[loc[1]:]

		for _, key := range append(resourceAttrs["*"], resourceAttrs[name]...) {
			v, ok := attrs[key]
			if !ok {
				continue
			}
			if key == "srcset" {
				for _, u := range srcsetURLs(html.UnescapeString(v)) {
					note(u)
				}
			} else {
				note(v)
			}
		}
		if name == "link" {
			rels := strings.Fields(strings.ToLower(attrs["rel"]))
			for _, rel := range rels {
				if contains(loadingRels, rel) {
					note(attrs["href"])
					break
				}
			}
		}
		if v, ok := attrs["style"]; ok {
			css(html.UnescapeString(v))
		}
		countField(&r, name, attrs)

		// Skip what's inside a script (not markup); read a style's CSS.
		if name == "script" || name == "style" {
			end := strings.Index(strings.ToLower(s), "</"+name)
			body := s
			if end >= 0 {
				body = s[:end]
				s = s[end:]
			} else {
				s = ""
			}
			if name == "style" {
				css(body)
			}
		}
	}
	return r
}

var metaRe = regexp.MustCompile(`(?is)<meta\b([^>]*)>`)

// WantsTheme reports whether a page asks to follow MotherGoose's theme and
// font, with <meta name="mothergoose" content="theme"> (in its first 64 KiB).
func WantsTheme(doc []byte) bool {
	if len(doc) > 64<<10 {
		doc = doc[:64<<10]
	}
	for _, m := range metaRe.FindAllSubmatch(doc, -1) {
		a := parseAttrs(string(m[1]))
		if strings.EqualFold(strings.TrimSpace(a["name"]), "mothergoose") {
			for _, w := range strings.Fields(strings.ToLower(a["content"])) {
				if w == "theme" {
					return true
				}
			}
		}
	}
	return false
}

// classify says whether a reference stays inside the page ("" — fragments,
// data: and blob: URLs, mailto: and the like), goes to the internet ("web")
// or to a file beside the page ("local").
func classify(u string) string {
	if u == "" || strings.HasPrefix(u, "#") {
		return ""
	}
	low := strings.ToLower(u)
	switch {
	case strings.HasPrefix(low, "http://"), strings.HasPrefix(low, "https://"), strings.HasPrefix(low, "//"):
		return "web"
	case strings.HasPrefix(low, "file:"):
		return "local"
	case schemeRe.MatchString(u):
		return "" // data:, blob:, mailto:, tel:, javascript:, about:…
	}
	return "local"
}

// srcsetURLs splits "a.png 1x, b.png 2x" into its URLs. A URL runs to the
// next space (a data: URL has commas in it); its size follows, up to a comma.
func srcsetURLs(s string) []string {
	var out []string
	for {
		s = strings.TrimLeft(s, " \t\n\r\f,")
		if s == "" {
			return out
		}
		end := strings.IndexAny(s, " \t\n\r\f")
		if end < 0 {
			end = len(s)
		}
		out = append(out, strings.TrimRight(s[:end], ","))
		s = s[end:]
		if c := strings.IndexByte(s, ','); c >= 0 {
			s = s[c:]
		} else {
			return out
		}
	}
}

func parseAttrs(s string) map[string]string {
	out := map[string]string{}
	for _, m := range attrRe.FindAllStringSubmatch(s, -1) {
		k := strings.ToLower(m[1])
		if _, seen := out[k]; !seen {
			out[k] = m[2] + m[3] + m[4]
		}
	}
	return out
}

// countField counts an element the page script saves: inputs (other than
// the kinds it skips), textareas, selects and editable areas.
func countField(r *Report, name string, attrs map[string]string) {
	if _, ignored := attrs["data-mg-ignore"]; ignored {
		return
	}
	saved := false
	switch name {
	case "input":
		saved = !unsavedInputs[strings.ToLower(strings.TrimSpace(attrs["type"]))]
	case "textarea", "select":
		saved = true
	default:
		v, ok := attrs["contenteditable"]
		saved = ok && strings.ToLower(strings.TrimSpace(v)) != "false"
	}
	if !saved {
		return
	}
	r.Fields++
	if strings.TrimSpace(attrs["id"]) == "" && strings.TrimSpace(attrs["name"]) == "" {
		r.Unnamed++
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
