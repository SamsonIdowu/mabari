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

// isOwnOrigin reports whether a request came from one of Mabari's own pages: a local origin whose
// host and port are the ones the request was sent to. Other local servers, such as a dev server an
// agent started on another port, are refused too. Browsers always send Origin on writes and
// WebSocket upgrades, so another website can't pass this. "null" comes from sandboxed frames and is
// refused. In dev the Vite proxy keeps the browser's Host, so it still matches.
func isOwnOrigin(origin, host string, anyHost bool) bool {
	parsed, err := url.Parse(origin)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return false
	}
	return (anyHost || isLocalHost(parsed.Host)) && strings.EqualFold(parsed.Host, host)
}

// fromPage lets through only a request from Mabari's own page, for what must follow a person's
// click: turning on auto approve, trusting a folder, wiping, deciding an approval. localOnly lets a
// request with no Origin pass, which is what curl sends, so without this a command an agent was
// allowed to run could approve its own next step. Browsers always send Origin on a POST, and a page
// can't choose it. The mabari command doesn't use these routes.
//
// This raises the bar for a stray or injected command, and is not a security boundary: a program
// running as the same user can set any header it likes, and can read Mabari's files besides. See
// docs/INTEGRATIONS.md.
func (a *api) fromPage(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == "" || !isOwnOrigin(origin, r.Host, a.anyHost()) {
			writeError(w, http.StatusForbidden, "This can only be done from Mabari's own page.")
			return
		}
		next(w, r)
	}
}

// localOnly refuses anything that didn't come from this computer. It runs on every request,
// including WebSocket upgrades, even when Mabari is bound to 0.0.0.0 inside Docker.
//
// anyHost lets other names through, as when LAN access is on or Mabari listens beyond loopback.
// Then the sign in is what keeps others out, because a request under any other name needs it.
func localOnly(next http.Handler, anyHost func() bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		open := anyHost()
		if !open && !isLocalHost(r.Host) {
			writeError(w, http.StatusForbidden, "this host is not allowed")
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && !isOwnOrigin(origin, r.Host, open) {
			writeError(w, http.StatusForbidden, "this origin is not allowed")
			return
		}
		next.ServeHTTP(w, r)
	})
}
