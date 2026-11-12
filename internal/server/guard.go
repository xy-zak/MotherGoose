package server

import (
	"net"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"sync"
)

// guard wraps every route with the protections that don't depend on the
// route itself. The host check (isHost) trusts the caller's IP address, and a
// web page the referee happens to visit runs on that same machine, so:
//
//   - The Host header must name this machine. That stops DNS rebinding, where
//     a site points its own domain at 127.0.0.1 and then reads our responses
//     as if they were its own.
//   - State-changing requests must come from our own pages. That stops other
//     sites posting forms or fetches to http://localhost:8080 (CSRF).
//   - Our pages may only be framed by our own pages, which stops clickjacking.
func (s *Server) guard(next http.Handler) http.Handler {
	csrf := http.NewCrossOriginProtection()
	csrf.SetDenyHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.forbid(w, r, "This request came from another website, so it was refused.")
	}))
	inner := csrf.Handler(next)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !trustedHost(r.Host) {
			s.forbid(w, r, "Open MotherGoose by its IP address (shown on the dashboard) or as localhost on the host computer.")
			return
		}
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		w.Header().Set("Content-Security-Policy", "frame-ancestors 'self'")
		inner.ServeHTTP(w, r)
	})
}

// trustedHost reports whether a Host header names this machine in a way that
// a DNS-rebinding site cannot imitate: an IP address, localhost, or the
// machine's own name.
func trustedHost(hostport string) bool {
	h := hostport
	if host, _, err := net.SplitHostPort(hostport); err == nil {
		h = host
	}
	h = strings.TrimSuffix(strings.Trim(h, "[]"), ".")
	if h == "" {
		return false
	}
	if _, err := netip.ParseAddr(h); err == nil {
		return true // the page's origin is the address itself, so no other site can send it
	}
	h = strings.ToLower(h)
	if h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return true // browsers resolve these to loopback themselves
	}
	name := machineName()
	return name != "" && (h == name || h == name+".local")
}

var machineName = sync.OnceValue(func() string {
	n, _ := os.Hostname()
	return strings.ToLower(strings.TrimSuffix(n, ".local"))
})
