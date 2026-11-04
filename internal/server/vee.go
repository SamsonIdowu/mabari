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
	// Message is what happened to a message Mabari passed on, or null.
	Message *messageResult `json:"message"`
}

// talkToVee answers the chat on Home. Questions about the office are answered from local state,
// and everything else goes to the dispatcher. Nothing here calls a model, so the answer comes
// back straight away, and nothing here can reach an approval: that always takes a click.
func (a *api) talkToVee(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Text string `json:"text"`
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
		result.Reply = vee.Answer(text, a.engine.Agents(), a.engine.Now())
		switch send := result.Reply.Send; {
		case result.Reply.Dispatch:
			result = a.dispatchForVee(text)
		case send != nil && send.Mode == models.ModeInstruct:
			agent := a.engine.Agent(send.AgentID)
			known := a.instructionIDs()
			delivered, _ := a.deliver(messageBody{Text: send.Text, Mode: string(send.Mode), Target: send.AgentID, quiet: true})
			result.Message = &delivered
			result.Reply = vee.Passed(agent, a.whereIs(agent, known), a.engine.Agents(), a.engine.Now())
		case send != nil:
			delivered, _ := a.deliver(messageBody{Text: send.Text, Mode: string(send.Mode), Target: send.AgentID})
			result.Message = &delivered
		}
	})
	if err != nil {
		internalError(w, err)
		return
	}
	if result.Message != nil && result.Message.Routed != nil {
		a.dispatched()
	}
	writeJSON(w, http.StatusOK, result)
}

// dispatchForVee hands a task to the agent the dispatcher picks, using its local scoring only.
func (a *api) dispatchForVee(text string) veeResult {
	known := a.instructionIDs()
	delivered, ok := a.deliver(messageBody{Text: text, Mode: string(models.ModeInstruct), Target: targetAuto, quiet: true})
	if !ok || delivered.Routed == nil {
		return veeResult{Reply: vee.Dispatched(nil, "", vee.Where{}, a.engine.Agents(), a.engine.Now())}
	}
	routed := delivered.Routed
	agent := a.engine.Agent(routed.AgentID)
	return veeResult{
		Reply:   vee.Dispatched(agent, routed.Reason, a.whereIs(agent, known), a.engine.Agents(), a.engine.Now()),
		Message: &delivered,
	}
}

// instructionIDs is every instruction the agents hold now, waiting or delivered.
func (a *api) instructionIDs() map[string]bool {
	known := map[string]bool{}
	for _, agent := range a.engine.Agents() {
		for _, instruction := range agent.Queued {
			known[instruction.ID] = true
		}
		for _, instruction := range agent.Asked {
			known[instruction.ID] = true
		}
	}
	return known
}

// whereIs finds the instruction that sending just made: on the agent, or on its lead when a
// Claude Code subagent's lead passes it on. A zero Where means the agent couldn't take it.
func (a *api) whereIs(agent *models.LiveAgent, known map[string]bool) vee.Where {
	if agent == nil {
		return vee.Where{}
	}
	holders := []*models.LiveAgent{agent}
	if agent.Lead != nil {
		if lead := a.engine.Agent(*agent.Lead); lead != nil {
			holders = append(holders, lead)
		}
	}
	for _, holder := range holders {
		for _, instruction := range holder.Queued {
			if !known[instruction.ID] {
				return vee.Where{Holder: holder, InstructionID: instruction.ID, Queued: true}
			}
		}
		for _, instruction := range holder.Asked {
			if !known[instruction.ID] {
				return vee.Where{Holder: holder, InstructionID: instruction.ID}
			}
		}
	}
	return vee.Where{}
}
