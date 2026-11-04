// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/service"
)

type fakeLogin struct {
	on    bool
	calls []string
}

func (f *fakeLogin) Status(context.Context) service.Status {
	return service.Status{Supported: true, Installed: f.on}
}

func (f *fakeLogin) Enable(_ context.Context, startNow bool) error {
	f.on = true
	f.calls = append(f.calls, map[bool]string{true: "enable now", false: "enable later"}[startNow])
	return nil
}

func (f *fakeLogin) Disable(_ context.Context, stopNow bool) error {
	f.on = false
	f.calls = append(f.calls, map[bool]string{true: "disable now", false: "disable later"}[stopNow])
	return nil
}

func TestRunAtLoginNeverRestartsThisMabari(t *testing.T) {
	login := &fakeLogin{}
	o := newOffice(t)
	o.handler = New(Options{Engine: o.engine, Simulator: o.simulator, Login: login})
	if status := decode[service.Status](t, o.do(t, http.MethodGet, "/api/service", "")); !status.Supported || status.Installed {
		t.Fatalf("status = %+v", status)
	}
	if status := decode[service.Status](t, o.do(t, http.MethodPost, "/api/service", `{"on":true}`)); !status.Installed {
		t.Fatalf("on = %+v", status)
	}
	o.do(t, http.MethodPost, "/api/service", `{"on":false}`)
	if strings.Join(login.calls, ",") != "enable later,disable later" {
		t.Errorf("calls = %v", login.calls)
	}
}

func TestRunAtLoginSaysWhyItIsUnavailable(t *testing.T) {
	o := newOffice(t)
	o.handler = New(Options{Engine: o.engine, Simulator: o.simulator, LoginReason: "inside Docker"})
	if status := decode[service.Status](t, o.do(t, http.MethodGet, "/api/service", "")); status.Supported || status.Detail != "inside Docker" {
		t.Fatalf("status = %+v", status)
	}
	if response := o.do(t, http.MethodPost, "/api/service", `{"on":true}`); response.Code != http.StatusConflict {
		t.Errorf("post = %d", response.Code)
	}
}
