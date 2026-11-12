package server

import (
	"net"
	"net/http"
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

// LANURLs lists http URLs players can use, best guess first.
func LANURLs(port int) []string {
	type cand struct {
		ip    string
		score int
	}
	var cands []cand
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
			cands = append(cands, cand{ip4.String(), score})
		}
	}
	sort.SliceStable(cands, func(i, j int) bool { return cands[i].score > cands[j].score })
	urls := []string{}
	seen := map[string]bool{}
	for _, c := range cands {
		if !seen[c.ip] {
			seen[c.ip] = true
			urls = append(urls, "http://"+c.ip+":"+strconv.Itoa(port)+"/")
		}
	}
	return urls
}
