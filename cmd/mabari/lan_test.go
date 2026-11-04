// SPDX-License-Identifier: Apache-2.0

package main

import (
	"net"
	"testing"
)

// LAN access listens on private addresses only, never on one the internet can reach.
func TestLANAddressesArePrivate(t *testing.T) {
	for address, want := range map[string]bool{
		"192.168.1.5": true, "10.0.0.2": true, "172.16.4.1": true, "169.254.3.3": true,
		"fd12:3456::1": true, "8.8.8.8": false, "2001:4860::8888": false, "127.0.0.1": false,
		"fe80::1": false, "172.32.0.1": false,
	} {
		if got := lanAddress(net.ParseIP(address)); got != want {
			t.Errorf("%s = %v, want %v", address, got, want)
		}
	}
}
