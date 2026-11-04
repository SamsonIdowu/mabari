// SPDX-License-Identifier: Apache-2.0

package main

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// lan listens on this computer's network addresses while LAN access is on, beside the usual
// 127.0.0.1 listener, so turning it on or off needs no restart. Every request that arrives
// through it has to sign in.
type lan struct {
	port    int
	handler func() http.Handler

	mu        sync.Mutex
	listeners []net.Listener
}

// networkAddresses are this computer's addresses on a private network: 10/8, 172.16/12,
// 192.168/16, IPv6 unique local, and link local. A public address is skipped, so turning on LAN
// access never puts Mabari on the internet.
func networkAddresses() []net.IP {
	var found []net.IP
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, address := range addresses {
			network, ok := address.(*net.IPNet)
			if !ok {
				continue
			}
			if lanAddress(network.IP) {
				found = append(found, network.IP)
			} else if network.IP.IsGlobalUnicast() {
				slog.Info("LAN access skips a public address", "address", network.IP)
			}
		}
	}
	return found
}

// lanAddress says whether Mabari may listen on ip for LAN access. IPv6 link local is left out
// because listening on it needs a zone, which the address doesn't carry.
func lanAddress(ip net.IP) bool {
	return ip.IsPrivate() || (ip.IsLinkLocalUnicast() && ip.To4() != nil)
}

// set starts or stops the network listeners and returns the addresses to show in Settings.
func (l *lan) set(on bool) ([]string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, listener := range l.listeners {
		_ = listener.Close()
	}
	l.listeners = nil
	if !on {
		return nil, nil
	}
	var shown []string
	for _, ip := range networkAddresses() {
		address := net.JoinHostPort(ip.String(), strconv.Itoa(l.port))
		listener, err := net.Listen("tcp", address)
		if err != nil {
			slog.Warn("LAN access: could not listen", "address", address, "error", err)
			continue
		}
		l.listeners = append(l.listeners, listener)
		shown = append(shown, "http://"+address)
		server := &http.Server{
			Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if handler := l.handler(); handler != nil {
					handler.ServeHTTP(w, r)
					return
				}
				http.Error(w, "starting", http.StatusServiceUnavailable)
			}),
			ReadHeaderTimeout: 10 * time.Second,
		}
		go func() {
			if err := server.Serve(listener); err != nil && !errors.Is(err, net.ErrClosed) {
				slog.Warn("LAN access stopped", "address", address, "error", err)
			}
		}()
	}
	if len(l.listeners) == 0 {
		return nil, fmt.Errorf("no private network address to listen on, on port %d", l.port)
	}
	slog.Info("LAN access on", "addresses", shown)
	return shown, nil
}
