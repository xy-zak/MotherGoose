package firewall

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func lan(t *testing.T) *net.IPNet {
	t.Helper()
	_, n, err := net.ParseCIDR("192.168.1.0/24")
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// fakeUfw writes ufw's settings into a pretend /etc.
func fakeUfw(t *testing.T, enabled bool, policy string, rules ...string) *Checker {
	t.Helper()
	etc := t.TempDir()
	write := func(p, s string) {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	on := "no"
	if enabled {
		on = "yes"
	}
	write(filepath.Join(etc, "ufw", "ufw.conf"), "# comment\nENABLED="+on+"\nLOGLEVEL=low\n")
	write(filepath.Join(etc, "default", "ufw"), "IPV6=yes\nDEFAULT_INPUT_POLICY=\""+policy+"\"\n")
	write(filepath.Join(etc, "ufw", "user.rules"), "*filter\n"+strings.Join(rules, "\n")+"\nCOMMIT\n")
	return &Checker{OS: "linux", Etc: etc,
		Run:  func(string, ...string) (string, error) { return "", errors.New("not installed") },
		Look: func(name string) bool { return name == "pkexec" }}
}

func TestUfw(t *testing.T) {
	n := lan(t)
	cases := []struct {
		name    string
		enabled bool
		policy  string
		rules   []string
		want    string
	}{
		{"off", false, "DROP", nil, StateNone},
		{"accepting", true, "ACCEPT", nil, StateOK},
		{"no rule", true, "DROP", []string{"### tuple ### allow tcp 53317 0.0.0.0/0 any 0.0.0.0/0 in"}, StateBlocked},
		{"port from anywhere", true, "DROP", []string{"### tuple ### allow tcp 8080 0.0.0.0/0 any 0.0.0.0/0 in"}, StateOK},
		{"port from the network", true, "DROP", []string{"### tuple ### allow tcp 8080 0.0.0.0/0 any 192.168.1.0/24 in comment=4d6f74686572476f6f7365"}, StateOK},
		{"port from a wider network", true, "DROP", []string{"### tuple ### allow any 8080 0.0.0.0/0 any 192.168.0.0/16 in"}, StateOK},
		{"port from one device only", true, "DROP", []string{"### tuple ### allow tcp 8080 0.0.0.0/0 any 192.168.1.20 in"}, StateBlocked},
		{"another network", true, "DROP", []string{"### tuple ### allow tcp 8080 0.0.0.0/0 any 10.0.0.0/8 in"}, StateBlocked},
		{"udp only", true, "DROP", []string{"### tuple ### allow udp 8080 0.0.0.0/0 any 0.0.0.0/0 in"}, StateBlocked},
		{"a range", true, "DROP", []string{"### tuple ### allow tcp 8000:8100 0.0.0.0/0 any 0.0.0.0/0 in"}, StateOK},
		{"a list", true, "DROP", []string{"### tuple ### allow tcp 80,443,8080 0.0.0.0/0 any 0.0.0.0/0 in"}, StateOK},
		{"denied", true, "DROP", []string{"### tuple ### deny tcp 8080 0.0.0.0/0 any 0.0.0.0/0 in"}, StateBlocked},
		{"to this computer", true, "DROP", []string{"### tuple ### allow tcp 8080 192.168.1.168 any 0.0.0.0/0 in"}, StateOK},
		{"an application", true, "DROP", []string{"### tuple ### allow any 8080 0.0.0.0/0 any 0.0.0.0/0 Web - in"}, StateOK},
		{"everything from the network", true, "DROP", []string{"### tuple ### allow any any 0.0.0.0/0 any 192.168.1.0/24 in"}, StateOK},
	}
	for _, c := range cases {
		st := fakeUfw(t, c.enabled, c.policy, c.rules...).Check(8080, n, "wlan0")
		if st.State != c.want {
			t.Errorf("%s: %s, want %s", c.name, st.State, c.want)
		}
		if c.want == StateBlocked && (!st.CanFix || st.Firewall != "ufw" || st.Command != "sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp comment MotherGoose") {
			t.Errorf("%s: %+v", c.name, st)
		}
	}
}

func TestUfwRulesUnreadable(t *testing.T) {
	c := fakeUfw(t, true, "DROP")
	os.Remove(filepath.Join(c.Etc, "ufw", "user.rules"))
	if st := c.Check(8080, lan(t), ""); st.State != StateUnknown || !st.CanFix {
		t.Fatalf("%+v", st)
	}
}

func TestOtherSystemsAskThemselves(t *testing.T) {
	for _, osName := range []string{"windows", "darwin"} {
		c := &Checker{OS: osName, Etc: "/nonexistent", Look: func(string) bool { return true }}
		if st := c.Check(8080, lan(t), ""); st.State != StateNone || st.CanFix {
			t.Errorf("%s: %+v", osName, st)
		}
	}
}

func TestFirewalld(t *testing.T) {
	answers := map[string]string{}
	c := &Checker{OS: "linux", Etc: t.TempDir(), Look: func(string) bool { return true },
		Run: func(name string, args ...string) (string, error) {
			if v, ok := answers[strings.Join(args, " ")]; ok {
				return v, nil
			}
			return "", errors.New("exit 1")
		}}
	answers["--state"] = "running"
	answers["--get-zone-of-interface=wlan0"] = "home"
	answers["--zone=home --query-port=8080/tcp"] = "no"
	answers["--zone=home --list-rich-rules"] = ""
	st := c.Check(8080, lan(t), "wlan0")
	if st.State != StateBlocked || st.Firewall != "firewalld" || !strings.Contains(st.Command, "--zone=home") || !st.CanFix {
		t.Fatalf("blocked: %+v", st)
	}
	answers["--zone=home --list-rich-rules"] = `rule family="ipv4" source address="192.168.1.0/24" port port="8080" protocol="tcp" accept`
	if st := c.Check(8080, lan(t), "wlan0"); st.State != StateOK {
		t.Fatalf("rich rule: %+v", st)
	}
	answers["--zone=home --query-port=8080/tcp"] = "yes"
	answers["--zone=home --list-rich-rules"] = ""
	if st := c.Check(8080, lan(t), "wlan0"); st.State != StateOK {
		t.Fatalf("port open: %+v", st)
	}
}

func TestNoNetwork(t *testing.T) {
	c := fakeUfw(t, true, "DROP")
	if st := c.Check(8080, nil, ""); st.State != StateNone {
		t.Fatalf("%+v", st)
	}
}
