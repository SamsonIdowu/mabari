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
		// ProjectID is the project picked next to the chat box, "any", or empty for Mabari to choose.
		ProjectID string `json:"projectId"`
		// Since is when the person last looked at Mabari, for "what did I miss?". Zero is the last hour.
		Since int64 `json:"since"`
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
	var route *projectRoute
	err := a.engine.Do(func() {
		office := vee.Office{
			Agents: a.engine.Agents(), Projects: a.engine.Projects(), InView: body.ProjectID, Router: a.router,
			Since: body.Since,
			Recap: func(since, until int64) (models.Recap, error) { return a.recapOf(r.Context(), since, until) },
		}
		result.Reply = vee.AnswerIn(text, office, a.engine.Now())
		switch send := result.Reply.Send; {
		case result.Reply.Watch != nil:
			// "tell me when Ledger is done" sets a watch. It is no instruction for any agent.
			result.Reply = a.watchForVee(*result.Reply.Watch)
		case result.Reply.Route != nil:
			route = a.routeForVee(*result.Reply.Route)
			if route == nil {
				result.Reply = vee.Say("That project isn't open any more.", a.engine.Agents(), a.engine.Now())
				return
			}
			result.Message = &route.result
			result.Reply = vee.SentToProject(route.sent, a.engine.Agents(), a.engine.Now())
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
	if route != nil && route.sent.Opening != nil {
		a.openForVee(route, &result)
	}
	if result.Message != nil && result.Message.Routed != nil || route != nil && route.sent.Problem == "" {
		a.dispatched()
	}
	writeJSON(w, http.StatusOK, result)
}

// routeForVee sends a message to the project Mabari settled on. Call inside Do.
func (a *api) routeForVee(to vee.Route) *projectRoute {
	project := a.engine.Project(to.ProjectID)
	if project == nil || project.Done != nil {
		return nil
	}
	if problem := messageProblem(to.Text); problem != "" {
		return &projectRoute{sent: vee.ProjectSent{Project: project, Problem: problem}, result: messageResult{Agents: []string{}}}
	}
	copied := *project
	route := a.toProject(&copied, to.Text, to.Why, nil)
	return &route
}

// openForVee opens Claude Code for Mabari's reply. Mabari answers straight away, so the terminal
// opens in the background and a toast reports a failure. Without a launcher nothing can open, so
// the prompt is taken back and the reply says what to run.
func (a *api) openForVee(route *projectRoute, result *veeResult) {
	if a.launcher == nil {
		_ = a.open(route)
		_ = a.engine.Do(func() { result.Reply = vee.SentToProject(route.sent, a.engine.Agents(), a.engine.Now()) })
		return
	}
	route.sent.Opened = true
	_ = a.engine.Do(func() { result.Reply = vee.SentToProject(route.sent, a.engine.Agents(), a.engine.Now()) })
	background := *route
	go func() {
		if notice := a.open(&background); !background.sent.Opened {
			_ = a.engine.Do(func() { a.engine.Toast(notice) })
		}
	}()
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
