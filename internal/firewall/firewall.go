// Package firewall finds out whether this computer's firewall lets players'
// devices reach MotherGoose, and can ask the referee's permission to let them
// in.
//
// Windows and macOS ask the user themselves the first time a program listens
// on the network, so there is nothing to do there. Linux firewalls (ufw,
// firewalld) never ask: they drop the connections, and nobody finds out why
// players can't join. A request from this computer to its own address never
// passes through the firewall, so the only way to know is to read the
// firewall's settings, which both of them allow without admin rights.
//
// Letting players in always needs the referee's password: the change is run
// through pkexec, which shows the desktop's own password prompt. The rule
// only opens MotherGoose's port, and only to the local network.
package firewall

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// What a check found.
const (
	StateOK      = "ok"      // players can reach the port, as far as the firewall goes
	StateBlocked = "blocked" // the firewall drops connections to the port from the network
	StateUnknown = "unknown" // a firewall is on, but its settings can't be read
	StateNone    = "none"    // no firewall to worry about (or the system asks by itself)
)

// Status is what a check found, and what would let players in.
type Status struct {
	State    string `json:"state"`
	Firewall string `json:"firewall,omitempty"` // "ufw" or "firewalld"
	Port     int    `json:"port"`
	Network  string `json:"network,omitempty"` // the local network players are on, e.g. 192.168.1.0/24
	// Command is what to run in a terminal to let players in, when the
	// button can't (or the referee would rather do it by hand).
	Command string `json:"command,omitempty"`
	// CanFix: MotherGoose can make the change itself, after asking for the
	// password in the desktop's own prompt.
	CanFix bool `json:"canFix"`
}

// Checker reads the firewall's settings. Its fields let tests point it at
// a pretend system.
type Checker struct {
	OS   string                                            // runtime.GOOS
	Etc  string                                            // where ufw keeps its settings: /etc
	Run  func(name string, args ...string) (string, error) // runs a command, returning its output
	Look func(name string) bool                            // whether a command is installed
}

// New is a Checker for this computer.
func New() *Checker {
	return &Checker{
		OS:  runtime.GOOS,
		Etc: "/etc",
		Run: func(name string, args ...string) (string, error) {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			out, err := exec.CommandContext(ctx, name, args...).Output()
			return strings.TrimSpace(string(out)), err
		},
		Look: func(name string) bool { _, err := exec.LookPath(name); return err == nil },
	}
}

// Check finds out whether devices on network (the referee's local network)
// can reach port. iface is the network interface it is on ("" if unknown).
func (c *Checker) Check(port int, network *net.IPNet, iface string) Status {
	st := Status{State: StateNone, Port: port}
	if network != nil {
		st.Network = network.String()
	}
	if c.OS != "linux" || network == nil {
		return st
	}
	if c.ufwEnabled() {
		st.Firewall = "ufw"
		st.State = c.ufwState(port, network)
		st.Command = UfwCommand(port, network)
	} else if c.Look("firewall-cmd") {
		if state, err := c.Run("firewall-cmd", "--state"); err == nil && state == "running" {
			st.Firewall = "firewalld"
			zone := c.firewalldZone(iface)
			st.State = c.firewalldState(port, network, zone)
			st.Command = strings.Join(FirewalldCommands(port, network, zone), " && ")
		}
	}
	st.CanFix = st.State != StateOK && st.State != StateNone && c.Look("pkexec")
	return st
}

// ---- ufw ------------------------------------------------------------------------------

func (c *Checker) ufwEnabled() bool {
	return confValue(filepath.Join(c.Etc, "ufw", "ufw.conf"), "ENABLED") == "yes"
}

// ufwState reads ufw's default policy and the rules added with "ufw allow".
func (c *Checker) ufwState(port int, network *net.IPNet) string {
	if p := confValue(filepath.Join(c.Etc, "default", "ufw"), "DEFAULT_INPUT_POLICY"); p == "ACCEPT" {
		return StateOK
	}
	f, err := os.Open(filepath.Join(c.Etc, "ufw", "user.rules"))
	if err != nil {
		return StateUnknown
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if r, ok := parseUfwTuple(sc.Text()); ok && r.lets(port, network) {
			return StateOK
		}
	}
	return StateBlocked
}

// ufwRule is one "### tuple ###" line of user.rules, which ufw writes for
// every rule added with "ufw allow":
//
//	### tuple ### allow tcp 8080 0.0.0.0/0 any 192.168.1.0/24 in
//	### tuple ### allow any 22 0.0.0.0/0 any 0.0.0.0/0 OpenSSH - in
type ufwRule struct {
	action, proto, dport, dst, src, dir string
}

func parseUfwTuple(line string) (ufwRule, bool) {
	rest, ok := strings.CutPrefix(line, "### tuple ### ")
	if !ok {
		return ufwRule{}, false
	}
	f := strings.Fields(rest)
	if len(f) < 7 {
		return ufwRule{}, false
	}
	// Rules for named applications have two extra fields (the names) before
	// the direction; the direction is always last, before any comment.
	r := ufwRule{action: f[0], proto: f[1], dport: f[2], dst: f[3], src: f[5], dir: f[6]}
	if len(f) >= 9 && !strings.HasPrefix(f[6], "in") && !strings.HasPrefix(f[6], "out") {
		r.dir = f[8]
	}
	return r, true
}

// lets reports whether the rule lets TCP connections from every device on
// network reach port.
func (r ufwRule) lets(port int, network *net.IPNet) bool {
	if (r.action != "allow" && r.action != "limit") || !strings.HasPrefix(r.dir, "in") {
		return false
	}
	if r.proto != "tcp" && r.proto != "any" {
		return false
	}
	return portIn(r.dport, port) && covers(r.src, network) && (r.dst == "0.0.0.0/0" || r.dst == "any" || within(r.dst, network))
}

// UfwCommand is the command that lets players in through ufw.
func UfwCommand(port int, network *net.IPNet) string {
	return fmt.Sprintf("sudo ufw allow from %s to any port %d proto tcp comment MotherGoose", network, port)
}

// ---- firewalld -------------------------------------------------------------------------

func (c *Checker) firewalldZone(iface string) string {
	if iface != "" {
		if z, err := c.Run("firewall-cmd", "--get-zone-of-interface="+iface); err == nil && z != "" {
			return z
		}
	}
	z, _ := c.Run("firewall-cmd", "--get-default-zone")
	return z
}

func (c *Checker) firewalldState(port int, network *net.IPNet, zone string) string {
	if zone == "" {
		return StateUnknown
	}
	if zone == "trusted" {
		return StateOK
	}
	ans, err := c.Run("firewall-cmd", "--zone="+zone, "--query-port="+strconv.Itoa(port)+"/tcp")
	if ans == "yes" {
		return StateOK
	}
	if err != nil && ans != "no" {
		return StateUnknown
	}
	rules, err := c.Run("firewall-cmd", "--zone="+zone, "--list-rich-rules")
	if err != nil {
		return StateUnknown
	}
	for _, rule := range strings.Split(rules, "\n") {
		if strings.Contains(rule, `port="`+strconv.Itoa(port)+`"`) && strings.Contains(rule, "accept") &&
			(!strings.Contains(rule, "source address") || strings.Contains(rule, `source address="`+network.String()+`"`)) {
			return StateOK
		}
	}
	return StateBlocked
}

func richRule(port int, network *net.IPNet) string {
	return fmt.Sprintf(`rule family="ipv4" source address="%s" port port="%d" protocol="tcp" accept`, network, port)
}

// FirewalldCommands are the commands that let players in through firewalld:
// now, and after a restart.
func FirewalldCommands(port int, network *net.IPNet, zone string) []string {
	r := "'" + richRule(port, network) + "'"
	return []string{
		"sudo firewall-cmd --zone=" + zone + " --add-rich-rule=" + r,
		"sudo firewall-cmd --permanent --zone=" + zone + " --add-rich-rule=" + r,
	}
}

// ---- letting players in -----------------------------------------------------------------

// ErrNotAllowed means the password prompt was dismissed, or the password
// wasn't accepted.
var ErrNotAllowed = errors.New("the firewall wasn't changed: the password prompt was closed, or the password wasn't accepted")

// ErrNoPrompt means there is no desktop password prompt to ask with.
var ErrNoPrompt = errors.New("there is no password prompt on this desktop to ask with: run the command in a terminal instead")

// Allow adds the rule that lets players in, asking for the password with
// pkexec. It blocks until the referee answers the prompt (or ctx ends).
// Everything in the command comes from the check, never from a request.
func (c *Checker) Allow(ctx context.Context, st Status, iface string) error {
	_, network, err := net.ParseCIDR(st.Network)
	if err != nil || st.Port <= 0 || st.Port > 65535 {
		return fmt.Errorf("no local network to let players in from")
	}
	var args []string
	switch st.Firewall {
	case "ufw":
		args = []string{"ufw", "allow", "from", network.String(), "to", "any", "port", strconv.Itoa(st.Port), "proto", "tcp", "comment", "MotherGoose"}
	case "firewalld":
		zone := c.firewalldZone(iface)
		if zone == "" {
			return fmt.Errorf("couldn't find firewalld's zone for this network")
		}
		// Now, and after a restart: two commands, so one pkexec runs a shell.
		// The rule is built from a parsed network and a number, so it is
		// safe to quote.
		r := richRule(st.Port, network)
		args = []string{"sh", "-c", "firewall-cmd --zone=" + zone + " --add-rich-rule='" + r + "' && firewall-cmd --permanent --zone=" + zone + " --add-rich-rule='" + r + "'"}
	default:
		return fmt.Errorf("there is no firewall MotherGoose knows how to change")
	}
	cmd := exec.CommandContext(ctx, "pkexec", args...)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		switch exit.ExitCode() {
		case 126:
			return ErrNotAllowed
		case 127:
			if strings.Contains(strings.ToLower(string(out)), "agent") {
				return ErrNoPrompt
			}
			return ErrNotAllowed
		}
	}
	return fmt.Errorf("changing the firewall failed: %s", strings.TrimSpace(string(out)))
}

// ---- helpers ---------------------------------------------------------------------------

// confValue reads KEY=value (quotes removed) from a shell-style settings file.
func confValue(path, key string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		k, v, ok := strings.Cut(strings.TrimSpace(sc.Text()), "=")
		if ok && k == key {
			return strings.Trim(strings.TrimSpace(v), `"'`)
		}
	}
	return ""
}

// portIn reports whether port is in a ufw port list: "any", "8080",
// "8000:8100" or "80,443,8080".
func portIn(list string, port int) bool {
	if list == "any" {
		return true
	}
	for _, part := range strings.Split(list, ",") {
		lo, hi, isRange := strings.Cut(part, ":")
		a, err := strconv.Atoi(lo)
		if err != nil {
			continue
		}
		b := a
		if isRange {
			if b, err = strconv.Atoi(hi); err != nil {
				continue
			}
		}
		if port >= a && port <= b {
			return true
		}
	}
	return false
}

// covers reports whether src (an address or network) includes every
// address of network.
func covers(src string, network *net.IPNet) bool {
	if src == "any" || src == "0.0.0.0/0" {
		return true
	}
	if !strings.Contains(src, "/") {
		return false // one address: not the whole network
	}
	_, n, err := net.ParseCIDR(src)
	if err != nil {
		return false
	}
	have, _ := n.Mask.Size()
	want, _ := network.Mask.Size()
	return n.Contains(network.IP) && have <= want
}

// within reports whether dst (this computer's address, or a network around
// it) is on network: a rule for connections to this computer's own address.
func within(dst string, network *net.IPNet) bool {
	if !strings.Contains(dst, "/") {
		d := net.ParseIP(dst)
		return d != nil && network.Contains(d)
	}
	_, n, err := net.ParseCIDR(dst)
	return err == nil && (n.Contains(network.IP) || network.Contains(n.IP))
}
