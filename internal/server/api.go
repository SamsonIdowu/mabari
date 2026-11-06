// SPDX-License-Identifier: Apache-2.0

package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/connectors/claudecode"
	"github.com/SamsonIdowu/mabari/internal/connectors/simulator"
	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/projectmap"
)

const (
	maxAgentName    = 24
	maxNewAgentName = 20
	maxProjectName  = 28
	eventPageLimit  = 200
)

var retentionChoices = []int{7, 30, 90, 365}

// folderPath accepts home-relative, absolute and Windows paths.
var folderPath = regexp.MustCompile(`^(~/|~$|/|[A-Za-z]:\\)`)

func (a *api) routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/snapshot", a.snapshot)
	mux.HandleFunc("GET /ws", a.websocket)
	mux.HandleFunc("POST /api/demo/load", a.loadDemo)
	mux.HandleFunc("POST /api/demo/stop", a.stopDemo)
	mux.HandleFunc("POST /api/wipe", a.fromPage(a.wipe))

	mux.HandleFunc("GET /api/projects", a.listProjects)
	mux.HandleFunc("POST /api/projects", a.createProject)
	mux.HandleFunc("PATCH /api/projects/{id}", a.updateProject)
	mux.HandleFunc("DELETE /api/projects/{id}", a.deleteProject)
	mux.HandleFunc("POST /api/projects/{id}/complete", a.completeProject)
	mux.HandleFunc("POST /api/projects/{id}/reopen", a.reopenProject)
	mux.HandleFunc("POST /api/projects/{id}/claude", a.openProjectClaude)
	mux.HandleFunc("POST /api/projects/{id}/send", a.sendToProject)
	mux.HandleFunc("POST /api/desks/start", a.startAtDesk)
	mux.HandleFunc("GET /api/map", a.projectMap)
	mux.HandleFunc("DELETE /api/instructions/{id}", a.removeInstruction)

	mux.HandleFunc("GET /api/agents", a.listAgents)
	mux.HandleFunc("POST /api/agents", a.createAgent)
	mux.HandleFunc("POST /api/agents/interrupt", a.interruptGroup)
	mux.HandleFunc("POST /api/agents/continue", a.continueGroup)
	mux.HandleFunc("GET /api/agents/{id}", a.getAgent)
	mux.HandleFunc("PATCH /api/agents/{id}", a.updateAgent)
	mux.HandleFunc("GET /api/agents/{id}/events", a.agentEvents)
	mux.HandleFunc("GET /api/agents/{id}/conversation", a.agentConversation)
	mux.HandleFunc("GET /api/agents/{id}/card", a.agentCard)
	mux.HandleFunc("POST /api/agents/{id}/interrupt", a.agentAction(interruptAgent))
	mux.HandleFunc("POST /api/agents/{id}/continue", a.agentAction(a.continueAgent))
	mux.HandleFunc("POST /api/agents/{id}/stop", a.agentAction(stopAgent))
	mux.HandleFunc("POST /api/agents/{id}/retry", a.agentAction(retryAgent))
	mux.HandleFunc("POST /api/agents/{id}/subagents", a.addSubagent)
	mux.HandleFunc("POST /api/agents/{id}/answer", a.answerQuestion)

	mux.HandleFunc("GET /api/accounts", a.listAccounts)

	mux.HandleFunc("GET /api/settings", a.getSettings)
	mux.HandleFunc("PATCH /api/settings", a.updateSettings)

	mux.HandleFunc("GET /api/approvals", a.listApprovals)
	mux.HandleFunc("POST /api/approvals/{id}/decision", a.fromPage(a.decide))

	mux.HandleFunc("GET /api/activity", a.activity)
	mux.HandleFunc("GET /api/activity/export", a.exportActivity)
	mux.HandleFunc("GET /api/recap", a.recapRoute)
	mux.HandleFunc("GET /api/timeline", a.timelineRoute)

	mux.HandleFunc("POST /api/dispatch/preview", a.previewDispatch)
	mux.HandleFunc("POST /api/messages", a.sendMessage)
	mux.HandleFunc("POST /api/auto-approve", a.fromPage(a.autoApprove))
	mux.HandleFunc("POST /api/vee", a.talkToVee)
}

func (a *api) snapshot(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, a.engine.Snapshot())
}

func (a *api) loadDemo(w http.ResponseWriter, _ *http.Request) {
	if err := a.simulator.LoadDemo(); err != nil {
		internalError(w, err)
		return
	}
	// endsAt is when the demo turns itself off, so what the page tells people is the timer's own
	// word (NEW-1). Loading the demo again starts the time afresh.
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "endsAt": a.engine.Snapshot().DemoEndsAt})
}

// stopDemo clears the demo office, so only agents from real connections appear.
func (a *api) stopDemo(w http.ResponseWriter, _ *http.Request) {
	if err := a.engine.Do(a.simulator.StopDemo); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *api) wipe(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Confirm bool `json:"confirm"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if !body.Confirm {
		writeError(w, http.StatusBadRequest, "wiping needs confirm: true")
		return
	}
	// A wipe also takes Mabari's hooks, and its default agent line, out of Claude Code's settings.
	if a.claude != nil {
		if err := a.wipeClaudeSettings(); err != nil {
			internalError(w, err)
			return
		}
	}
	// Keys and tokens live in the secret store, not the database, so they go separately.
	if a.secrets != nil {
		for _, name := range []string{
			string(models.AccountAnthropicKey), string(models.AccountOpenAIKey), secretHubToken,
			claudecode.TokenName, AccessKeyName,
		} {
			if err := a.secrets.Delete(name); err != nil {
				internalError(w, err)
				return
			}
		}
	}
	// Attached files go with the conversations they were part of, and the saved instructions are
	// the person's words too, so they go as well. Neither is in the database.
	if err := errors.Join(a.wipeAttachments(), a.wipeSaved()); err != nil {
		internalError(w, err)
		return
	}
	if err := a.engine.Do(func() {
		a.engine.Wipe()
		// The wipe cleared the demo's office too, so the simulator lets go of it.
		a.simulator.Forget()
	}); err != nil {
		internalError(w, err)
		return
	}
	if a.access != nil {
		var settings models.Settings
		_ = a.engine.Do(func() { settings = a.engine.Settings() })
		if err := a.access.apply(settings); err != nil {
			slog.Warn("could not stop LAN access after a wipe", "error", err)
		}
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *api) listProjects(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, a.engine.Snapshot().Projects)
}

type projectBody struct {
	Name         *string `json:"name"`
	Color        *string `json:"color"`
	Instructions *string `json:"instructions"`
	// Folder attaches a folder on this computer to the project.
	Folder *string `json:"folder"`
}

// projectColor is the only form a project's colour may take: it is put into the page's styles.
var projectColor = regexp.MustCompile(`^#[0-9A-Fa-f]{3,8}$`)

func validProjectName(name string) bool {
	trimmed := strings.TrimSpace(name)
	return trimmed != "" && len([]rune(trimmed)) <= maxProjectName
}

func (a *api) createProject(w http.ResponseWriter, r *http.Request) {
	var body projectBody
	if !readJSON(w, r, &body) {
		return
	}
	if body.Name == nil || !validProjectName(*body.Name) || body.Color == nil || !projectColor.MatchString(*body.Color) {
		writeError(w, http.StatusBadRequest, "a project needs a name of up to 28 characters and a colour such as #48DBFB")
		return
	}
	project := models.Project{Name: strings.TrimSpace(*body.Name), Color: *body.Color}
	if body.Instructions != nil {
		project.Instructions = *body.Instructions
	}
	var saved models.Project
	if err := a.engine.Do(func() { saved = a.engine.SaveProject(project) }); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, saved)
}

func (a *api) updateProject(w http.ResponseWriter, r *http.Request) {
	var body projectBody
	if !readJSON(w, r, &body) {
		return
	}
	if body.Name != nil && !validProjectName(*body.Name) {
		writeError(w, http.StatusBadRequest, "a project name can be up to 28 characters")
		return
	}
	if body.Color != nil && !projectColor.MatchString(*body.Color) {
		writeError(w, http.StatusBadRequest, "a project's colour is a hex colour such as #48DBFB")
		return
	}
	var saved *models.Project
	var problem string
	err := a.engine.Do(func() {
		existing := a.engine.Project(r.PathValue("id"))
		if existing == nil {
			return
		}
		project := *existing
		if body.Folder != nil {
			if problem = a.attachFolder(&project, *body.Folder); problem != "" {
				return
			}
		}
		if body.Name != nil {
			project.Name = strings.TrimSpace(*body.Name)
		}
		if body.Color != nil {
			project.Color = *body.Color
		}
		if body.Instructions != nil {
			project.Instructions = *body.Instructions
		}
		result := a.engine.SaveProject(project)
		saved = &result
	})
	if problem != "" {
		writeError(w, http.StatusBadRequest, problem)
		return
	}
	respond(w, saved, err, "no such project")
}

func (a *api) deleteProject(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	found := false
	err := a.engine.Do(func() {
		if a.engine.Project(id) != nil {
			found = true
			a.engine.RemoveProject(id)
		}
	})
	switch {
	case err != nil:
		internalError(w, err)
	case !found:
		writeError(w, http.StatusNotFound, "no such project")
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

func (a *api) completeProject(w http.ResponseWriter, r *http.Request) {
	var saved *models.Project
	var notReady bool
	err := a.engine.Do(func() {
		existing := a.engine.Project(r.PathValue("id"))
		if existing == nil {
			return
		}
		if existing.Status != models.ProjectReady && existing.Status != models.ProjectIdle {
			notReady = true
			return
		}
		result := a.engine.CompleteProject(*existing)
		saved = &result
	})
	if notReady {
		writeError(w, http.StatusConflict, "this project still has work in progress")
		return
	}
	respond(w, saved, err, "no such project")
}

func (a *api) reopenProject(w http.ResponseWriter, r *http.Request) {
	var saved *models.Project
	err := a.engine.Do(func() {
		if existing := a.engine.Project(r.PathValue("id")); existing != nil {
			result := a.engine.ReopenProject(*existing)
			saved = &result
		}
	})
	respond(w, saved, err, "no such project")
}

func respond[T any](w http.ResponseWriter, value *T, err error, missing string) {
	switch {
	case err != nil:
		internalError(w, err)
	case value == nil:
		writeError(w, http.StatusNotFound, missing)
	default:
		writeJSON(w, http.StatusOK, value)
	}
}

func (a *api) listAgents(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, a.engine.Snapshot().Agents)
}

func (a *api) getAgent(w http.ResponseWriter, r *http.Request) {
	for _, agent := range a.engine.Snapshot().Agents {
		if agent.ID == r.PathValue("id") {
			writeJSON(w, http.StatusOK, agent)
			return
		}
	}
	writeError(w, http.StatusNotFound, "no such agent")
}

type agentBody struct {
	Model        *string   `json:"model"`
	SubModel     *string   `json:"subModel"`
	Project      *string   `json:"projectId"`
	Folder       *string   `json:"folder"`
	DailyCostCap *float64  `json:"dailyCostCap"`
	AllowedTools *[]string `json:"allowedTools"`
}

func validFolder(path string) bool {
	return folderPath.MatchString(path)
}

func (a *api) updateAgent(w http.ResponseWriter, r *http.Request) {
	var body agentBody
	if !readJSON(w, r, &body) {
		return
	}
	if body.DailyCostCap != nil && *body.DailyCostCap < 0 {
		writeError(w, http.StatusBadRequest, "a cost cap can't be negative")
		return
	}
	if body.Folder != nil && !validFolder(*body.Folder) {
		writeError(w, http.StatusBadRequest, "that doesn't look like a folder path")
		return
	}
	var saved *models.Agent
	var badProject bool
	var badModel error
	err := a.engine.Do(func() {
		agent := a.engine.Agent(r.PathValue("id"))
		if agent == nil {
			return
		}
		if body.Project != nil && a.engine.Project(*body.Project) == nil {
			badProject = true
			return
		}
		// A session Mabari runs passes its model on the command line at its next start.
		if body.Model != nil && agent.RunsHere() && agent.Source == claudecode.Source {
			if badModel = claudecode.CheckModel(agent, *body.Model); badModel != nil {
				return
			}
		}
		a.applyAgentBody(agent, body)
		a.engine.Touch(agent)
		copied := agent.Agent
		saved = &copied
	})
	if badProject {
		writeError(w, http.StatusBadRequest, "no such project")
		return
	}
	if badModel != nil {
		writeError(w, http.StatusBadRequest, badModel.Error())
		return
	}
	respond(w, saved, err, "no such agent")
}

// laterWording is how a change reads for agents that apply it at a checkpoint.
func laterWording(agent *models.LiveAgent, later string) (outcome, chip string) {
	if agent.Provider == models.ProviderClaude {
		return later, "amber"
	}
	return "Applied", "ok"
}

func (a *api) applyAgentBody(agent *models.LiveAgent, body agentBody) {
	if body.Model != nil && *body.Model != agent.Model {
		agent.Model = *body.Model
		a.engine.AddEvent(agent, "instruction", "Model changed to "+agent.Model, nil)
		outcome, chip := laterWording(agent, "At next checkpoint")
		a.engine.Log(agent.Name, models.LogInstruction, "Switch model to "+agent.Model, outcome, chip)
	}
	if body.Folder != nil && *body.Folder != agent.Folder {
		agent.Folder = *body.Folder
		a.engine.AddEvent(agent, "instruction", "Working folder changed to "+agent.Folder, nil)
		outcome, chip := laterWording(agent, "From next session")
		a.engine.Log(agent.Name, models.LogInstruction, "Work in "+agent.Folder, outcome, chip)
	}
	if body.DailyCostCap != nil {
		agent.DailyCostCap = body.DailyCostCap
	}
	if body.AllowedTools != nil {
		agent.AllowedTools = *body.AllowedTools
	}
	if agent.Lead != nil {
		return // A subagent's project and helpers follow its lead.
	}
	if body.SubModel != nil {
		agent.SubModel = *body.SubModel
	}
	if body.Project != nil {
		agent.Project = body.Project
		for _, other := range a.engine.Agents() {
			if other.Lead != nil && *other.Lead == agent.ID {
				other.Project = body.Project
				a.engine.Touch(other)
			}
		}
	}
}

func interruptAgent(c events.Connector, agent *models.LiveAgent) { c.Interrupt(agent) }
func stopAgent(c events.Connector, agent *models.LiveAgent)      { c.StopAgent(agent) }

// continueAgent resumes an interrupted agent and says so in its steps, the log and a toast.
func (a *api) continueAgent(c events.Connector, agent *models.LiveAgent) {
	if agent.State != models.StatePaused {
		return
	}
	c.Continue(agent)
	// A session that can't get a place yet stays paused, and has said why.
	if agent.State == models.StatePaused {
		return
	}
	a.engine.AddEvent(agent, "start", "Continued by you from where it stopped", nil)
	a.engine.Log(agent.Name, models.LogInstruction, "Continue", "Continued by you", "ok")
	a.engine.Toast(agent.Name + " is back to work.")
}
func retryAgent(c events.Connector, agent *models.LiveAgent) { c.Retry(agent) }

// agentAction runs a connector action on the agent in the path.
func (a *api) agentAction(action func(events.Connector, *models.LiveAgent)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var found bool
		err := a.engine.Do(func() {
			agent := a.engine.Agent(r.PathValue("id"))
			if agent == nil {
				return
			}
			if connector := a.engine.ConnectorFor(agent); connector != nil {
				found = true
				action(connector, agent)
			}
		})
		switch {
		case err != nil:
			internalError(w, err)
		case !found:
			writeError(w, http.StatusNotFound, "no such agent")
		default:
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		}
	}
}

type subagentBody struct {
	Name  string `json:"name"`
	Task  string `json:"task"`
	Model string `json:"model"`
}

type newAgentBody struct {
	Name         string             `json:"name"`
	Account      models.AccountKind `json:"account"`
	Model        string             `json:"model"`
	Task         string             `json:"task"`
	ProjectID    string             `json:"projectId"`
	Folder       string             `json:"folder"`
	DailyCostCap float64            `json:"dailyCostCap"`
	AllowedTools []string           `json:"allowedTools"`
	Desk         *int               `json:"desk"`
	LeadID       string             `json:"leadId"`
	// Where is "terminal" to open a Claude Code session in a terminal, instead of running it here.
	Where string `json:"where"`
}

const defaultNewTask = "Get to know the project and wait for instructions"

// check returns the problem with a new agent in the prototype's words, or nothing.
func (body *newAgentBody) check() string {
	body.Name = strings.TrimSpace(body.Name)
	body.Folder = strings.TrimSpace(body.Folder)
	body.Task = strings.TrimSpace(body.Task)
	if body.Task == "" {
		body.Task = defaultNewTask
	}
	switch {
	case body.Name == "" || len([]rune(body.Name)) > maxNewAgentName:
		return "Give the agent a name."
	case body.Folder == "":
		return "Choose a working folder."
	case !validFolder(body.Folder):
		return "That working folder path doesn't look right."
	case body.DailyCostCap < 0:
		return "The daily cost cap must be zero or more."
	case body.Desk != nil && (*body.Desk < 0 || *body.Desk >= models.MaxDesks):
		return "That desk doesn't exist."
	}
	return ""
}

func (a *api) connected(kind models.AccountKind) bool {
	for _, account := range a.engine.Accounts() {
		if account.Kind == kind && account.Status == models.AccountConnected {
			return true
		}
	}
	return false
}

// realRunner says why an agent on this account can't be started from Mabari outside the demo,
// or "" when it can. The answer is also what the account's StartNote says, so the New agent
// dialog and the server's refusal never disagree. It takes no locks of the engine's, so it can run
// inside Do or while the office is described.
func (a *api) realRunner(kind models.AccountKind) string {
	switch kind {
	case models.AccountCodex:
		switch {
		case a.codex == nil:
			return "Codex isn't running here. Install the Codex CLI and restart Mabari."
		case a.codex.Missing():
			return "The Codex CLI isn't installed. Install it, then restart Mabari."
		}
		return ""
	case models.AccountClaudeCode:
		switch {
		case a.claude == nil || !a.claude.Connector.CanRun():
			return "Claude Code sessions start in your terminal: run claude in the agent's folder and it takes a desk."
		case !a.claude.Connector.Installed():
			return "Claude Code isn't installed on this computer. Install it, then start the agent here."
		}
		return ""
	case models.AccountAnthropicKey, models.AccountOpenAIKey:
		return "Agents that run on an API key aren't ready yet. Attach Claude Code or sign in with ChatGPT to run agents."
	default:
		return "Agents on this account report by themselves."
	}
}

// accountNotes says, for each account, whether Mabari can start an agent on it and, if not, what
// to do instead, and what its program is missing. The engine adds these when it describes an
// account, so every page, and the New agent dialog's choice of form or instruction, reads one
// answer.
func (a *api) accountNotes(account models.Account, demo bool) models.Account {
	if account.Kind == models.AccountCodex && a.codex != nil && a.codex.Missing() {
		account.Missing = "codex"
	}
	if account.Kind == models.AccountClaudeCode && a.claude != nil && a.claude.Connector.CanRun() && !a.claude.Connector.Installed() {
		account.Missing = "claude"
	}
	connected := account.Status == models.AccountConnected
	switch {
	// The demo's agents are simulated, so any connected account of a kind it plays can start one.
	case demo && connected && (account.Kind == models.AccountCodex || account.Kind == models.AccountClaudeCode):
		account.CanStart = true
	default:
		account.StartNote = a.realRunner(account.Kind)
		// Claude Code needs no sign in here: it uses the login it already has.
		if account.StartNote == "" && !connected && account.Kind != models.AccountClaudeCode {
			account.StartNote = "Sign in with ChatGPT first."
		}
		account.CanStart = account.StartNote == ""
	}
	return account
}

// startAgent starts an agent from a checked body, or says why it can't. Call inside Do.
func (a *api) startAgent(body newAgentBody) (*models.LiveAgent, string) {
	switch {
	case !a.canUse(body.Account):
		return nil, "Connect an account first."
	case a.engine.AgentByName(body.Name) != nil:
		return nil, "There is already an agent called " + body.Name + ". Pick another name."
	}
	spec := simulator.NewAgent{
		Name: body.Name, Account: body.Account, Model: body.Model, Task: body.Task,
		Project: body.ProjectID, Folder: body.Folder, DailyCostCap: body.DailyCostCap,
		AllowedTools: body.AllowedTools, Desk: body.Desk,
	}
	if body.LeadID != "" {
		if spec.Lead = a.engine.Agent(body.LeadID); spec.Lead == nil {
			return nil, "That lead has left the office."
		}
	}
	// Outside the demo only real connections make agents, never simulated ones.
	if !a.simulator.DemoActive() {
		if problem := a.realRunner(body.Account); problem != "" {
			return nil, problem
		}
		if body.Account == models.AccountClaudeCode {
			return a.startClaudeAgent(body, spec.Lead)
		}
	}
	created, failure := a.simulator.CreateAgent(spec)
	switch {
	case failure != nil:
		return nil, "That desk has just been taken. Pick another."
	case created == nil:
		return nil, "There's no room for another agent there."
	}
	// A signed-in Codex runs the agent as a real thread. The demo office stays simulated.
	if body.Account == models.AccountCodex && a.codex != nil && !a.simulator.DemoActive() {
		a.codex.StartAgent(created)
	}
	return created, ""
}

// startClaudeAgent starts an agent as a Claude Code session Mabari runs. Call inside Do.
func (a *api) startClaudeAgent(body newAgentBody, lead *models.LiveAgent) (*models.LiveAgent, string) {
	if lead != nil {
		return nil, "Claude Code starts its own subagents. Ask " + lead.Name + " for one."
	}
	agent, err := a.startClaude(claudecode.SessionSpec{
		Name: body.Name, Folder: body.Folder, Task: body.Task, Model: body.Model, Project: body.ProjectID,
		Desk: body.Desk, Tools: body.AllowedTools, DailyCostCap: body.DailyCostCap,
	})
	if err != nil {
		return nil, err.Error()
	}
	return agent, ""
}

// realClaudeAgent reports whether this new agent would be a real Claude Code session, as opposed to
// one in the demo.
func (a *api) realClaudeAgent(body newAgentBody) (running bool, err error) {
	err = a.engine.Do(func() {
		running = body.Account == models.AccountClaudeCode && !a.simulator.DemoActive() && a.runsClaude()
	})
	return running, err
}

func (a *api) createAgent(w http.ResponseWriter, r *http.Request) {
	var body newAgentBody
	if !readJSON(w, r, &body) {
		return
	}
	if problem := body.check(); problem != "" {
		writeError(w, http.StatusBadRequest, problem)
		return
	}
	running, err := a.realClaudeAgent(body)
	if err != nil {
		internalError(w, err)
		return
	}
	if running && body.Where == whereTerminal {
		notice, opened := a.openClaude(body.Name, body.Folder, body.Task, false)
		writeJSON(w, http.StatusOK, map[string]any{"notice": notice, "opened": opened})
		return
	}
	if running {
		if trust := a.needsTrust(body.Folder); trust != nil {
			writeTrustNeeded(w, trust)
			return
		}
	}
	var created models.LiveAgent
	var problem string
	// The agent is copied inside Do: a session's process starts reporting at once, and changes the
	// agent itself while the reply is being written.
	err = a.engine.Do(func() {
		var agent *models.LiveAgent
		if agent, problem = a.startAgent(body); agent != nil {
			created = *agent
		}
	})
	switch {
	case err != nil:
		internalError(w, err)
	case problem != "":
		writeError(w, http.StatusConflict, problem)
	default:
		writeJSON(w, http.StatusCreated, created)
	}
}

func (a *api) addSubagent(w http.ResponseWriter, r *http.Request) {
	var body subagentBody
	if !readJSON(w, r, &body) {
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" || len([]rune(name)) > maxAgentName {
		writeError(w, http.StatusBadRequest, "Give the subagent a name.")
		return
	}
	var helper *models.LiveAgent
	var problem string
	status := http.StatusConflict
	err := a.engine.Do(func() {
		lead := a.engine.Agent(r.PathValue("id"))
		if lead == nil {
			problem, status = "no such agent", http.StatusNotFound
			return
		}
		if a.engine.AgentByName(name) != nil {
			problem = "There is already an agent called " + name + "."
			return
		}
		connector := a.engine.ConnectorFor(lead)
		if connector == nil {
			problem, status = "no such agent", http.StatusNotFound
			return
		}
		task := strings.TrimSpace(body.Task)
		if task == "" {
			task = "Help " + lead.Name + " with " + strings.ToLower(lead.Task)
		}
		if helper = connector.AddSubagent(lead, name, task, body.Model); helper == nil {
			problem = lead.Name + "'s office is full. Three subagents at most."
		}
	})
	switch {
	case err != nil:
		internalError(w, err)
	case problem != "":
		writeError(w, status, problem)
	default:
		writeJSON(w, http.StatusCreated, helper.Agent)
	}
}

func positiveQuery(r *http.Request, key string, fallback int64) int64 {
	value, err := strconv.ParseInt(r.URL.Query().Get(key), 10, 64)
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func (a *api) agentEvents(w http.ResponseWriter, r *http.Request) {
	limit := min(positiveQuery(r, "limit", 100), eventPageLimit)
	before := positiveQuery(r, "before", 0)
	found, err := a.engine.Store().Events(r.Context(), r.PathValue("id"), int(limit), before)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, found)
}

func (a *api) listAccounts(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, a.engine.Snapshot().Accounts)
}

func (a *api) getSettings(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, a.engine.Snapshot().Settings)
}

func validSettings(s models.Settings) string {
	switch {
	case !slices.Contains(retentionChoices, s.RetentionDays):
		return "retentionDays must be 7, 30, 90 or 365"
	case s.VoiceEngine != "browser" && s.VoiceEngine != "whisper":
		return `voiceEngine must be "browser" or "whisper"`
	case s.AutoApprove.Scope != "safe" && s.AutoApprove.Scope != "all":
		return `autoApprove.scope must be "safe" or "all"`
	case s.MaxSessions < models.MinSessions || s.MaxSessions > models.MaxSessionsLimit:
		return "maxSessions must be from " + strconv.Itoa(models.MinSessions) + " to " + strconv.Itoa(models.MaxSessionsLimit)
	default:
		return ""
	}
}

func (a *api) updateSettings(w http.ResponseWriter, r *http.Request) {
	var patch json.RawMessage
	if !readJSON(w, r, &patch) {
		return
	}
	var (
		settings models.Settings
		problem  string
	)
	// Read, merge, check and save under one lock, so a change made by another request in between,
	// such as auto approve being turned off, is never overwritten.
	err := a.engine.Do(func() {
		current := a.engine.Settings()
		// Decoding onto a copy of the current settings is what makes this a partial update.
		settings = current.Clone()
		decoder := json.NewDecoder(bytes.NewReader(patch))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&settings) != nil {
			problem = "request body is not valid"
			return
		}
		// Auto approve has its own route, which records the change and asks for an acknowledgement.
		settings.AutoApprove = current.AutoApprove
		if problem = validSettings(settings); problem == "" {
			// A model no account offers is never kept, so the pages show what is used.
			var changes []string
			settings, changes = models.CorrectModels(settings, a.engine.StoredAccounts())
			a.engine.SaveSettings(settings)
			for _, change := range changes {
				a.engine.Log("Everyone", models.LogSession, "Corrected a model setting", change, "")
			}
			if len(changes) > 0 {
				a.engine.Toast(strings.Join(changes, " "))
			}
		}
	})
	if err != nil {
		internalError(w, err)
		return
	}
	if problem != "" {
		writeError(w, http.StatusBadRequest, problem)
		return
	}
	if a.access != nil {
		if err := a.access.apply(settings); err != nil {
			// LAN access couldn't start, so it is saved as off again.
			slog.Warn("LAN access failed", "error", err)
			_ = a.engine.Do(func() {
				settings = a.engine.Settings()
				settings.LANAccess = false
				a.engine.SaveSettings(settings)
			})
			writeError(w, http.StatusConflict, "Mabari couldn't listen on your network: "+err.Error())
			return
		}
	}
	writeJSON(w, http.StatusOK, settings)
}

func (a *api) listApprovals(w http.ResponseWriter, r *http.Request) {
	pending := r.URL.Query().Get("pending") == "1"
	approvals, err := a.engine.Store().Approvals(r.Context(), pending)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, approvals)
}

func (a *api) decide(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Decision string `json:"decision"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.Decision != models.DecisionAllowed && body.Decision != models.DecisionDenied {
		writeError(w, http.StatusBadRequest, `decision must be "allowed" or "denied"`)
		return
	}
	var applied bool
	err := a.engine.Do(func() { applied = a.engine.Decide(r.PathValue("id"), body.Decision) })
	if err != nil {
		internalError(w, err)
		return
	}
	// A repeated decision is a no-op, not an error: two tabs may click at once.
	writeJSON(w, http.StatusOK, map[string]bool{"applied": applied})
}

func (a *api) activity(w http.ResponseWriter, r *http.Request) {
	query := logQueryOf(r)
	query.Limit = int(positiveQuery(r, "limit", 500))
	entries, err := a.engine.Store().Log(r.Context(), query)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

// projectMap is Mabari's map of the projects: as JSON, or with ?format=md as the Markdown it keeps
// in map.md for any AI to read.
func (a *api) projectMap(w http.ResponseWriter, r *http.Request) {
	var m projectmap.Map
	if err := a.engine.Do(func() { m = projectmap.Of(a.engine) }); err != nil {
		internalError(w, err)
		return
	}
	if r.URL.Query().Get("format") == "md" {
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		_, _ = w.Write([]byte(m.Markdown()))
		return
	}
	writeJSON(w, http.StatusOK, m)
}
