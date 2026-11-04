// SPDX-License-Identifier: Apache-2.0

package server

import (
	"net"
	"net/http"
	"net/url"
	"strings"
)

// isLocalHost reports whether a Host header value names this computer. Checking the name stops
// DNS rebinding, where a website points its own domain at 127.0.0.1 to reach local servers.
func isLocalHost(host string) bool {
	name := host
	if withoutPort, _, err := net.SplitHostPort(host); err == nil {
		name = withoutPort
	}
	name = strings.Trim(name, "[]")
	switch strings.ToLower(name) {
	case "localhost", "127.0.0.1", "::1":
		return true
	default:
		return false
	}
}

// isLocalOrigin reports whether a request came from a page on this computer. Mabari's own pages are
// the only local ones served here. Browsers always send Origin on writes and WebSocket upgrades,
// so another website can't pass this. "null" comes from sandboxed frames and is refused.
func isLocalOrigin(origin string) bool {
	parsed, err := url.Parse(origin)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return false
	}
	return isLocalHost(parsed.Host)
}

// localOnly refuses anything that didn't come from this computer. It runs on every request,
// including WebSocket upgrades, even when Mabari is bound to 0.0.0.0 inside Docker.
func localOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isLocalHost(r.Host) {
			writeError(w, http.StatusForbidden, "this host is not allowed")
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && !isLocalOrigin(origin) {
			writeError(w, http.StatusForbidden, "this origin is not allowed")
			return
		}
		next.ServeHTTP(w, r)
	})
}
