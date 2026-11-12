package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// request builds a request from the host machine; edit adjusts it before it is sent.
func (f *fixture) request(method, path, body string, edit func(*http.Request)) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Host = "localhost:8080"
	req.RemoteAddr = host
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if edit != nil {
		edit(req)
	}
	rec := httptest.NewRecorder()
	f.srv.ServeHTTP(rec, req)
	return rec
}

func TestCrossSiteRequestsAreRefused(t *testing.T) {
	f := setup(t)
	create := `{"name":"from elsewhere"}`
	cases := []struct {
		name string
		edit func(*http.Request)
		want int
	}{
		{"same origin (fetch metadata)", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "same-origin") }, 201},
		{"same origin (Origin only)", func(r *http.Request) { r.Header.Set("Origin", "http://localhost:8080") }, 201},
		{"no browser headers (curl)", nil, 201},
		{"cross-site fetch metadata", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }, 403},
		{"foreign Origin", func(r *http.Request) { r.Header.Set("Origin", "http://evil.example") }, 403},
		{"text/plain body (simple request)", func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, 415},
		{"form body (simple request)", func(r *http.Request) {
			r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		}, 415},
	}
	for _, c := range cases {
		if got := f.request("POST", "/api/admin/sessions", create, c.edit).Code; got != c.want {
			t.Errorf("%s: status %d, want %d", c.name, got, c.want)
		}
	}

	// A cross-site multipart upload is what a malicious page could actually send.
	up := f.request("POST", "/api/admin/sessions/"+f.id+"/files", "--x--\r\n", func(r *http.Request) {
		r.Header.Set("Content-Type", "multipart/form-data; boundary=x")
		r.Header.Set("Sec-Fetch-Site", "cross-site")
	})
	if up.Code != 403 {
		t.Errorf("cross-site upload: status %d, want 403", up.Code)
	}
	// Bodiless actions are covered too.
	if got := f.request("POST", "/api/admin/sessions/"+f.id+"/activate", "", func(r *http.Request) {
		r.Header.Set("Origin", "http://evil.example")
	}).Code; got != 403 {
		t.Errorf("cross-site activate: status %d, want 403", got)
	}
}

func TestDNSRebindingIsRefused(t *testing.T) {
	f := setup(t)
	// The request really comes from this machine, but names someone else's
	// domain: a site that pointed its DNS at 127.0.0.1.
	for _, path := range []string{"/admin", "/api/admin/sessions", "/s/" + f.id + "/gm/secrets.html", "/"} {
		rec := f.request("GET", path, "", func(r *http.Request) { r.Host = "attacker.example:8080" })
		if rec.Code != 403 {
			t.Errorf("GET %s with foreign Host: status %d, want 403", path, rec.Code)
		}
		if strings.Contains(rec.Body.String(), "lich") {
			t.Fatalf("GM page leaked through %s", path)
		}
	}
	for _, h := range []string{"localhost:8080", "127.0.0.1:8080", "[::1]:8080", "192.168.1.20:8080", "LOCALHOST", "mg.localhost:8080", "localhost.:8080"} {
		if !trustedHost(h) {
			t.Errorf("trustedHost(%q) = false", h)
		}
	}
	for _, h := range []string{"", "attacker.example", "localhost.attacker.example", "127.0.0.1.nip.io:8080"} {
		if trustedHost(h) {
			t.Errorf("trustedHost(%q) = true", h)
		}
	}
}

func TestPagesCannotBeFramedByOtherSites(t *testing.T) {
	f := setup(t)
	for _, path := range []string{"/admin", "/", "/s/" + f.id + "/shared/sheet.html"} {
		h := f.do("GET", path, host).Header()
		if h.Get("X-Frame-Options") != "SAMEORIGIN" || h.Get("Content-Security-Policy") != "frame-ancestors 'self'" {
			t.Errorf("GET %s: framing headers = %q / %q", path, h.Get("X-Frame-Options"), h.Get("Content-Security-Policy"))
		}
	}
}

func TestInjectBeforeKeepsOffsets(t *testing.T) {
	cases := []struct{ doc, want string }{
		{"<body><p>x</p></body></html>", "<body><p>x</p><X></body></html>"},
		{"<BODY>x</BODY>", "<BODY>x<X></BODY>"},
		// Not valid UTF-8 (a Latin-1 page): lower-casing a copy used to shift the offset.
		{"<body>caf\xe9 \xe9\xe9\xe9\xe9</body></html>", "<body>caf\xe9 \xe9\xe9\xe9\xe9<X></body></html>"},
		// Characters whose lower-case form has a different byte length.
		{"<body>İİİİ K</body>", "<body>İİİİ K<X></body>"},
		{"<script>s='</body>'</script></body>", "<script>s='</body>'</script><X></body>"},
		{"<p>no body", "<p>no body\n<X>"},
	}
	for _, c := range cases {
		if got := string(injectBefore([]byte(c.doc), "<X>")); got != c.want {
			t.Errorf("injectBefore(%q)\n got %q\nwant %q", c.doc, got, c.want)
		}
	}
}
