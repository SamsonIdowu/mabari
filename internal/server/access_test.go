// SPDX-License-Identifier: Apache-2.0

package server

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/connectors/claudecode"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/secrets"
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

// call sends a request as if from remote, under host, with an optional cookie.
func (o *accessOffice) call(t *testing.T, method, path, body, remote, host string, cookie *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, "http://"+host+path, strings.NewReader(body))
	request.RemoteAddr = remote
	request.Host = host
	if cookie != nil {
		request.AddCookie(cookie)
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

func (o *accessOffice) signIn(t *testing.T, remote, host string) *http.Cookie {
	t.Helper()
	key, err := o.access.Key()
	if err != nil {
		t.Fatal(err)
	}
	response := o.call(t, http.MethodPost, "/api/login", `{"key":"`+key+`"}`, remote, host, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("sign in = %d %s", response.Code, response.Body)
	}
	cookies := response.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatalf("cookie = %+v", cookies)
	}
	return cookies[0]
}

func needsSignIn(response *httptest.ResponseRecorder) bool {
	return response.Code == http.StatusUnauthorized && strings.Contains(response.Body.String(), `"login":true`)
}

func TestThePersonAtThisComputerNeedsNoSignIn(t *testing.T) {
	o := newAccessOffice(t, false)
	if response := o.call(t, http.MethodGet, "/api/snapshot", "", here, local, nil); response.Code != http.StatusOK {
		t.Errorf("snapshot = %d", response.Code)
	}
	session := decode[sessionInfo](t, o.call(t, http.MethodGet, "/api/session", "", here, local, nil))
	if session.Needed {
		t.Error("asked to sign in at this computer")
	}
	// The key is shown here, for Settings.
	if info := decode[accessInfo](t, o.call(t, http.MethodGet, "/api/access", "", here, local, nil)); !strings.HasPrefix(info.Key, "mab_") || !info.LANControl {
		t.Errorf("access = %+v", info)
	}
}

// Through Docker's port publishing every request comes from the bridge, not loopback.
func TestThroughDockerEverythingNeedsTheKey(t *testing.T) {
	o := newAccessOffice(t, true)
	for _, path := range []string{"/api/snapshot", "/api/access", "/api/settings", "/ws"} {
		if response := o.call(t, http.MethodGet, path, "", docker, local, nil); !needsSignIn(response) {
			t.Errorf("%s = %d %s", path, response.Code, response.Body)
		}
	}
	// Health, the sign in, and the hook and hub routes (with their own signatures) stay open.
	for _, path := range []string{"/api/health", "/api/session"} {
		if response := o.call(t, http.MethodGet, path, "", docker, local, nil); response.Code != http.StatusOK {
			t.Errorf("%s = %d", path, response.Code)
		}
	}
	if response := o.call(t, http.MethodPost, claudecode.HookPath+"Stop", "{}", docker, local, nil); needsSignIn(response) {
		t.Error("the hook route asked for a sign in")
	}
	if session := decode[sessionInfo](t, o.call(t, http.MethodGet, "/api/session", "", docker, local, nil)); !session.Needed {
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
		if response := o.call(t, http.MethodPost, "/api/login", `{"key":"`+key+`"}`, phone, local, nil); response.Code != http.StatusUnauthorized ||
			len(response.Result().Cookies()) != 0 {
			t.Errorf("%q = %d", key, response.Code)
		}
	}
	forged := &http.Cookie{Name: sessionCookie, Value: session("not-the-key", time.Now().Add(time.Hour).Unix())}
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
	if response := o.call(t, http.MethodGet, "/api/snapshot", "", phone, local, rotated.Result().Cookies()[0]); response.Code != http.StatusOK {
		t.Errorf("rotator = %d", response.Code)
	}
}

// On a shared computer other people's programs can reach 127.0.0.1 too.
func TestASharedComputerAsksHereToo(t *testing.T) {
	o := newAccessOffice(t, false)
	if response := o.call(t, http.MethodPatch, "/api/settings", `{"requireLogin":true}`, here, local, nil); response.Code != http.StatusOK {
		t.Fatalf("settings = %d", response.Code)
	}
	if response := o.call(t, http.MethodGet, "/api/snapshot", "", here, local, nil); !needsSignIn(response) {
		t.Errorf("snapshot = %d", response.Code)
	}
	// It can't be turned off again without signing in.
	if response := o.call(t, http.MethodPatch, "/api/settings", `{"requireLogin":false}`, here, local, nil); !needsSignIn(response) {
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
	if response := o.call(t, http.MethodGet, "/api/health", "", phone, lanHost, nil); response.Code != http.StatusForbidden {
		t.Fatalf("off = %d", response.Code)
	}
	if response := o.call(t, http.MethodPatch, "/api/settings", `{"lanAccess":true}`, here, local, nil); response.Code != http.StatusOK {
		t.Fatalf("turn on = %d", response.Code)
	}
	if len(o.lanSets) != 1 || !o.lanSets[0] {
		t.Fatalf("SetLAN calls = %v", o.lanSets)
	}
	if info := decode[accessInfo](t, o.call(t, http.MethodGet, "/api/access", "", here, local, nil)); len(info.Addresses) != 1 {
		t.Errorf("addresses = %v", info.Addresses)
	}
	// On: the phone reaches it, but only signed in, and its own origin is accepted.
	if response := o.call(t, http.MethodGet, "/api/snapshot", "", phone, lanHost, nil); !needsSignIn(response) {
		t.Errorf("phone unsigned = %d", response.Code)
	}
	cookie := o.signIn(t, phone, lanHost)
	request := httptest.NewRequest(http.MethodPost, "http://"+lanHost+"/api/messages", strings.NewReader(`{}`))
	request.RemoteAddr, request.Host = phone, lanHost
	request.Header.Set("Origin", "http://"+lanHost)
	request.AddCookie(cookie)
	recorder := httptest.NewRecorder()
	o.handler.ServeHTTP(recorder, request)
	if recorder.Code == http.StatusForbidden || needsSignIn(recorder) {
		t.Errorf("phone signed in = %d %s", recorder.Code, recorder.Body)
	}
	// DNS rebinding: a website's own name pointed at 127.0.0.1 still has to sign in.
	if response := o.call(t, http.MethodGet, "/api/snapshot", "", here, "evil.example", nil); !needsSignIn(response) {
		t.Errorf("rebinding = %d", response.Code)
	}
	if response := o.call(t, http.MethodPatch, "/api/settings", `{"lanAccess":false}`, here, local, nil); response.Code != http.StatusOK {
		t.Fatal(response.Code)
	}
	if response := o.call(t, http.MethodGet, "/api/health", "", phone, lanHost, nil); response.Code != http.StatusForbidden {
		t.Errorf("after off = %d", response.Code)
	}
}

func TestLANAccessThatCantStartIsSavedOff(t *testing.T) {
	o := newAccessOffice(t, false)
	o.lanErr = errors.New("no network")
	response := o.call(t, http.MethodPatch, "/api/settings", `{"lanAccess":true}`, here, local, nil)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "no network") {
		t.Fatalf("on = %d %s", response.Code, response.Body)
	}
	if settings := decode[models.Settings](t, o.call(t, http.MethodGet, "/api/settings", "", here, local, nil)); settings.LANAccess {
		t.Error("saved as on")
	}
}

func TestWipeMakesANewKeyAndClosesLAN(t *testing.T) {
	o := newAccessOffice(t, false)
	before, _ := o.access.Key()
	o.call(t, http.MethodPatch, "/api/settings", `{"lanAccess":true,"requireLogin":true}`, here, local, nil)
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
