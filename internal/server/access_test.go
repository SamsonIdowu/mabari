// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/connectors/claudecode"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/secrets"
	"github.com/coder/websocket"
)

type accessOffice struct {
	*office
	access  *Access
	lanErr  error
	lanSets []bool
}

func newAccessOffice(t *testing.T, anyHost bool) *accessOffice {
	t.Helper()
	loginDelay = 0
	o := &accessOffice{office: newOffice(t)}
	o.access = &Access{Secrets: secrets.NewMemory(), SetLAN: func(on bool) ([]string, error) {
		o.lanSets = append(o.lanSets, on)
		if o.lanErr != nil {
			return nil, o.lanErr
		}
		return []string{"http://192.168.1.5:4317"}, nil
	}}
	o.handler = New(Options{Engine: o.engine, Simulator: o.simulator, Secrets: o.access.Secrets, Access: o.access, AnyHost: anyHost})
	return o
}

// call sends a request as if from remote, under host, with an optional session token.
func (o *accessOffice) call(t *testing.T, method, path, body, remote, host, token string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, "http://"+host+path, strings.NewReader(body))
	request.RemoteAddr = remote
	request.Host = host
	// What Mabari's own page sends, which a few routes insist on.
	request.Header.Set("Origin", "http://"+host)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	o.handler.ServeHTTP(recorder, request)
	return recorder
}

const (
	here   = "127.0.0.1:50000"
	phone  = "192.168.1.9:50000"
	docker = "192.168.65.1:50000"
	local  = "localhost:4317"
)

func (o *accessOffice) signIn(t *testing.T, remote, host string) string {
	t.Helper()
	key, err := o.access.Key()
	if err != nil {
		t.Fatal(err)
	}
	response := o.call(t, http.MethodPost, "/api/login", `{"key":"`+key+`"}`, remote, host, "")
	if response.Code != http.StatusOK {
		t.Fatalf("sign in = %d %s", response.Code, response.Body)
	}
	// No cookie: browsers send cookies to every port on a host.
	if len(response.Result().Cookies()) != 0 {
		t.Fatal("a cookie was set")
	}
	return decode[sessionInfo](t, response).Token
}

func needsSignIn(response *httptest.ResponseRecorder) bool {
	return response.Code == http.StatusUnauthorized && strings.Contains(response.Body.String(), `"login":true`)
}

func TestThePersonAtThisComputerNeedsNoSignIn(t *testing.T) {
	o := newAccessOffice(t, false)
	if response := o.call(t, http.MethodGet, "/api/snapshot", "", here, local, ""); response.Code != http.StatusOK {
		t.Errorf("snapshot = %d", response.Code)
	}
	session := decode[sessionInfo](t, o.call(t, http.MethodGet, "/api/session", "", here, local, ""))
	if session.Needed {
		t.Error("asked to sign in at this computer")
	}
	// The key is shown here, for Settings.
	if info := decode[accessInfo](t, o.call(t, http.MethodGet, "/api/access", "", here, local, "")); !strings.HasPrefix(info.Key, "mab_") || !info.LANControl {
		t.Errorf("access = %+v", info)
	}
}

// Through Docker's port publishing every request comes from the bridge, not loopback.
func TestThroughDockerEverythingNeedsTheKey(t *testing.T) {
	o := newAccessOffice(t, true)
	for _, path := range []string{"/api/snapshot", "/api/access", "/api/settings", "/ws"} {
		if response := o.call(t, http.MethodGet, path, "", docker, local, ""); !needsSignIn(response) {
			t.Errorf("%s = %d %s", path, response.Code, response.Body)
		}
	}
	// Health, the sign in, and the hook and hub routes (with their own signatures) stay open.
	for _, path := range []string{"/api/health", "/api/session"} {
		if response := o.call(t, http.MethodGet, path, "", docker, local, ""); response.Code != http.StatusOK {
			t.Errorf("%s = %d", path, response.Code)
		}
	}
	if response := o.call(t, http.MethodPost, claudecode.HookPath+"Stop", "{}", docker, local, ""); needsSignIn(response) {
		t.Error("the hook route asked for a sign in")
	}
	if session := decode[sessionInfo](t, o.call(t, http.MethodGet, "/api/session", "", docker, local, "")); !session.Needed {
		t.Error("session says no sign in is needed")
	}
	cookie := o.signIn(t, docker, local)
	if response := o.call(t, http.MethodGet, "/api/snapshot", "", docker, local, cookie); response.Code != http.StatusOK {
		t.Errorf("signed in snapshot = %d", response.Code)
	}
}

func TestAWrongKeyIsRefused(t *testing.T) {
	o := newAccessOffice(t, true)
	for _, key := range []string{"", "mab_nope", "MAB_" + strings.Repeat("0", 40)} {
		if response := o.call(t, http.MethodPost, "/api/login", `{"key":"`+key+`"}`, phone, local, ""); response.Code != http.StatusUnauthorized ||
			decode[sessionInfo](t, response).Token != "" {
			t.Errorf("%q = %d", key, response.Code)
		}
	}
	forged := session("not-the-key", time.Now().Add(time.Hour).Unix())
	if response := o.call(t, http.MethodGet, "/api/snapshot", "", phone, local, forged); !needsSignIn(response) {
		t.Errorf("forged session = %d", response.Code)
	}
}

func TestSessionsExpireAndEndWithANewKey(t *testing.T) {
	o := newAccessOffice(t, true)
	cookie := o.signIn(t, phone, local)
	o.access.now = func() time.Time { return time.Now().Add(31 * 24 * time.Hour) }
	if response := o.call(t, http.MethodGet, "/api/snapshot", "", phone, local, cookie); !needsSignIn(response) {
		t.Errorf("expired = %d", response.Code)
	}
	o.access.now = nil
	if response := o.call(t, http.MethodGet, "/api/snapshot", "", phone, local, cookie); response.Code != http.StatusOK {
		t.Fatalf("fresh = %d", response.Code)
	}
	rotated := o.call(t, http.MethodPost, "/api/access/rotate", "", phone, local, cookie)
	if rotated.Code != http.StatusOK {
		t.Fatalf("rotate = %d", rotated.Code)
	}
	if response := o.call(t, http.MethodGet, "/api/snapshot", "", phone, local, cookie); !needsSignIn(response) {
		t.Errorf("old session after rotate = %d", response.Code)
	}
	// Whoever rotated it stays signed in.
	if response := o.call(t, http.MethodGet, "/api/snapshot", "", phone, local, decode[accessInfo](t, rotated).Token); response.Code != http.StatusOK {
		t.Errorf("rotator = %d", response.Code)
	}
}

// On a shared computer other people's programs can reach 127.0.0.1 too.
func TestASharedComputerAsksHereToo(t *testing.T) {
	o := newAccessOffice(t, false)
	if response := o.call(t, http.MethodPatch, "/api/settings", `{"requireLogin":true}`, here, local, ""); response.Code != http.StatusOK {
		t.Fatalf("settings = %d", response.Code)
	}
	if response := o.call(t, http.MethodGet, "/api/snapshot", "", here, local, ""); !needsSignIn(response) {
		t.Errorf("snapshot = %d", response.Code)
	}
	// It can't be turned off again without signing in.
	if response := o.call(t, http.MethodPatch, "/api/settings", `{"requireLogin":false}`, here, local, ""); !needsSignIn(response) {
		t.Errorf("turned off without a sign in: %d", response.Code)
	}
	cookie := o.signIn(t, here, local)
	if response := o.call(t, http.MethodGet, "/api/snapshot", "", here, local, cookie); response.Code != http.StatusOK {
		t.Errorf("signed in = %d", response.Code)
	}
}

func TestLANAccess(t *testing.T) {
	o := newAccessOffice(t, false)
	lanHost := "192.168.1.5:4317"
	// Off: other names are refused outright.
	if response := o.call(t, http.MethodGet, "/api/health", "", phone, lanHost, ""); response.Code != http.StatusForbidden {
		t.Fatalf("off = %d", response.Code)
	}
	if response := o.call(t, http.MethodPatch, "/api/settings", `{"lanAccess":true}`, here, local, ""); response.Code != http.StatusOK {
		t.Fatalf("turn on = %d", response.Code)
	}
	if len(o.lanSets) != 1 || !o.lanSets[0] {
		t.Fatalf("SetLAN calls = %v", o.lanSets)
	}
	if info := decode[accessInfo](t, o.call(t, http.MethodGet, "/api/access", "", here, local, "")); len(info.Addresses) != 1 {
		t.Errorf("addresses = %v", info.Addresses)
	}
	// On: the phone reaches it, but only signed in, and its own origin is accepted.
	if response := o.call(t, http.MethodGet, "/api/snapshot", "", phone, lanHost, ""); !needsSignIn(response) {
		t.Errorf("phone unsigned = %d", response.Code)
	}
	cookie := o.signIn(t, phone, lanHost)
	request := httptest.NewRequest(http.MethodPost, "http://"+lanHost+"/api/messages", strings.NewReader(`{}`))
	request.RemoteAddr, request.Host = phone, lanHost
	request.Header.Set("Origin", "http://"+lanHost)
	request.Header.Set("Authorization", "Bearer "+cookie)
	recorder := httptest.NewRecorder()
	o.handler.ServeHTTP(recorder, request)
	if recorder.Code == http.StatusForbidden || needsSignIn(recorder) {
		t.Errorf("phone signed in = %d %s", recorder.Code, recorder.Body)
	}
	// DNS rebinding: a website's own name pointed at 127.0.0.1 still has to sign in.
	if response := o.call(t, http.MethodGet, "/api/snapshot", "", here, "evil.example", ""); !needsSignIn(response) {
		t.Errorf("rebinding = %d", response.Code)
	}
	if response := o.call(t, http.MethodPatch, "/api/settings", `{"lanAccess":false}`, here, local, ""); response.Code != http.StatusOK {
		t.Fatal(response.Code)
	}
	if response := o.call(t, http.MethodGet, "/api/health", "", phone, lanHost, ""); response.Code != http.StatusForbidden {
		t.Errorf("after off = %d", response.Code)
	}
}

func TestLANAccessThatCantStartIsSavedOff(t *testing.T) {
	o := newAccessOffice(t, false)
	o.lanErr = errors.New("no network")
	response := o.call(t, http.MethodPatch, "/api/settings", `{"lanAccess":true}`, here, local, "")
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "no network") {
		t.Fatalf("on = %d %s", response.Code, response.Body)
	}
	if settings := decode[models.Settings](t, o.call(t, http.MethodGet, "/api/settings", "", here, local, "")); settings.LANAccess {
		t.Error("saved as on")
	}
}

func TestWipeMakesANewKeyAndClosesLAN(t *testing.T) {
	o := newAccessOffice(t, false)
	before, _ := o.access.Key()
	o.call(t, http.MethodPatch, "/api/settings", `{"lanAccess":true,"requireLogin":true}`, here, local, "")
	cookie := o.signIn(t, here, local)
	if response := o.call(t, http.MethodPost, "/api/wipe", `{"confirm":true}`, here, local, cookie); response.Code != http.StatusOK {
		t.Fatalf("wipe = %d %s", response.Code, response.Body)
	}
	if after, _ := o.access.Key(); after == before {
		t.Error("the key survived the wipe")
	}
	if o.access.lan.Load() {
		t.Error("LAN access survived the wipe")
	}
	if !o.access.requireLogin.Load() {
		t.Error("the shared computer setting was dropped by the wipe")
	}
}

// Paths that start like an open route but lead elsewhere are cleaned and redirected, then
// checked again, so they never reach a guarded route without the key.
func TestPathTricksDontSkipTheSignIn(t *testing.T) {
	o := newAccessOffice(t, true)
	for _, path := range []string{
		"/api/hooks/claude/../../api/snapshot", "/hub/../api/snapshot", "//api/snapshot",
		"/api/health/../snapshot", "/api/%2e%2e/api/snapshot",
	} {
		response := o.call(t, http.MethodGet, path, "", docker, local, "")
		if response.Code == http.StatusOK {
			t.Errorf("%s = 200 without the key", path)
		}
	}
	if response := o.call(t, http.MethodHead, "/api/snapshot", "", docker, local, ""); response.Code != http.StatusUnauthorized {
		t.Errorf("HEAD = %d", response.Code)
	}
}

type failingStore struct{ secrets.Store }

func (failingStore) Get(string) (string, error) { return "", errors.New("keychain locked") }

// A secret store that fails never leads to a new key, and signing in never makes one.
func TestAFailingStoreNeverReplacesTheKey(t *testing.T) {
	memory := secrets.NewMemory()
	x := &Access{Secrets: failingStore{memory}}
	if _, err := x.Key(); err == nil {
		t.Error("Key made a key over an error")
	}
	if _, err := memory.Get(AccessKeyName); err == nil {
		t.Error("a key was written")
	}
	o := newAccessOffice(t, true)
	if response := o.call(t, http.MethodPost, "/api/login", `{"key":"anything"}`, phone, local, ""); response.Code != http.StatusUnauthorized ||
		!strings.Contains(response.Body.String(), "no access key yet") {
		t.Errorf("sign in before any key = %d %s", response.Code, response.Body)
	}
	if _, err := o.access.Secrets.Get(AccessKeyName); err == nil {
		t.Error("signing in made a key")
	}
}

// An open WebSocket closes when its session no longer counts, as after a new key.
func TestAWebSocketClosesAfterANewKey(t *testing.T) {
	recheckEvery = 20 * time.Millisecond
	t.Cleanup(func() { recheckEvery = 2 * time.Second })
	o := newAccessOffice(t, true)
	server := httptest.NewServer(o.handler)
	defer server.Close()
	key, _ := o.access.Key()
	token := session(key, time.Now().Add(time.Hour).Unix())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// The test server is on 127.0.0.1, so ask for the shared computer setting to need the key.
	o.access.requireLogin.Store(true)
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws"
	if _, _, err := websocket.Dial(ctx, url, nil); err == nil { //nolint:bodyclose // The library closes it.
		t.Fatal("connected without the key")
	}
	options := &websocket.DialOptions{Subprotocols: []string{"mabari", sessionProtocol + token}}
	conn, response, err := websocket.Dial(ctx, url, options) //nolint:bodyclose // The library closes it.
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if got := response.Header.Get("Sec-WebSocket-Protocol"); got != "mabari" {
		t.Errorf("protocol = %q", got)
	}
	if _, err := o.access.Rotate(); err != nil {
		t.Fatal(err)
	}
	for {
		if _, _, err := conn.Read(ctx); err != nil {
			if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
				t.Errorf("closed with %v", err)
			}
			return
		}
	}
}

// A command an agent runs has no Origin. It must not be able to open Mabari to the network, drop
// the sign in, or read or replace the key, while everyday settings still save.
func TestOnlyThePageCanChangeWhoReachesMabari(t *testing.T) {
	o := newAccessOffice(t, false)
	plain := func(method, path, body string, headers map[string]string) int {
		request := httptest.NewRequest(method, "http://"+local+path, strings.NewReader(body))
		request.RemoteAddr = here
		request.Host = local
		for name, value := range headers {
			request.Header.Set(name, value)
		}
		recorder := httptest.NewRecorder()
		o.handler.ServeHTTP(recorder, request)
		return recorder.Code
	}
	for _, body := range []string{`{"lanAccess":true}`, `{"requireLogin":true}`} {
		if code := plain(http.MethodPatch, "/api/settings", body, nil); code != http.StatusForbidden {
			t.Errorf("%s with no Origin = %d", body, code)
		}
	}
	if code := plain(http.MethodPatch, "/api/settings", `{"lanAccess":true}`,
		map[string]string{"Origin": "http://evil.example"}); code != http.StatusForbidden {
		t.Errorf("another origin = %d", code)
	}
	if o.access.requireLogin.Load() {
		t.Error("a refused change took effect")
	}
	if code := plain(http.MethodGet, "/api/access", "", nil); code != http.StatusForbidden {
		t.Errorf("reading the key with no Origin = %d", code)
	}
	if code := plain(http.MethodPost, "/api/access/rotate", "", nil); code != http.StatusForbidden {
		t.Errorf("rotating the key with no Origin = %d", code)
	}
	// What the page sends: a same-origin read has no Origin, only this.
	if code := plain(http.MethodGet, "/api/access", "",
		map[string]string{"Sec-Fetch-Site": "same-origin"}); code != http.StatusOK {
		t.Errorf("the page reading the key = %d", code)
	}
	if code := plain(http.MethodPatch, "/api/settings", `{"retentionDays":30}`, nil); code != http.StatusOK {
		t.Errorf("an everyday setting = %d", code)
	}
}
