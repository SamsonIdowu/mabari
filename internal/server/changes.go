// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"net/http"
	"slices"

	"github.com/SamsonIdowu/mabari/internal/connectors/simulator"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/review"
)

// The review view's routes. They take an agent or a project by id, never a path: the folder
// that is read is the one Mabari already holds for it, worked out here and not from the request.
// What Git prints is read only, goes through the secret filter and is size-limited; see
// internal/review. Nothing here can commit, push, check out or discard.

func (a *api) changesRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/agents/{id}/changes", a.agentChanges)
	mux.HandleFunc("GET /api/projects/{id}/changes", a.projectChanges)
	mux.HandleFunc("POST /api/agents/{id}/changes/opinion", a.agentOpinion)
	mux.HandleFunc("POST /api/projects/{id}/changes/opinion", a.projectOpinion)
}

// changesTarget is what a read needs, copied out of the office so Git runs outside its lock.
type changesTarget struct {
	// name is who made the changes, as a sentence says it: an agent's name, or "the Shop team".
	name   string
	folder string
	// demo means the agents are the demo's, with no real folder, and the changes are made up.
	demo  bool
	files []string
	// problem is why no folder can be named, or "".
	problem string
}

// agentTarget is the folder an agent works in. Call inside Do.
func (a *api) agentTarget(id string) (changesTarget, bool) {
	agent := a.engine.Agent(id)
	if agent == nil {
		return changesTarget{}, false
	}
	target := changesTarget{name: agent.Name, folder: agent.Folder}
	// The demo's agents are simulated: whatever folder they are given is never read, since it may
	// well be a real one on this computer.
	if agent.Source == simulator.Source {
		target.demo, target.files = true, slices.Clone(agent.Files)
	}
	return target, true
}

// projectTarget is the folder a project works in: the one attached to it, or the one its agents
// share. Call inside Do.
func (a *api) projectTarget(id string) (changesTarget, bool) {
	project := a.engine.Project(id)
	if project == nil {
		return changesTarget{}, false
	}
	target := changesTarget{name: "the " + project.Name + " team"}
	if project.Repository != nil && project.Repository.Path != "" {
		target.folder = project.Repository.Path
		return target, true
	}
	var folders []string
	var files []string
	simulated := false
	for _, agent := range a.engine.Agents() {
		if agent.Project == nil || *agent.Project != project.ID {
			continue
		}
		if agent.Source == simulator.Source {
			simulated = true
			target.folder = cmpOr(target.folder, agent.Folder)
			for _, file := range agent.Files {
				if !slices.Contains(files, file) {
					files = append(files, file)
				}
			}
			continue
		}
		if agent.Folder != "" && !slices.Contains(folders, agent.Folder) {
			folders = append(folders, agent.Folder)
		}
	}
	switch {
	case len(folders) == 1:
		target.folder = folders[0]
	case len(folders) > 1:
		target.problem = "The agents on " + project.Name + " work in different folders. Attach one folder to the project on the Projects page to see its changes."
	case simulated:
		target.demo, target.files = true, files
	default:
		target.problem = "Attach a folder to " + project.Name + " on the Projects page, or start an agent on it, to see its changes."
	}
	return target, true
}

func cmpOr(first, second string) string {
	if first != "" {
		return first
	}
	return second
}

// readChanges reads what a target changed. Call outside Do: it runs Git.
func (a *api) readChanges(ctx context.Context, target changesTarget, have string) models.Changes {
	switch {
	case target.problem != "":
		return models.Changes{State: models.ChangesNoFolder, Message: target.problem, Folder: target.folder, Files: []models.ChangedFile{}}
	case target.demo:
		changes := review.Demo(target.folder, target.files)
		if have != "" && have == changes.Version {
			return models.Changes{State: models.ChangesUnchanged, Version: changes.Version, Demo: true, Files: []models.ChangedFile{}}
		}
		return changes
	}
	return a.review.Read(ctx, target.folder, have)
}

// maxVersion is the longest version a request may hold. A longer one is nobody's.
const maxVersion = 64

func (a *api) changes(w http.ResponseWriter, r *http.Request, find func(string) (changesTarget, bool)) {
	var target changesTarget
	var found bool
	if err := a.engine.Do(func() { target, found = find(r.PathValue("id")) }); err != nil {
		internalError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "no such agent or project")
		return
	}
	have := r.URL.Query().Get("version")
	if len(have) > maxVersion {
		have = ""
	}
	writeJSON(w, http.StatusOK, a.readChanges(r.Context(), target, have))
}

func (a *api) agentChanges(w http.ResponseWriter, r *http.Request) {
	a.changes(w, r, a.agentTarget)
}

func (a *api) projectChanges(w http.ResponseWriter, r *http.Request) {
	a.changes(w, r, a.projectTarget)
}

type opinionBody struct {
	ReviewerID string `json:"reviewerId"`
}

// opinionResult is the reply to a request for a second opinion. AgentID and InstructionID say
// where the reviewer's answer will show: in its panel, under what was sent to it.
type opinionResult struct {
	Notice        string `json:"notice"`
	AgentID       string `json:"agentId"`
	InstructionID string `json:"instructionId"`
	Queued        bool   `json:"queued"`
}

// opinion sends a target's changes to a chosen agent to review, as an ordinary instruction: it
// goes the way any instruction does, so the reviewer's own risky actions still need a click.
func (a *api) opinion(w http.ResponseWriter, r *http.Request, find func(string) (changesTarget, bool), byAgent bool) {
	var body opinionBody
	if !readJSON(w, r, &body) {
		return
	}
	var target changesTarget
	var found, gone, itself, simulated bool
	var reviewerName string
	if err := a.engine.Do(func() {
		if target, found = find(r.PathValue("id")); !found {
			return
		}
		reviewer := a.engine.Agent(body.ReviewerID)
		switch {
		case reviewer == nil || reviewer.Leaving || a.engine.ConnectorFor(reviewer) == nil:
			gone = true
		case byAgent && reviewer.ID == r.PathValue("id"):
			itself = true
		default:
			reviewerName, simulated = reviewer.Name, reviewer.Source == simulator.Source
		}
	}); err != nil {
		internalError(w, err)
		return
	}
	switch {
	case !found:
		writeError(w, http.StatusNotFound, "no such agent or project")
		return
	case gone:
		writeError(w, http.StatusNotFound, "That agent has left the office. Pick another.")
		return
	case itself:
		writeError(w, http.StatusBadRequest, "A second opinion comes from someone else. Pick another agent.")
		return
	}
	changes := a.readChanges(r.Context(), target, "")
	switch {
	case changes.State != models.ChangesRead:
		writeError(w, http.StatusConflict, changes.Message)
		return
	case changes.FileCount == 0:
		writeError(w, http.StatusConflict, "Nothing has changed yet, so there is nothing to review.")
		return
	}
	// The demo's agents don't read a diff, and take a long instruction for their task, so they
	// are given the summary and the file names.
	text, _ := review.Opinion(target.name, target.folder, changes)
	if simulated {
		text = review.OpinionSummary(target.name, target.folder, changes)
	}
	var result opinionResult
	if err := a.engine.Do(func() {
		reviewer := a.engine.Agent(body.ReviewerID)
		if reviewer == nil || reviewer.Leaving {
			gone = true
			return
		}
		known := a.instructionIDs()
		a.engine.ConnectorFor(reviewer).Instruct(reviewer, text)
		where := a.whereIs(reviewer, known)
		result = opinionResult{AgentID: reviewer.ID, InstructionID: where.InstructionID, Queued: where.Queued}
		result.Notice = "Asked " + reviewerName + " for a second opinion on " + target.name + "'s changes."
		if where.Queued {
			result.Notice += " " + reviewerName + " gets it at its next checkpoint."
		}
	}); err != nil {
		internalError(w, err)
		return
	}
	if gone {
		writeError(w, http.StatusNotFound, "That agent has left the office. Pick another.")
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *api) agentOpinion(w http.ResponseWriter, r *http.Request) {
	a.opinion(w, r, a.agentTarget, true)
}

func (a *api) projectOpinion(w http.ResponseWriter, r *http.Request) {
	a.opinion(w, r, a.projectTarget, false)
}
