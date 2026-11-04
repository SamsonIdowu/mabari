// SPDX-License-Identifier: Apache-2.0

package server

import (
	"net/http"
)

func (a *api) codexRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/accounts/codex/login", a.codexLogin)
	mux.HandleFunc("POST /api/accounts/codex/logout", a.codexLogout)
}

// codexLogin starts Codex's own ChatGPT sign in and returns the page to open. Mabari never sees
// the password or the tokens Codex keeps.
func (a *api) codexLogin(w http.ResponseWriter, _ *http.Request) {
	url, err := a.codex.Login()
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"authUrl": url})
}

func (a *api) codexLogout(w http.ResponseWriter, _ *http.Request) {
	if err := a.codex.Logout(); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
