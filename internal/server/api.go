// SPDX-License-Identifier: Apache-2.0

package server

import (
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

const (
	maxProjectName = 28
	eventPageLimit = 200
)

var retentionChoices = []int{7, 30, 90, 365}

func (a *api) routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/snapshot", a.snapshot)
	mux.HandleFunc("GET /ws", a.websocket)
	mux.HandleFunc("POST /api/demo/load", a.loadDemo)
	mux.HandleFunc("POST /api/wipe", a.wipe)

	mux.HandleFunc("GET /api/projects", a.listProjects)
	mux.HandleFunc("POST /api/projects", a.createProject)
	mux.HandleFunc("PATCH /api/projects/{id}", a.updateProject)
	mux.HandleFunc("DELETE /api/projects/{id}", a.deleteProject)

	mux.HandleFunc("GET /api/agents", a.listAgents)
	mux.HandleFunc("GET /api/agents/{id}", a.getAgent)
	mux.HandleFunc("PATCH /api/agents/{id}", a.updateAgent)
	mux.HandleFunc("GET /api/agents/{id}/events", a.agentEvents)

	mux.HandleFunc("GET /api/accounts", a.listAccounts)

	mux.HandleFunc("GET /api/settings", a.getSettings)
	mux.HandleFunc("PATCH /api/settings", a.updateSettings)

	mux.HandleFunc("GET /api/approvals", a.listApprovals)
	mux.HandleFunc("POST /api/approvals/{id}/decision", a.decide)

	mux.HandleFunc("GET /api/activity", a.activity)
}

func (a *api) snapshot(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, a.engine.Snapshot())
}

func (a *api) loadDemo(w http.ResponseWriter, _ *http.Request) {
	if err := a.simulator.LoadDemo(); err != nil {
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
	if err := a.engine.Do(a.engine.Wipe); err != nil {
		internalError(w, err)
		return
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
}

func validProjectName(name string) bool {
	trimmed := strings.TrimSpace(name)
	return trimmed != "" && len([]rune(trimmed)) <= maxProjectName
}

func (a *api) createProject(w http.ResponseWriter, r *http.Request) {
	var body projectBody
	if !readJSON(w, r, &body) {
		return
	}
	if body.Name == nil || !validProjectName(*body.Name) || body.Color == nil {
		writeError(w, http.StatusBadRequest, "a project needs a name of up to 28 characters and a colour")
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
	var saved *models.Project
	err := a.engine.Do(func() {
		existing := a.engine.Project(r.PathValue("id"))
		if existing == nil {
			return
		}
		project := *existing
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

func (a *api) updateAgent(w http.ResponseWriter, r *http.Request) {
	var body agentBody
	if !readJSON(w, r, &body) {
		return
	}
	if body.DailyCostCap != nil && *body.DailyCostCap < 0 {
		writeError(w, http.StatusBadRequest, "a cost cap can't be negative")
		return
	}
	var saved *models.Agent
	var badProject bool
	err := a.engine.Do(func() {
		agent := a.engine.Agent(r.PathValue("id"))
		if agent == nil {
			return
		}
		if body.Project != nil && a.engine.Project(*body.Project) == nil {
			badProject = true
			return
		}
		applyAgentBody(agent, body)
		a.engine.Touch(agent)
		copied := agent.Agent
		saved = &copied
	})
	if badProject {
		writeError(w, http.StatusBadRequest, "no such project")
		return
	}
	respond(w, saved, err, "no such agent")
}

func applyAgentBody(agent *models.LiveAgent, body agentBody) {
	if body.Model != nil {
		agent.Model = *body.Model
	}
	if body.SubModel != nil {
		agent.SubModel = *body.SubModel
	}
	if body.Project != nil {
		agent.Project = body.Project
	}
	if body.Folder != nil {
		agent.Folder = *body.Folder
	}
	if body.DailyCostCap != nil {
		agent.DailyCostCap = body.DailyCostCap
	}
	if body.AllowedTools != nil {
		agent.AllowedTools = *body.AllowedTools
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
	default:
		return ""
	}
}

func (a *api) updateSettings(w http.ResponseWriter, r *http.Request) {
	// Decoding onto the current settings is what makes this a partial update.
	settings := a.engine.Snapshot().Settings
	if !readJSON(w, r, &settings) {
		return
	}
	if problem := validSettings(settings); problem != "" {
		writeError(w, http.StatusBadRequest, problem)
		return
	}
	if err := a.engine.Do(func() { a.engine.SaveSettings(settings) }); err != nil {
		internalError(w, err)
		return
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
	entries, err := a.engine.Store().Log(r.Context(), store.LogQuery{
		Search: r.URL.Query().Get("q"),
		Type:   models.LogType(r.URL.Query().Get("type")),
		Limit:  int(positiveQuery(r, "limit", 500)),
	})
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, entries)
}
