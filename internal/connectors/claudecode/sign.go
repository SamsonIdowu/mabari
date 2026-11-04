// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
)

// Hook calls are signed both ways with the install's token, which never crosses the wire. A
// program that takes Mabari's port while Mabari is down learns nothing it can use, and can't
// forge a reply the hook would print, such as an "allow".
const (
	NonceHeader     = "X-Mabari-Nonce"
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

// SignRequest signs one hook call: its event, a fresh nonce and the body.
func SignRequest(token, nonce, event string, body []byte) string {
	return mac(token, []byte("request"), []byte(nonce), []byte(event), body)
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
