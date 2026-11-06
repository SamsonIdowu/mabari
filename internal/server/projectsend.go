// SPDX-License-Identifier: Apache-2.0

package server

import (
	"net/http"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/connectors/claudecode"
	"github.com/SamsonIdowu/mabari/internal/launch"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/vee"
)

// A message for a project goes to the agent there best placed to take it. A Claude Code session
// started elsewhere that is waiting for its person hears nothing until they type in it, so it
// doesn't count, but one Mabari runs does: it gets the message at once. When nobody can take it,
// and for slash commands, which Claude Code only runs when they are typed or given as a session's
// first prompt, Mabari starts a session in the project's folder with the message. Where it can't
// run sessions it opens Claude Code in a terminal instead.

// isCommand reports whether a message is a Claude Code slash command, such as /ux-audit. A path
// such as /Users/me/shop is not.
func isCommand(text string) bool {
	_, _, ok := launch.SlashCommand(text)
	return ok
}

// projectRoute is where a message for a project went, worked out inside Do. When Opening is set,
// Claude Code still has to be opened, outside Do.
type projectRoute struct {
	sent   vee.ProjectSent
	result messageResult
	// badPrompt is set when the text can't go on Claude Code's command line.
	badPrompt bool
	// trust is set when the project's folder needs the person's word before a session runs there.
	trust *folderTrust
}

// takers are the leads in a project that can take a message now, and the sessions waiting for
// their person, which hear it only when they next run.
func (a *api) takers(projectID string) (now, later []*models.LiveAgent) {
	for _, agent := range a.inScope(scope{Project: projectID}) {
		if agent.Lead != nil || agent.Leaving || agent.State == models.StateError || agent.State == models.StatePaused {
			continue
		}
		if agent.Source == claudecode.Source && !agent.State.Active() && !agent.RunsHere() {
			later = append(later, agent)
			continue
		}
		now = append(now, agent)
	}
	return now, later
}

// toProject sends a message to a project. Call inside Do.
func (a *api) toProject(project *models.Project, text, why string) projectRoute {
	route := projectRoute{sent: vee.ProjectSent{Project: project, Why: why}, result: messageResult{Agents: []string{}}}
	hasFolder := project.Repository != nil && project.Repository.Path != ""
	now, later := a.takers(project.ID)
	var agent *models.LiveAgent
	switch {
	case isCommand(text) && hasFolder && !hasIdleRun(now):
		// Commands start a session, below, where Claude Code runs them as typed.
	case len(now) > 0:
		if decision := a.router.Route(text, now); decision != nil {
			agent = a.engine.Agent(decision.AgentID)
		}
	case !hasFolder && len(later) > 0:
		agent = later[0]
	}
	if agent != nil {
		known := a.instructionIDs()
		route.result, _ = a.deliver(messageBody{
			scope: scope{Project: project.ID}, Text: text, Mode: string(models.ModeInstruct), Target: agent.ID, quiet: true,
		})
		// A copy, read after Do without the lock.
		copied := *agent
		route.sent.Agent, route.sent.Where = &copied, a.whereIs(agent, known)
		return route
	}
	if !hasFolder {
		route.sent.Problem = "Nobody works on " + project.Name + " yet, and it has no folder for Claude Code to open in. " +
			"Attach one on the Projects page."
		return route
	}
	if a.runsClaude() {
		a.startForProject(project, text, &route)
		return route
	}
	// Only here does the text become part of a command line.
	if problem := promptProblem(text); problem != "" {
		route.sent.Problem, route.badPrompt = problem, true
		return route
	}
	opening := a.engine.Opening(project, text)
	route.sent.Opening = &opening
	return route
}

// open opens Claude Code for a route that needs it. Call outside Do: it waits for the terminal.
// When no session is on its way, the prompt is taken back, so a session the person starts by
// hand isn't taken to have been given it.
func (a *api) open(route *projectRoute) string {
	if route.sent.Opening == nil {
		return ""
	}
	project := route.sent.Project
	notice, opened := a.openClaude(project.Name, project.Repository.Path, route.sent.Opening.Text, false)
	route.sent.Opened = opened
	if !opened {
		_ = a.engine.Do(func() { a.engine.DropOpening(route.sent.Opening.ID, "Claude Code didn't open") })
	}
	return notice
}

// noticeFor says in a toast where a project message went.
func noticeFor(route projectRoute, opened string) string {
	sent := route.sent
	switch {
	case sent.Opening != nil:
		return opened
	case sent.Agent == nil || sent.Where.InstructionID == "":
		return "Nobody in " + sent.Project.Name + " could take that just now."
	case sent.Where.Queued:
		return "Queued for " + sent.Agent.Name + " in " + sent.Project.Name + ". It gets it at its next checkpoint."
	}
	return "Sent to " + sent.Agent.Name + " in " + sent.Project.Name + "."
}

// projectSendResult is the reply to POST /api/projects/{id}/send.
type projectSendResult struct {
	Notice string `json:"notice"`
	// AgentID took the message, or is empty when Claude Code is opening with it.
	AgentID       string `json:"agentId"`
	InstructionID string `json:"instructionId"`
	// Opened is true when a Claude Code window is opening with the message.
	Opened bool `json:"opened"`
}

// sendToProject passes a message to a project, from the project's chat.
func (a *api) sendToProject(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Text string `json:"text"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	text := strings.TrimSpace(body.Text)
	if problem := messageProblem(text); problem != "" {
		writeError(w, http.StatusBadRequest, problem)
		return
	}
	a.sendProject(w, r.PathValue("id"), text)
}

// sendProject routes a message to a project and writes what happened. The Chats screen and the
// project's chat both come here.
func (a *api) sendProject(w http.ResponseWriter, id, text string) {
	var route projectRoute
	var found bool
	if err := a.engine.Do(func() {
		project := a.engine.Project(id)
		if project == nil {
			return
		}
		found = true
		copied := *project
		route = a.toProject(&copied, text, "")
	}); err != nil {
		internalError(w, err)
		return
	}
	switch {
	case !found:
		writeError(w, http.StatusNotFound, "no such project")
		return
	case route.badPrompt:
		writeError(w, http.StatusBadRequest, route.sent.Problem)
		return
	case route.trust != nil:
		writeTrustNeeded(w, route.trust)
		return
	case route.sent.Problem != "":
		writeError(w, http.StatusConflict, route.sent.Problem)
		return
	}
	opened := a.open(&route)
	result := projectSendResult{Notice: noticeFor(route, opened), Opened: route.sent.Opened}
	switch {
	case route.sent.Opening != nil && route.sent.Opened:
		result.InstructionID = route.sent.Opening.ID
	case route.sent.Agent != nil:
		result.AgentID, result.InstructionID = route.sent.Agent.ID, route.sent.Where.InstructionID
	}
	writeJSON(w, http.StatusOK, result)
}

// removeInstruction takes back an instruction before it is delivered.
func (a *api) removeInstruction(w http.ResponseWriter, r *http.Request) {
	var holder string
	var removed bool
	if err := a.engine.Do(func() {
		if holder, removed = a.engine.Unqueue(r.PathValue("id")); removed {
			a.engine.Toast("Removed from " + holder + "'s queue. It won't be delivered.")
		}
	}); err != nil {
		internalError(w, err)
		return
	}
	if !removed {
		writeError(w, http.StatusConflict, "That was already delivered, so it can't be taken back.")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
