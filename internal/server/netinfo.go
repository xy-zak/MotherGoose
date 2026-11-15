package server

import (
	"fmt"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// localIPs caches the machine's own interface addresses for a few seconds.
var localIPs = struct {
	sync.Mutex
	at  time.Time
	ips []net.IP
}{}

func ownIPs() []net.IP {
	localIPs.Lock()
	defer localIPs.Unlock()
	if time.Since(localIPs.at) < 10*time.Second && localIPs.ips != nil {
		return localIPs.ips
	}
	var ips []net.IP
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok {
			ips = append(ips, n.IP)
		}
	}
	localIPs.ips, localIPs.at = ips, time.Now()
	return ips
}

// isHostRequest reports whether the request comes from the server machine
// itself: loopback, or one of this machine's own addresses (the referee opening
// the LAN URL on the host).
func isHostRequest(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	if ip == nil {
		return false
	}
	if ip.IsLoopback() {
		return true
	}
	for _, own := range ownIPs() {
		if own.Equal(ip) {
			return true
		}
	}
	return false
}

// lanCand is one of this computer's addresses that players might use.
type lanCand struct {
	ip    string
	net   *net.IPNet
	iface string
	score int
}

// lanCands lists this computer's IPv4 addresses on its networks, the likeliest
// home or office network first (192.168.x, then 10.x, then 172.16-31.x), and
// virtual ones (Docker, VPNs) last.
func lanCands() []lanCand {
	var cands []lanCand
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		name := strings.ToLower(ifc.Name)
		virtual := false
		for _, p := range []string{"docker", "br-", "veth", "virbr", "vmnet", "vbox", "tailscale", "zt", "utun", "tun", "tap", "wg", "lxc", "podman", "cni"} {
			if strings.HasPrefix(name, p) {
				virtual = true
			}
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			n, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := n.IP.To4()
			if ip4 == nil || ip4.IsLinkLocalUnicast() {
				continue
			}
			score := 0
			switch {
			case ip4[0] == 192 && ip4[1] == 168:
				score = 30
			case ip4[0] == 10:
				score = 20
			case ip4[0] == 172 && ip4[1] >= 16 && ip4[1] <= 31:
				score = 10
			}
			if virtual {
				score -= 50
			}
			cands = append(cands, lanCand{ip4.String(), &net.IPNet{IP: ip4.Mask(n.Mask), Mask: n.Mask}, ifc.Name, score})
		}
	}
	sort.SliceStable(cands, func(i, j int) bool { return cands[i].score > cands[j].score })
	return cands
}

// LocalNetwork is the network players' devices are most likely on (the
// first of the join addresses), and its interface; nil when there's none.
func LocalNetwork() (*net.IPNet, string) {
	for _, c := range lanCands() {
		if c.score > 0 {
			return c.net, c.iface
		}
	}
	return nil, ""
}

// LANURLs lists http URLs players can use, best guess first.
func LANURLs(port int) []string {
	urls := []string{}
	seen := map[string]bool{}
	for _, c := range lanCands() {
		if !seen[c.ip] {
			seen[c.ip] = true
			urls = append(urls, "http://"+c.ip+":"+strconv.Itoa(port)+"/")
		}
	}
	return urls
}

// localLabelRe is one DNS label: what <name>.local needs to be reachable.
var localLabelRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// LocalNameURL is the players' address by this computer's name on the local
// network, http://<name>.local:<port>/. Many networks answer to it (macOS,
// most Linux desktops and Windows 10+ announce their name), and unlike an IP
// address it stays the same from one game night to the next. It is "" when
// the computer's name can't be used that way. Whether a given device can
// reach it is only known by trying: the dashboard checks before offering it
// first.
func LocalNameURL(port int) string {
	return localNameURL(machineName(), port)
}

func localNameURL(name string, port int) string {
	if !localLabelRe.MatchString(name) {
		return ""
	}
	return fmt.Sprintf("http://%s.local:%d/", name, port)
}
