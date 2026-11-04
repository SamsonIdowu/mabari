// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"net/http"

	"github.com/SamsonIdowu/mabari/internal/service"
)

// LoginService is the local service, as Settings' Run at login switch uses it.
type LoginService interface {
	Status(ctx context.Context) service.Status
	Enable(ctx context.Context, startNow bool) error
	Disable(ctx context.Context, stopNow bool) error
}

func (a *api) loginRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/service", a.loginStatus)
	mux.HandleFunc("POST /api/service", a.setLogin)
}

func (a *api) loginStatus(w http.ResponseWriter, r *http.Request) {
	if a.login == nil {
		writeJSON(w, http.StatusOK, service.Status{Detail: a.loginReason})
		return
	}
	writeJSON(w, http.StatusOK, a.login.Status(r.Context()))
}

// setLogin turns Run at login on or off. It never starts a second Mabari or stops this one: the
// change takes effect at the next login.
func (a *api) setLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		On bool `json:"on"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if a.login == nil {
		writeError(w, http.StatusConflict, a.loginReason)
		return
	}
	var err error
	if body.On {
		err = a.login.Enable(r.Context(), false)
	} else {
		err = a.login.Disable(r.Context(), false)
	}
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, a.login.Status(r.Context()))
}
