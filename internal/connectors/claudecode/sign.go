// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"sync"
	"time"
)

// Hook calls are signed both ways with the install's token, which never crosses the wire. A
// program that takes Mabari's port while Mabari is down learns nothing it can use, and can't
// forge a reply the hook would print, such as an "allow".
const (
	NonceHeader     = "X-Mabari-Nonce"
	TimeHeader      = "X-Mabari-Time"
	SignatureHeader = "X-Mabari-Signature"
)

func mac(token string, parts ...[]byte) string {
	h := hmac.New(sha256.New, []byte(token))
	for _, part := range parts {
		h.Write(part)
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

// SignRequest signs one hook call: its event, a fresh nonce, the time it was sent and the body.
func SignRequest(token, nonce, sent, event string, body []byte) string {
	return mac(token, []byte("request"), []byte(nonce), []byte(sent), []byte(event), body)
}

// SignReply signs the server's reply to the call with that nonce, so it can't be replayed to
// another call.
func SignReply(token, nonce string, reply []byte) string {
	return mac(token, []byte("reply"), []byte(nonce), reply)
}

// Verify compares a signature in constant time.
func Verify(want, given string) bool {
	return hmac.Equal([]byte(want), []byte(given))
}

// Freshness is how far a hook call's time may be from the server's clock.
const Freshness = time.Minute

// Seen refuses a hook call that is stale or whose nonce was already used, so a captured call
// can't be sent again.
type Seen struct {
	mu     sync.Mutex
	nonces map[string]time.Time
}

// Fresh records the nonce and reports whether the call may go ahead.
func (s *Seen) Fresh(nonce, sent string, now time.Time) bool {
	seconds, err := strconv.ParseInt(sent, 10, 64)
	if err != nil {
		return false
	}
	at := time.Unix(seconds, 0)
	if at.Before(now.Add(-Freshness)) || at.After(now.Add(Freshness)) {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.nonces == nil {
		s.nonces = map[string]time.Time{}
	}
	for old, until := range s.nonces {
		if now.After(until) {
			delete(s.nonces, old)
		}
	}
	if _, used := s.nonces[nonce]; used {
		return false
	}
	s.nonces[nonce] = now.Add(2 * Freshness)
	return true
}
