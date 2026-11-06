// SPDX-License-Identifier: Apache-2.0

package server

import (
	"errors"
	"net/http"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/vee"
)

// Watches are "tell me when it's done": kept on the server, so they survive a reload, and fired by
// the engine. The routes only set and cancel them. Nothing here, or in what a watch sends, can
// approve anything: an instruction a watch passes on takes the same path as any other.

func (a *api) watchRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/watches", a.listWatches)
	mux.HandleFunc("POST /api/watches", a.setWatch)
	mux.HandleFunc("DELETE /api/watches/{id}", a.cancelWatch)
	mux.HandleFunc("DELETE /api/watches/{id}/then", a.cancelWatchThen)
}

func (a *api) listWatches(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, a.engine.Snapshot().Watches)
}

type watchBody struct {
	Kind   models.WatchKind `json:"kind"`
	Target string           `json:"target"`
	// Then is an instruction for another agent, sent when the work is done.
	Then *struct {
		AgentID string `json:"agentId"`
		Text    string `json:"text"`
	} `json:"then"`
}

// watchResult is what setting a watch came to. Watch is null when the work had already ended, and
// Already says how. Text is Mabari's own sentence for it, the one it would say in chat.
type watchResult struct {
	Watch   *models.Watch       `json:"watch"`
	Already models.WatchOutcome `json:"already"`
	Kept    bool                `json:"kept"`
	Text    string              `json:"text"`
}

// watchStatus is the status code for a reason a watch couldn't be set or changed.
func watchStatus(err error) int {
	switch {
	case errors.Is(err, events.ErrWatchSubject), errors.Is(err, events.ErrNoWatch):
		return http.StatusNotFound
	case errors.Is(err, events.ErrWatchThenAgent), errors.Is(err, events.ErrWatchLimit):
		return http.StatusConflict
	default:
		return http.StatusBadRequest
	}
}

// watchProblem says why a watch couldn't be set, in a sentence for the person.
func watchProblem(err error, ask vee.WatchAsk) string {
	subject, then := ask.Name, ask.ThenName
	if subject == "" {
		subject = "That agent or project"
	}
	if then == "" {
		then = "The agent to tell"
	}
	switch {
	case errors.Is(err, events.ErrWatchSubject):
		return subject + " has left, so there is nothing to watch."
	case errors.Is(err, events.ErrWatchThenAgent):
		return then + " has left the office, so I can't tell it anything."
	case errors.Is(err, events.ErrWatchLimit):
		return "I'm watching as much as I can. Cancel a watch first."
	}
	text := err.Error()
	return strings.ToUpper(text[:1]) + text[1:] + "."
}

// startWatch starts a watch in the engine and says what came of it. Call inside Do.
func (a *api) startWatch(request events.WatchRequest) (watchResult, error) {
	set, err := a.engine.SetWatch(request)
	if err != nil {
		return watchResult{}, err
	}
	return watchResult{
		Watch: set.Watch, Already: set.Already, Kept: set.Kept,
		Text: vee.WatchSaid(vee.WatchResult{
			Kind: request.Kind, Name: set.Name, Task: set.Task, Detail: set.Detail,
			Already: set.Already, Kept: set.Kept, Then: set.Then,
		}),
	}, nil
}

func (a *api) setWatch(w http.ResponseWriter, r *http.Request) {
	var body watchBody
	if !readJSON(w, r, &body) {
		return
	}
	request := events.WatchRequest{Kind: body.Kind, Target: body.Target}
	if body.Then != nil {
		request.ThenAgent, request.ThenText = body.Then.AgentID, body.Then.Text
	}
	var result watchResult
	var failure error
	if err := a.engine.Do(func() { result, failure = a.startWatch(request) }); err != nil {
		internalError(w, err)
		return
	}
	if failure != nil {
		writeError(w, watchStatus(failure), watchProblem(failure, vee.WatchAsk{}))
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *api) cancelWatch(w http.ResponseWriter, r *http.Request) {
	a.changeWatch(w, r, a.engine.CancelWatch)
}

func (a *api) cancelWatchThen(w http.ResponseWriter, r *http.Request) {
	a.changeWatch(w, r, a.engine.CancelWatchThen)
}

// changeWatch runs a change to the watch in the path. Cancelling the whole watch answers with no
// content, and taking the instruction off answers with the watch that is left.
func (a *api) changeWatch(w http.ResponseWriter, r *http.Request, change func(string) (models.Watch, error)) {
	var left models.Watch
	var failure error
	if err := a.engine.Do(func() { left, failure = change(r.PathValue("id")) }); err != nil {
		internalError(w, err)
		return
	}
	switch {
	case failure != nil:
		writeError(w, watchStatus(failure), watchProblem(failure, vee.WatchAsk{}))
	case strings.HasSuffix(r.URL.Path, "/then"):
		writeJSON(w, http.StatusOK, left)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

// watchForVee sets the watch Mabari was asked for in chat, and says how it went. Call inside Do.
func (a *api) watchForVee(ask vee.WatchAsk) vee.Reply {
	request := events.WatchRequest{
		Kind: ask.Kind, Target: ask.Target, ThenAgent: ask.ThenAgent, ThenText: ask.ThenText,
	}
	set, err := a.engine.SetWatch(request)
	if err != nil {
		return vee.Watching(vee.WatchResult{Problem: watchProblem(err, ask)}, a.engine.Agents(), a.engine.Now())
	}
	return vee.Watching(vee.WatchResult{
		Kind: ask.Kind, Name: set.Name, Task: set.Task, Detail: set.Detail,
		Already: set.Already, Kept: set.Kept, Then: set.Then,
	}, a.engine.Agents(), a.engine.Now())
}
