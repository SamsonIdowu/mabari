// SPDX-License-Identifier: Apache-2.0

package server

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/connectors/hub"
)

func (a *api) hubRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /hub/v1/events", a.hubAuth(a.hubEvent))
	mux.HandleFunc("GET /hub/v1/agents/{agent}/instructions", a.hubAuth(a.hubInstructions))
}

// hubAuth lets in only callers with the hub token, compared in constant time.
func (a *api) hubAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		want, err := a.secrets.Get(secretHubToken)
		given, found := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if err != nil || want == "" || !found || subtle.ConstantTimeCompare([]byte(given), []byte(want)) != 1 {
			writeError(w, http.StatusUnauthorized, "this hub token is not valid")
			return
		}
		next(w, r)
	}
}

func (a *api) hubEvent(w http.ResponseWriter, r *http.Request) {
	var event hub.Event
	if !readJSON(w, r, &event) {
		return
	}
	if err := hub.Check(event); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	seated := true
	if err := a.engine.Do(func() { seated = a.hub.Report(event) }); err != nil {
		internalError(w, err)
		return
	}
	if !seated {
		writeError(w, http.StatusConflict, "every desk is taken")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *api) hubInstructions(w http.ResponseWriter, r *http.Request) {
	var texts []string
	if err := a.engine.Do(func() { texts = a.hub.Instructions(r.PathValue("agent")) }); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string][]string{"instructions": texts})
}
