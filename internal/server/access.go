// SPDX-License-Identifier: Apache-2.0

package server

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/SamsonIdowu/mabari/internal/connectors/claudecode"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/secrets"
)

// AccessKeyName is the secret holding the access key people sign in with.
const AccessKeyName = "access_key"

const (
	sessionCookie = "mabari_session"
	sessionLength = 30 * 24 * time.Hour
)

// Access is the sign in that guards Mabari whenever a request might not be the person at this
// computer: from another device on the network, through Docker's port publishing, under a name
// other than localhost, or always when Settings asks for it on a shared computer.
type Access struct {
	Secrets secrets.Store
	// SetLAN starts or stops listening on this computer's network addresses. Nil where Mabari
	// can't change it, as in Docker, where compose.yaml chooses the published address.
	SetLAN func(on bool) ([]string, error)

	lan          atomic.Bool
	requireLogin atomic.Bool
	mu           sync.Mutex
	addresses    []string
	now          func() time.Time
}

// apply takes the settings that decide who must sign in, and starts or stops LAN listening.
func (x *Access) apply(settings models.Settings) error {
	x.requireLogin.Store(settings.RequireLogin)
	if x.lan.Load() == settings.LANAccess {
		return nil
	}
	if x.SetLAN != nil {
		addresses, err := x.SetLAN(settings.LANAccess)
		if err != nil {
			return err
		}
		x.mu.Lock()
		x.addresses = addresses
		x.mu.Unlock()
	}
	x.lan.Store(settings.LANAccess)
	return nil
}

func (x *Access) clock() time.Time {
	if x.now != nil {
		return x.now()
	}
	return time.Now()
}

// Key returns the access key, making one the first time.
func (x *Access) Key() (string, error) {
	key, err := x.Secrets.Get(AccessKeyName)
	if err == nil && key != "" {
		return key, nil
	}
	return x.Rotate()
}

// Rotate makes a new access key. Everyone signed in with the old one is signed out.
func (x *Access) Rotate() (string, error) {
	raw := make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	key := "mab_" + hex.EncodeToString(raw)
	return key, x.Secrets.Set(AccessKeyName, key)
}

// session is "<expiry>.<signature>", signed with the access key, so a new key ends every session
// and nothing about sessions has to be stored.
func session(key string, expiry int64) string {
	mac := hmac.New(sha256.New, []byte(key))
	_, _ = mac.Write([]byte("mabari-session|" + strconv.FormatInt(expiry, 10)))
	return strconv.FormatInt(expiry, 10) + "." + hex.EncodeToString(mac.Sum(nil))
}

func (x *Access) signedIn(r *http.Request) bool {
	cookie, err := r.Cookie(sessionCookie)
	if err != nil {
		return false
	}
	expiryText, _, ok := strings.Cut(cookie.Value, ".")
	expiry, err := strconv.ParseInt(expiryText, 10, 64)
	if !ok || err != nil || x.clock().Unix() > expiry {
		return false
	}
	key, err := x.Secrets.Get(AccessKeyName)
	if err != nil || key == "" {
		return false
	}
	return hmac.Equal([]byte(cookie.Value), []byte(session(key, expiry)))
}

func loopbackRemote(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// needsLogin says whether this request has to come from someone signed in.
func (x *Access) needsLogin(r *http.Request) bool {
	return x.requireLogin.Load() || !loopbackRemote(r) || !isLocalHost(r.Host)
}

// open lists what anyone may reach: health for Docker, the sign in itself, and the hook and hub
// routes, which carry their own signatures and tokens.
func open(path string) bool {
	switch path {
	case "/api/health", "/api/session", "/api/login", "/api/logout":
		return true
	}
	return strings.HasPrefix(path, claudecode.HookPath) || strings.HasPrefix(path, "/hub/")
}

// guard runs before every route when Access is set.
func (x *Access) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if open(r.URL.Path) || !x.needsLogin(r) || x.signedIn(r) {
			next.ServeHTTP(w, r)
			return
		}
		// The web app itself isn't secret: it loads, asks /api/session and shows the sign in.
		if !strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/ws" {
			next.ServeHTTP(w, r)
			return
		}
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "sign in with the access key", "login": true})
	})
}

// accessRoutes are the sign in and the key's own controls in Settings.
func (a *api) accessRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/session", a.sessionStatus)
	mux.HandleFunc("POST /api/login", a.signIn)
	mux.HandleFunc("POST /api/logout", a.logout)
	mux.HandleFunc("GET /api/access", a.accessInfo)
	mux.HandleFunc("POST /api/access/rotate", a.rotateAccess)
}

type sessionInfo struct {
	// Needed is true when this browser has to sign in.
	Needed   bool `json:"needed"`
	SignedIn bool `json:"signedIn"`
}

func (a *api) sessionStatus(w http.ResponseWriter, r *http.Request) {
	signedIn := a.access.signedIn(r)
	writeJSON(w, http.StatusOK, sessionInfo{Needed: a.access.needsLogin(r) && !signedIn, SignedIn: signedIn})
}

// Failed sign ins are slowed down, so the key can't be guessed quickly.
var loginDelay = 500 * time.Millisecond

func (a *api) signIn(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Key string `json:"key"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	key, err := a.access.Key()
	if err != nil {
		internalError(w, err)
		return
	}
	if subtle.ConstantTimeCompare([]byte(strings.TrimSpace(body.Key)), []byte(key)) != 1 {
		time.Sleep(loginDelay)
		writeError(w, http.StatusUnauthorized, "That access key isn't right.")
		return
	}
	expiry := a.access.clock().Add(sessionLength).Unix()
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: session(key, expiry), Path: "/",
		Expires: time.Unix(expiry, 0), HttpOnly: true, SameSite: http.SameSiteStrictMode,
		Secure: r.TLS != nil,
	})
	writeJSON(w, http.StatusOK, sessionInfo{SignedIn: true})
}

func (a *api) logout(w http.ResponseWriter, _ *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode})
	writeJSON(w, http.StatusOK, sessionInfo{})
}

type accessInfo struct {
	Key string `json:"key"`
	// Addresses are where other devices reach Mabari while LAN access is on.
	Addresses []string `json:"addresses"`
	// LANControl is false in Docker, where compose.yaml chooses the published address.
	LANControl bool `json:"lanControl"`
}

// accessInfo shows the key, to the person at this computer or someone already signed in. It is
// never shown to a request that could be from another device without a sign in.
func (a *api) accessInfo(w http.ResponseWriter, r *http.Request) {
	key, err := a.access.Key()
	if err != nil {
		internalError(w, err)
		return
	}
	a.access.mu.Lock()
	addresses := append([]string{}, a.access.addresses...)
	a.access.mu.Unlock()
	writeJSON(w, http.StatusOK, accessInfo{Key: key, Addresses: addresses, LANControl: a.access.SetLAN != nil})
}

func (a *api) rotateAccess(w http.ResponseWriter, r *http.Request) {
	key, err := a.access.Rotate()
	if err != nil {
		internalError(w, err)
		return
	}
	// The person who asked stays signed in with the new key.
	expiry := a.access.clock().Add(sessionLength).Unix()
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: session(key, expiry), Path: "/",
		Expires: time.Unix(expiry, 0), HttpOnly: true, SameSite: http.SameSiteStrictMode,
		Secure: r.TLS != nil,
	})
	writeJSON(w, http.StatusOK, accessInfo{Key: key, LANControl: a.access.SetLAN != nil})
}
