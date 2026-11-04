// SPDX-License-Identifier: Apache-2.0

package server

import (
	"net/http"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/vee"
)

type veeResult struct {
	Reply vee.Reply `json:"reply"`
	// Message is what happened to a message Vee passed on, or null.
	Message *messageResult `json:"message"`
}

// talkToVee answers the chat on Home. It can pass messages on through deliver, and nothing here
// can reach an approval: that always takes a click on the card.
func (a *api) talkToVee(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Text string `json:"text"`
		// Dispatch sends the text to the team, for the Send to the team button.
		Dispatch bool `json:"dispatch"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	text := strings.TrimSpace(body.Text)
	if text == "" {
		writeError(w, http.StatusBadRequest, "a message needs some text")
		return
	}
	var result veeResult
	err := a.engine.Do(func() {
		if body.Dispatch {
			result = a.dispatchForVee(text)
			return
		}
		result.Reply = vee.Answer(text, a.engine.Agents(), a.engine.Now())
		if send := result.Reply.Send; send != nil {
			delivered, _ := a.deliver(messageBody{Text: send.Text, Mode: string(send.Mode), Target: send.AgentID})
			result.Message = &delivered
		}
	})
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *api) dispatchForVee(text string) veeResult {
	delivered, ok := a.deliver(messageBody{Text: text, Mode: string(models.ModeInstruct), Target: targetAuto})
	if !ok || delivered.Routed == nil {
		return veeResult{Reply: vee.Dispatched("", "", a.engine.Agents(), a.engine.Now())}
	}
	routed := delivered.Routed
	return veeResult{
		Reply:   vee.Dispatched(routed.Name, routed.Reason, a.engine.Agents(), a.engine.Now()),
		Message: &delivered,
	}
}
