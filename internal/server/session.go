// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/connectors/claudecode"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/workspace"
)

// metaTrusted lists the folders the person has said they trust, by full path.
const metaTrusted = "claude_trusted_folders"

// whereTerminal is the choice to run a Claude Code session in a terminal instead of in Mabari.
const whereTerminal = "terminal"

func (a *api) sessionRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/folders/trust", a.trustFolder)
	mux.HandleFunc("POST /api/agents/{id}/session/resume", a.resumeSession)
	mux.HandleFunc("POST /api/agents/{id}/session/release", a.releaseSession)
}

// runsClaude reports whether Mabari can run a Claude Code session itself on this computer.
func (a *api) runsClaude() bool {
	return a.claude != nil && a.claude.Connector.CanRun() && a.claude.Connector.Installed()
}

// canUse reports whether an agent can run on an account: one that is connected, or Claude Code on
// this computer, which needs no attaching because its hooks are passed to each session.
func (a *api) canUse(kind models.AccountKind) bool {
	return a.connected(kind) || (kind == models.AccountClaudeCode && a.runsClaude())
}

// folderTrust is a folder that brings code of its own, for the person to say they trust it.
type folderTrust struct {
	Folder string   `json:"folder"`
	Found  []string `json:"found"`
}

func (a *api) trustedFolders() []string {
	raw, err := a.engine.Store().Meta(context.Background(), metaTrusted)
	var folders []string
	if err != nil || json.Unmarshal([]byte(raw), &folders) != nil {
		return nil
	}
	return folders
}

// needsTrust says what a folder brings when a session there would run it without the person ever
// having agreed, or nil when there is nothing to agree to. A terminal asks before it runs any of
// this, and a session with no terminal never can, so Mabari asks instead. See FolderConfig.
func (a *api) needsTrust(folder string) *folderTrust {
	path, err := workspace.Expand(folder)
	if err != nil {
		return nil
	}
	found := claudecode.FolderConfig(path)
	if len(found) == 0 || slices.Contains(a.trustedFolders(), path) {
		return nil
	}
	return &folderTrust{Folder: path, Found: found}
}

// writeTrustNeeded refuses a start until the person has said they trust the folder. The page shows
// what the folder brings, and sends the request again if they do.
func writeTrustNeeded(w http.ResponseWriter, trust *folderTrust) {
	writeJSON(w, http.StatusConflict, map[string]any{
		"error": trust.Folder + " has its own Claude Code settings, which can run code. Say you trust it first.",
		"trust": trust,
	})
}

// trustFolder is POST /api/folders/trust, the person's click to trust a folder. Nothing but this
// route adds to the list, and Mabari's own replies never reach it.
func (a *api) trustFolder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path    string `json:"path"`
		Confirm bool   `json:"confirm"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if !body.Confirm {
		writeError(w, http.StatusBadRequest, "Trusting a folder needs a click.")
		return
	}
	path, err := workspace.Expand(body.Path)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := a.engine.Do(func() {
		folders := a.trustedFolders()
		if !slices.Contains(folders, path) {
			a.engine.SetMeta(metaTrusted, mustJSON(append(folders, path)))
			a.engine.Log("You", models.LogSession, "Trusted the folder "+path, "Trusted", "")
		}
	}); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// startClaude starts a Claude Code session with its folder ready and the hook token made. Call
// inside Do.
func (a *api) startClaude(spec claudecode.SessionSpec) (*models.LiveAgent, error) {
	if _, err := projectFolder(spec.Folder); err != nil {
		return nil, errors.New("Couldn't make the folder " + spec.Folder + ": " + err.Error())
	}
	if a.claude.TokenFile == "" {
		if err := claudecode.EnsureToken(a.claude.Secrets); err != nil {
			return nil, errors.New("Couldn't make the token Claude Code reports with: " + err.Error())
		}
	}
	return a.claude.Connector.StartSession(spec)
}

// uniqueName adds a number to a name already in the office. Call inside Do.
func (a *api) uniqueName(name string) string {
	taken := name
	for number := 2; a.engine.AgentByName(taken) != nil; number++ {
		taken = name + " " + strconv.Itoa(number)
	}
	return taken
}

// sessionAgent finds an agent with a Claude Code session behind it. Call inside Do.
func (a *api) sessionAgent(id string) *models.LiveAgent {
	agent := a.engine.Agent(id)
	if agent == nil || agent.Session == nil || agent.Source != claudecode.Source || a.claude == nil {
		return nil
	}
	return agent
}

// resumeSession is POST /api/agents/{id}/session/resume. It lets Mabari run a session, sending what
// is waiting for it. A session started elsewhere may still be open there, and two programs writing
// to one session mix up its history, so taking one over needs the person's word that they know:
// without confirm it says so and changes nothing.
func (a *api) resumeSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Confirm bool `json:"confirm"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	var found, stillOpen bool
	var problem error
	if err := a.engine.Do(func() {
		agent := a.sessionAgent(r.PathValue("id"))
		if agent == nil {
			return
		}
		found = true
		if agent.Session.Status == models.SessionElsewhere && !body.Confirm {
			stillOpen = true
			return
		}
		problem = a.claude.Connector.ResumeSession(agent)
	}); err != nil {
		internalError(w, err)
		return
	}
	switch {
	case !found:
		writeError(w, http.StatusNotFound, "no such session")
	case stillOpen:
		writeError(w, http.StatusConflict, "This session may still be open in a terminal or an editor. Close it there first: "+
			"if both carry on, their messages mix in one history.")
	case problem != nil:
		writeError(w, http.StatusConflict, problem.Error())
	default:
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// releaseSession is POST /api/agents/{id}/session/release: Mabari lets go of a session so it can be
// continued in a terminal, and it stays resumable from here.
func (a *api) releaseSession(w http.ResponseWriter, r *http.Request) {
	var found bool
	var problem error
	if err := a.engine.Do(func() {
		agent := a.sessionAgent(r.PathValue("id"))
		if agent == nil {
			return
		}
		found = true
		problem = a.claude.Connector.ReleaseSession(agent)
	}); err != nil {
		internalError(w, err)
		return
	}
	switch {
	case !found:
		writeError(w, http.StatusNotFound, "no such session")
	case problem != nil:
		writeError(w, http.StatusConflict, problem.Error())
	default:
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// hasIdleRun reports whether one of the agents is a session Mabari runs that can take a message
// as typed. A slash command only runs that way.
func hasIdleRun(agents []*models.LiveAgent) bool {
	return slices.ContainsFunc(agents, func(agent *models.LiveAgent) bool {
		return agent.Source == claudecode.Source && agent.RunsHere() && !agent.State.Active() && agent.Approval == nil
	})
}

// startForProject starts a session to take a message for a project nobody there can take. Call
// inside Do.
func (a *api) startForProject(project *models.Project, text string, route *projectRoute) {
	if route.trust = a.needsTrust(project.Repository.Path); route.trust != nil {
		route.sent.Problem = project.Name + "'s folder has its own Claude Code settings, which can run code. " +
			"Start it from its project chat to say you trust it."
		return
	}
	known := a.instructionIDs()
	agent, err := a.startClaude(claudecode.SessionSpec{
		Name: a.uniqueName(project.Name), Folder: project.Repository.Path, Task: text, Project: project.ID,
	})
	if err != nil {
		route.sent.Problem = err.Error()
		return
	}
	// A copy, read after Do without the lock.
	copied := *agent
	route.sent.Agent, route.sent.Where = &copied, a.whereIs(agent, known)
	route.result.Agents = append(route.result.Agents, agent.ID)
}

// startLead starts a project's lead as a session Mabari runs, and says what happened. Call outside
// Do. A project cloned from a URL has only now shown what it brings, so that is checked here.
func (a *api) startLead(project models.Project, name string, body startBody) (string, string) {
	if trust := a.needsTrust(project.Repository.Path); trust != nil {
		return "", name + " has its own Claude Code settings, which can run code, so no session started. " +
			"Send it a message from its project chat to say whether you trust it."
	}
	lead := strings.TrimSpace(body.Plan.LeadName)
	var agent *models.LiveAgent
	var problem error
	if err := a.engine.Do(func() {
		agent, problem = a.startClaude(claudecode.SessionSpec{
			Name: a.uniqueName(lead), Folder: project.Repository.Path, Task: strings.TrimSpace(body.Plan.LeadTask),
			Model: body.Plan.LeadModel, Project: project.ID, Prompt: briefFor(name, body), Plan: body.Mode == "plan",
		})
	}); err != nil {
		return "", err.Error()
	}
	if problem != nil {
		return "", problem.Error()
	}
	return agent.ID, ""
}
