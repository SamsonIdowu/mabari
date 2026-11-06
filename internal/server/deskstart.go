// SPDX-License-Identifier: Apache-2.0

package server

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/connectors/claudecode"
	"github.com/SamsonIdowu/mabari/internal/models"
)

// agentName is the form of an agent file's name that goes on Claude Code's command line.
var agentName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)

// deskStartBody is POST /api/desks/start: put an agent file's agent at the free desk, working on
// a task, in a project.
type deskStartBody struct {
	DefID     string `json:"defId"`
	ProjectID string `json:"projectId"`
	Task      string `json:"task"`
}

// deskStartResult says what happened: the agent that sat down in the demo, or the notice about
// the Claude Code window opening for a real one.
type deskStartResult struct {
	Notice  string            `json:"notice"`
	Opened  bool              `json:"opened"`
	AgentID string            `json:"agentId"`
	Agent   *models.LiveAgent `json:"agent,omitempty"`
}

// startAtDesk starts one of the agent files at the free desk with a task. For real, a Claude
// agent is a Claude Code session opened in the project's folder with `--agent <name>` and the
// task as its first prompt: it reports to the office and takes the free desk as it starts. In the
// demo, and for Codex, Mabari starts the agent itself.
func (a *api) startAtDesk(w http.ResponseWriter, r *http.Request) {
	var body deskStartBody
	if !readJSON(w, r, &body) {
		return
	}
	task := strings.TrimSpace(body.Task)
	def, ok := a.findDef(body.DefID)
	switch {
	case !ok:
		writeError(w, http.StatusNotFound, "That agent's file is gone.")
		return
	case def.System:
		writeError(w, http.StatusBadRequest, "Mabari is already at work. Pick one of the other agents.")
		return
	case !def.Enabled:
		writeError(w, http.StatusBadRequest, def.Name+" is turned off. Turn it on to start it.")
		return
	case task == "":
		writeError(w, http.StatusBadRequest, "Say what "+def.Name+" should do.")
		return
	}
	// A project's own agent works in that project.
	projectID := body.ProjectID
	if def.Scope == models.DefProject {
		projectID = def.ProjectID
	}
	var project *models.Project
	var demo bool
	var shadowed bool
	_ = a.engine.Do(func() {
		demo = a.simulator.DemoActive()
		if found := a.engine.Project(projectID); found != nil {
			copied := *found
			project = &copied
		}
		// Claude Code runs a project's own agent of the same name before the account's.
		if def.Scope == models.DefAccount && projectID != "" {
			for _, other := range a.engine.Defs() {
				if other.Scope == models.DefProject && other.ProjectID == projectID && other.Enabled &&
					other.Kind == def.Kind && strings.EqualFold(other.Name, def.Name) {
					shadowed = true
				}
			}
		}
	})
	switch {
	case projectID != "" && project == nil:
		writeError(w, http.StatusNotFound, "That project is gone.")
		return
	case project != nil && project.Done != nil:
		writeError(w, http.StatusBadRequest, project.Name+" is completed. Reopen it to start work there.")
		return
	case shadowed:
		writeError(w, http.StatusBadRequest, project.Name+" has its own "+def.Name+", which Claude Code would run instead. Pick that one.")
		return
	}
	hasFolder := project != nil && project.Repository != nil && project.Repository.Path != ""
	if !demo && !hasFolder {
		writeError(w, http.StatusBadRequest, "Pick a project with a folder for "+def.Name+" to work in.")
		return
	}
	if demo || def.Kind == models.DefCodex {
		a.startDefAgent(w, def, task, project)
		return
	}
	if !agentName.MatchString(def.Name) {
		writeError(w, http.StatusBadRequest, def.Name+"'s name can't be passed to Claude Code.")
		return
	}
	if problem := promptProblem(task); problem != "" {
		writeError(w, http.StatusBadRequest, problem)
		return
	}
	if a.runsClaude() {
		a.runAtDesk(w, def, task, *project)
		return
	}
	// The task waits in the project for the session's first prompt, which links the two. When no
	// window opens, the person starts it by hand, and it waits the same way, for 15 minutes.
	_ = a.engine.Do(func() {
		if current := a.engine.Project(project.ID); current != nil {
			a.engine.Opening(current, task)
		}
	})
	notice, opened := a.openClaudeAs(project.Name, project.Repository.Path, task, false, def.Name)
	if opened {
		a.countRun(def.ID)
	}
	writeJSON(w, http.StatusOK, deskStartResult{Notice: notice, Opened: opened})
}

// runAtDesk starts an agent file's agent as a session Mabari runs.
func (a *api) runAtDesk(w http.ResponseWriter, def models.AgentDef, task string, project models.Project) {
	if trust := a.needsTrust(project.Repository.Path); trust != nil {
		writeTrustNeeded(w, trust)
		return
	}
	var copied models.LiveAgent
	var problem error
	if err := a.engine.Do(func() {
		agent, failed := a.startClaude(claudecode.SessionSpec{
			Name: a.uniqueName(def.Name), Folder: project.Repository.Path, Task: task, Model: def.Model,
			Project: project.ID, AgentFile: def.Name, DefID: def.ID,
		})
		if problem = failed; agent != nil {
			copied = *agent
			copied.Feed = nil
		}
	}); err != nil {
		internalError(w, err)
		return
	}
	if problem != nil {
		writeError(w, http.StatusConflict, problem.Error())
		return
	}
	a.countRun(def.ID)
	writeJSON(w, http.StatusCreated, deskStartResult{
		Notice: copied.Name + " sat down to work.", Opened: true, AgentID: copied.ID, Agent: &copied,
	})
}

// startDefAgent starts an agent file's agent in Mabari, with the task, as the demo and Codex do.
func (a *api) startDefAgent(w http.ResponseWriter, def models.AgentDef, task string, project *models.Project) {
	var agent *models.LiveAgent
	var copied models.LiveAgent
	var problem string
	err := a.engine.Do(func() {
		var body newAgentBody
		if body, problem = a.runBody(def); problem != "" {
			return
		}
		// It works where the person chose: that project's folder, or no project at all.
		body.Task, body.ProjectID, body.Folder = task, "", "~"
		if project != nil {
			body.ProjectID = project.ID
			if project.Repository != nil && project.Repository.Path != "" {
				body.Folder = project.Repository.Path
			}
		}
		if problem = body.check(); problem != "" {
			return
		}
		if agent, problem = a.startAgent(body); agent != nil {
			agent.DefID = def.ID
			// The demo puts an agent with no project in the first one; "No project" means none.
			if project == nil {
				agent.Project = nil
			}
			a.engine.Touch(agent)
			a.engine.Log(agent.Name, models.LogSession, "Started from "+def.Name,
				"Took desk "+strconv.Itoa(agent.Desk+1), "ok")
			// Copied here, as the engine keeps changing the agent once Do ends.
			copied = *agent
			copied.Feed = nil
		}
	})
	switch {
	case err != nil:
		internalError(w, err)
		return
	case problem != "":
		writeError(w, http.StatusConflict, problem)
		return
	}
	a.countRun(def.ID)
	writeJSON(w, http.StatusCreated, deskStartResult{
		Notice: copied.Name + " sat down to work.", AgentID: copied.ID, Agent: &copied,
	})
}

// countRun adds one to an agent file's runs, for its card in the builder.
func (a *api) countRun(id string) {
	if a.defs == nil || a.defs.CountRun(id) != nil {
		return
	}
	_, _ = a.defs.Refresh(a.engine)
}
