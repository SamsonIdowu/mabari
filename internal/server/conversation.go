// SPDX-License-Identifier: Apache-2.0

package server

import (
	"net/http"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// agentConversation is GET /api/agents/{id}/conversation: one page of what the agent and the
// person have said and done, oldest first. Live changes arrive on the WebSocket as "conversation"
// and "conversation.delta" messages. An agent that left keeps its conversation until retention
// removes it, so only an id nothing was ever said to is missing.
func (a *api) agentConversation(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	limit := min(int(positiveQuery(r, "limit", models.ConversationPage)), models.ConversationPageMax)
	items, more, err := a.engine.Store().Conversation(r.Context(), id, positiveQuery(r, "before", 0), limit)
	if err != nil {
		internalError(w, err)
		return
	}
	known := len(items) > 0
	if err := a.engine.Do(func() { known = known || a.engine.Agent(id) != nil }); err != nil {
		internalError(w, err)
		return
	}
	if !known {
		writeError(w, http.StatusNotFound, "no such agent")
		return
	}
	writeJSON(w, http.StatusOK, models.Conversation{AgentID: id, Items: items, HasMore: more})
}
