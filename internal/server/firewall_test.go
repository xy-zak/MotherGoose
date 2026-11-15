package server

import (
	"context"
	"net"
	"strings"
	"testing"

	"mothergoose/internal/firewall"
)

type fakeFirewall struct {
	st      firewall.Status
	allowed int
	err     error
}

func (f *fakeFirewall) Check(port int, _ *net.IPNet, _ string) firewall.Status {
	st := f.st
	st.Port = port
	return st
}

func (f *fakeFirewall) Allow(_ context.Context, _ firewall.Status, _ string) error {
	f.allowed++
	if f.err != nil {
		return f.err
	}
	f.st.State, f.st.CanFix = firewall.StateOK, false
	return nil
}

// The dashboard can ask whether players get through the firewall, and let
// them in; players' devices can do neither.
func TestFirewallRoutes(t *testing.T) {
	f := setup(t)
	fw := &fakeFirewall{st: firewall.Status{State: firewall.StateBlocked, Firewall: "ufw", Network: "192.168.1.0/24", CanFix: true, Command: "sudo ufw allow …"}}
	f.srv.firewall = fw
	if got := f.do("GET", "/api/admin/firewall", player).Code; got != 403 {
		t.Errorf("status from a player's device: %d", got)
	}
	if got := f.do("POST", "/api/admin/firewall/allow", player).Code; got != 403 {
		t.Errorf("allow from a player's device: %d", got)
	}
	rec := f.request("GET", "/api/admin/firewall", "", nil)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"state":"blocked"`) || !strings.Contains(rec.Body.String(), `"port":8080`) {
		t.Fatalf("status: %d %s", rec.Code, rec.Body.String())
	}
	rec = f.request("POST", "/api/admin/firewall/allow", "", nil)
	if rec.Code != 200 || fw.allowed != 1 || !strings.Contains(rec.Body.String(), `"state":"ok"`) {
		t.Fatalf("allow: %d %s (%d)", rec.Code, rec.Body.String(), fw.allowed)
	}
	// Already open: nothing to ask for.
	f.request("POST", "/api/admin/firewall/allow", "", nil)
	if fw.allowed != 1 {
		t.Errorf("asked again for an open firewall")
	}
	// The prompt dismissed: a readable refusal.
	fw.st = firewall.Status{State: firewall.StateBlocked, Firewall: "ufw", Network: "192.168.1.0/24", CanFix: true}
	fw.err = firewall.ErrNotAllowed
	rec = f.request("POST", "/api/admin/firewall/allow", "", nil)
	if rec.Code != 409 || !strings.Contains(rec.Body.String(), "password") {
		t.Fatalf("dismissed: %d %s", rec.Code, rec.Body.String())
	}
	// Nothing MotherGoose can change itself.
	fw.st.CanFix = false
	if rec := f.request("POST", "/api/admin/firewall/allow", "", nil); rec.Code != 409 {
		t.Fatalf("can't fix: %d", rec.Code)
	}
}
