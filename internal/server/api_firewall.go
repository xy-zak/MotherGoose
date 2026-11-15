package server

import (
	"context"
	"errors"
	"net"
	"net/http"
	"time"

	"mothergoose/internal/firewall"
)

// firewallChecker is what the server needs from the firewall package.
type firewallChecker interface {
	Check(port int, network *net.IPNet, iface string) firewall.Status
	Allow(ctx context.Context, st firewall.Status, iface string) error
}

// FirewallStatus is whether this computer's firewall lets players' devices
// reach port, for the startup message.
func FirewallStatus(port int) firewall.Status {
	network, iface := LocalNetwork()
	return firewall.New().Check(port, network, iface)
}

// firewallStatus checks at most every few seconds: the dashboard asks on
// every start, and a check can run firewall-cmd.
func (s *Server) firewallStatus(fresh bool) firewall.Status {
	s.fwMu.Lock()
	defer s.fwMu.Unlock()
	if fresh || time.Since(s.fwAt) > 5*time.Second {
		network, iface := LocalNetwork()
		s.fwLast, s.fwAt = s.firewall.Check(s.port, network, iface), time.Now()
	}
	return s.fwLast
}

// apiFirewall says whether players' devices can get through this computer's
// firewall, and what would let them in.
func (s *Server) apiFirewall(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.firewallStatus(r.URL.Query().Has("fresh")))
}

// apiFirewallAllow lets players in: it asks for the referee's password in the
// desktop's own prompt and adds one rule, for MotherGoose's port and the
// local network only. It answers once the prompt has been answered, with the
// firewall checked again.
func (s *Server) apiFirewallAllow(w http.ResponseWriter, r *http.Request) {
	st := s.firewallStatus(true)
	if st.State == firewall.StateOK || st.State == firewall.StateNone {
		writeJSON(w, http.StatusOK, st)
		return
	}
	if !st.CanFix {
		jsonError(w, http.StatusConflict, "MotherGoose can't change this firewall itself: run the command shown in a terminal.")
		return
	}
	_, iface := LocalNetwork()
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	if err := s.firewall.Allow(ctx, st, iface); err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, firewall.ErrNotAllowed) || errors.Is(err, firewall.ErrNoPrompt) {
			status = http.StatusConflict
		}
		jsonError(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, s.firewallStatus(true))
}
