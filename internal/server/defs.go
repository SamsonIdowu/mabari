// SPDX-License-Identifier: Apache-2.0

package server

import (
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/agentdefs"
	"github.com/SamsonIdowu/mabari/internal/models"
)

// defsRoutes serve the agent builder. Every change is a file in an agent folder; the office hears
// about it from the scan that follows, so the page and the files can't disagree.
func (a *api) defsRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/defs", a.saveDef)
	mux.HandleFunc("DELETE /api/defs/{id}", a.deleteDef)
	mux.HandleFunc("POST /api/defs/{id}/enabled", a.enableDef)
	mux.HandleFunc("POST /api/defs/{id}/run", a.runDef)
	mux.HandleFunc("POST /api/defs/rescan", a.rescanDefs)
}

// defProblem answers with the person's words for a problem, or a server error.
func defProblem(w http.ResponseWriter, err error) {
	var problem agentdefs.Problem
	if errors.As(err, &problem) {
		writeError(w, http.StatusBadRequest, problem.Error())
		return
	}
	internalError(w, err)
}

func (a *api) findDef(id string) (models.AgentDef, bool) {
	var found models.AgentDef
	var ok bool
	_ = a.engine.Do(func() {
		for _, def := range a.engine.Defs() {
			if def.ID == id {
				found, ok = def, true
			}
		}
	})
	return found, ok
}

func defTitle(name string) string {
	words := strings.Split(name, "-")
	for index, word := range words {
		if word != "" {
			words[index] = strings.ToUpper(word[:1]) + word[1:]
		}
	}
	return strings.Join(words, " ")
}

func (a *api) saveDef(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Def models.AgentDef `json:"def"`
		// PreviousID is the definition being edited, or empty for a new one.
		PreviousID string `json:"previousId"`
		// By is "mabari" when Mabari suggested the change.
		By string `json:"by"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.PreviousID != "" {
		if _, ok := a.findDef(body.PreviousID); !ok {
			writeError(w, http.StatusNotFound, "That agent's file is gone. Reload from disk and try again.")
			return
		}
	}
	saved, err := a.defs.Save(body.Def, body.PreviousID)
	if err != nil {
		defProblem(w, err)
		return
	}
	if _, err := a.defs.Refresh(a.engine); err != nil {
		internalError(w, err)
		return
	}
	verb := "Built agent "
	if body.PreviousID != "" {
		verb = "Updated agent "
	}
	_ = a.engine.Do(func() {
		a.engine.Log(defTitle(saved.Name), models.LogSession, verb+saved.Name, "Saved to "+saved.Path, "ok")
	})
	writeJSON(w, http.StatusOK, saved)
}

func (a *api) deleteDef(w http.ResponseWriter, r *http.Request) {
	def, ok := a.findDef(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "That agent's file is gone already.")
		return
	}
	if err := a.defs.Delete(def.ID); err != nil {
		defProblem(w, err)
		return
	}
	if _, err := a.defs.Refresh(a.engine); err != nil {
		internalError(w, err)
		return
	}
	_ = a.engine.Do(func() {
		a.engine.Log(defTitle(def.Name), models.LogSession, "Deleted agent "+def.Name, "Removed "+def.Path, "")
	})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *api) enableDef(w http.ResponseWriter, r *http.Request) {
	var body struct {
		On bool `json:"on"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	def, ok := a.findDef(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "That agent's file is gone.")
		return
	}
	if err := a.defs.SetEnabled(def.ID, body.On); err != nil {
		defProblem(w, err)
		return
	}
	if _, err := a.defs.Refresh(a.engine); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *api) rescanDefs(w http.ResponseWriter, _ *http.Request) {
	report, err := a.defs.Refresh(a.engine)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, report)
}

// sessionTools turns an agent file's tools into the New agent dialog's tool groups.
func sessionTools(tools []string) []string {
	groups := map[string]string{
		"Read": "read", "Grep": "read", "Glob": "read", "Edit": "edit", "Write": "edit",
		"Bash": "shell", "WebSearch": "web", "WebFetch": "web", "Task": "spawn",
	}
	var out []string
	for _, tool := range tools {
		if group, ok := groups[tool]; ok && !slices.Contains(out, group) {
			out = append(out, group)
		}
	}
	return out
}

// runAccounts is the order Run looks for a connected account, Claude first, as agent files are
// Claude Code's format.
var runAccounts = []models.AccountKind{
	models.AccountClaudeCode, models.AccountAnthropicKey, models.AccountCodex, models.AccountOpenAIKey,
}

// runBody works out how to start an agent from a definition, as the prototype's Run does. Call
// inside Do.
func (a *api) runBody(def models.AgentDef) (newAgentBody, string) {
	account := models.AccountKind("")
	order := runAccounts
	if def.Kind == models.DefCodex {
		// A Codex agent runs on Codex, or on an OpenAI key.
		order = []models.AccountKind{models.AccountCodex, models.AccountOpenAIKey}
	}
	for _, kind := range order {
		if a.connected(kind) {
			account = kind
			break
		}
	}
	if account == "" {
		if def.Kind == models.DefCodex {
			return newAgentBody{}, "Sign in with ChatGPT for Codex first."
		}
		return newAgentBody{}, "Connect an account first."
	}
	title := strings.Fields(defTitle(def.Name))
	base := title[len(title)-1]
	name := base
	for n := 2; a.engine.AgentByName(name) != nil; n++ {
		name = base + " " + strconv.Itoa(n)
	}
	available := models.Models[account]
	model := available[0]
	for _, candidate := range available {
		if def.Model != "inherit" && (candidate == def.Model || strings.Contains(candidate, def.Model)) {
			model = candidate
			break
		}
	}
	task := strings.TrimSuffix(def.Description, ".")
	for _, opener := range []string{"Use to ", "Use when ", "Use for ", "Use after ", "Use "} {
		if strings.HasPrefix(task, opener) {
			task = strings.TrimPrefix(task, opener)
			task = strings.ToUpper(task[:1]) + task[1:]
			break
		}
	}
	project, folder := def.ProjectID, ""
	if p := a.engine.Project(project); p != nil && p.Repository != nil {
		folder = p.Repository.Path
	}
	if project == "" {
		if projects := a.engine.Projects(); len(projects) > 0 {
			project = projects[0].ID
			if projects[0].Repository != nil {
				folder = projects[0].Repository.Path
			}
		}
	}
	if folder == "" {
		folder = "~"
	}
	return newAgentBody{
		Name: name, Account: account, Model: model, Task: task, ProjectID: project, Folder: folder,
		AllowedTools: sessionTools(def.Tools),
	}, ""
}

// runDef starts an agent from a definition straight away, as the builder's Run does.
func (a *api) runDef(w http.ResponseWriter, r *http.Request) {
	def, ok := a.findDef(r.PathValue("id"))
	switch {
	case !ok:
		writeError(w, http.StatusNotFound, "That agent's file is gone.")
		return
	case def.System:
		writeError(w, http.StatusBadRequest, "Mabari is already at work. Run one of the other agents.")
		return
	case !def.Enabled:
		writeError(w, http.StatusBadRequest, def.Name+" is turned off. Turn it on to run it.")
		return
	}
	var agent *models.LiveAgent
	var problem string
	err := a.engine.Do(func() {
		var body newAgentBody
		if body, problem = a.runBody(def); problem != "" {
			return
		}
		if problem = body.check(); problem != "" {
			return
		}
		if agent, problem = a.startAgent(body); agent != nil {
			agent.DefID = def.ID
			a.engine.Touch(agent)
			a.engine.Log(agent.Name, models.LogSession, "Started from "+def.Name, "Took desk "+strconv.Itoa(agent.Desk+1), "ok")
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
	if err := a.defs.CountRun(def.ID); err != nil {
		internalError(w, err)
		return
	}
	if _, err := a.defs.Refresh(a.engine); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, agent)
}

// dispatched counts a request Mabari routed, for "Dispatched N tasks" on its card. Call after Do.
func (a *api) dispatched() {
	if a.defs == nil {
		return
	}
	if err := a.defs.CountRun(agentdefs.ID(models.DefAccount, "", agentdefs.MabariName)); err != nil {
		return
	}
	_, _ = a.defs.Refresh(a.engine)
}
