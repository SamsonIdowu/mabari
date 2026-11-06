// SPDX-License-Identifier: Apache-2.0

package server

import "net/http"

// agentCard is the small card shown over an agent's name tag: its role and what it did today. The
// numbers are the engine's, so the page only formats them.
func (a *api) agentCard(w http.ResponseWriter, r *http.Request) {
	card, ok := a.engine.Card(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "no such agent")
		return
	}
	writeJSON(w, http.StatusOK, card)
}
