// SPDX-License-Identifier: Apache-2.0

package events

// "Tell me when it's done": watches the server keeps, so they outlive a page reload and a restart.
// A watch is a one-shot. It fires once, when its agent is done or stops with an error, or when every
// agent on its project has finished, and then clears itself. It can carry an instruction for
// another agent, which goes through the same path as any instruction from the person, so that
// agent's risky actions still wait for a click. Nothing here can approve anything.

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

// WatchesMax caps how many watches wait at once, so nothing can fill the data folder with them.
const WatchesMax = 50

// WatchTextMax is the longest instruction a watch carries, in characters.
const WatchTextMax = 2000

// Why a watch couldn't be set or changed.
var (
	ErrWatchSubject   = errors.New("that agent or project has left")
	ErrWatchThenAgent = errors.New("the agent to tell has left the office")
	ErrWatchThenText  = errors.New("say what to tell it, in up to 2,000 characters")
	ErrWatchKind      = errors.New("a watch is on an agent or on a project")
	ErrWatchLimit     = errors.New("too many watches are waiting. Cancel one first")
	ErrNoWatch        = errors.New("no such watch")
)

// WatchRequest asks for a watch.
type WatchRequest struct {
	Kind   models.WatchKind
	Target string
	// ThenAgent and ThenText are an instruction to send when the work is done, or both empty.
	ThenAgent string
	ThenText  string
}

// WatchSet is what asking for a watch came to.
type WatchSet struct {
	// Watch is the watch in force. It is nil when the work had already ended, so nothing waits.
	Watch *models.Watch
	// Already is how the work had ended before there was anything to wait for.
	Already models.WatchOutcome
	// Kept is true when the thing was being watched already and nothing changed.
	Kept bool
	// Name and Task say what is watched. Detail is what went wrong, when it ended in an error.
	Name, Task, Detail string
	// Then is the instruction's agent, when the watch carries one.
	Then *models.WatchThen
}

// watched is what a watch is waiting on, as it stands now.
type watched struct {
	name, task string
	// outcome is empty while the work goes on.
	outcome models.WatchOutcome
	// detail is the error, or who hit one.
	detail string
	// agent is the agent to open for it: the agent, or the one that hit an error in a project.
	agent string
}

// watchedNow describes what a watch waits on, and false when it has gone: an agent that left,
// is leaving, or a project that was deleted. Call inside Do.
func (e *Engine) watchedNow(kind models.WatchKind, target string) (watched, bool) {
	switch kind {
	case models.WatchAgent:
		agent := e.Agent(target)
		if agent == nil || agent.Leaving {
			return watched{}, false
		}
		return watched{
			name: agent.Name, task: agent.Task, outcome: models.OutcomeOf(agent),
			detail: agent.Error, agent: agent.ID,
		}, true
	case models.WatchProject:
		project := e.Project(target)
		if project == nil {
			return watched{}, false
		}
		var members []*models.LiveAgent
		for _, agent := range e.agents {
			if agent.Project != nil && *agent.Project == project.ID {
				members = append(members, agent)
			}
		}
		now := watched{name: project.Name, outcome: models.ProjectOutcome(project, members)}
		if now.outcome == models.WatchFailed {
			for _, agent := range members {
				if !agent.Leaving && agent.State == models.StateError {
					now.detail, now.agent = agent.Name, agent.ID
					break
				}
			}
		}
		return now, true
	}
	return watched{}, false
}

// Watches lists the watches, oldest first. Call inside Do.
func (e *Engine) Watches() []models.Watch { return slices.Clone(e.watches) }

// SetWatch starts watching an agent or a project, with an instruction for another agent if one is
// given. If the work has already ended there is nothing to wait for, so no watch is made and the
// answer says how it ended. A thing already watched keeps its watch: asking again with no
// instruction changes nothing, and with one, replaces the instruction. Call inside Do.
func (e *Engine) SetWatch(request WatchRequest) (WatchSet, error) {
	if request.Kind != models.WatchAgent && request.Kind != models.WatchProject {
		return WatchSet{}, ErrWatchKind
	}
	now, ok := e.watchedNow(request.Kind, request.Target)
	if !ok {
		return WatchSet{}, ErrWatchSubject
	}
	set := WatchSet{Name: now.name, Task: now.task, Detail: now.detail}
	var then *models.WatchThen
	if request.ThenAgent != "" || strings.TrimSpace(request.ThenText) != "" {
		text := strings.TrimSpace(request.ThenText)
		if text == "" || utf8.RuneCountInString(text) > WatchTextMax {
			return set, ErrWatchThenText
		}
		agent := e.Agent(request.ThenAgent)
		if agent == nil || agent.Leaving {
			return set, ErrWatchThenAgent
		}
		then = &models.WatchThen{AgentID: agent.ID, AgentName: agent.Name, Text: text}
		set.Then = then
	}
	if now.outcome != "" {
		set.Already = now.outcome
		return set, nil
	}
	for index := range e.watches {
		existing := &e.watches[index]
		if existing.Kind != request.Kind || existing.Target != request.Target {
			continue
		}
		if then == nil {
			copied := *existing
			set.Watch, set.Kept, set.Then = &copied, true, existing.Then
			return set, nil
		}
		existing.Then = then
		e.watchesChanged()
		copied := *existing
		set.Watch = &copied
		return set, nil
	}
	if len(e.watches) >= WatchesMax {
		return set, ErrWatchLimit
	}
	watch := models.Watch{
		ID: newID("watch-"), Kind: request.Kind, Target: request.Target, Name: now.name,
		Time: e.now().UnixMilli(), Then: then,
	}
	e.watches = append(e.watches, watch)
	e.watchesChanged()
	set.Watch = &watch
	return set, nil
}

// CancelWatch stops a watch, and with it any instruction it carried. Call inside Do.
func (e *Engine) CancelWatch(id string) (models.Watch, error) {
	for index, watch := range e.watches {
		if watch.ID == id {
			e.watches = slices.Delete(slices.Clone(e.watches), index, index+1)
			e.watchesChanged()
			if watch.Then != nil {
				e.Log("You", models.LogSession, "Cancelled the wait on "+watch.Name+" and what comes next",
					"Cancelled", "")
			}
			return watch, nil
		}
	}
	return models.Watch{}, ErrNoWatch
}

// CancelWatchThen takes the instruction off a watch and keeps the watch, so you are still told
// when the work is done. Call inside Do.
func (e *Engine) CancelWatchThen(id string) (models.Watch, error) {
	for index := range e.watches {
		watch := &e.watches[index]
		if watch.ID != id {
			continue
		}
		if watch.Then != nil {
			e.Log("You", models.LogSession, "Cancelled “"+models.Clip(watch.Then.Text, 60)+"” for "+
				watch.Then.AgentName+" after "+watch.Name, "Cancelled", "")
		}
		watch.Then = nil
		e.watchesChanged()
		return *watch, nil
	}
	return models.Watch{}, ErrNoWatch
}

// watchesChanged stores the watches and tells every page. Call inside Do.
func (e *Engine) watchesChanged() {
	data, err := json.Marshal(e.watches)
	if err != nil {
		e.record(err)
		return
	}
	e.record(e.store.SetMeta(context.Background(), store.MetaWatches, string(data)))
	e.broadcast(models.ServerMessage{Type: models.MsgWatches, Watches: slices.Clone(e.watches)})
}

// loadWatches reads the stored watches. A damaged value is dropped, not fatal: a watch is a
// convenience, and nothing else depends on it.
func (e *Engine) loadWatches(ctx context.Context) error {
	e.watches = nil
	raw, err := e.store.Meta(ctx, store.MetaWatches)
	if err != nil || raw == "" {
		return err
	}
	if err := json.Unmarshal([]byte(raw), &e.watches); err != nil {
		slog.Warn("could not read the stored watches; starting with none", "error", err)
		e.watches = nil
	}
	return nil
}

// settleWatches clears watches whose agent or project has gone, and fires those whose work has
// ended. An instruction a watch sends can change an agent, so what changed is stored and
// broadcast before the next look. Each watch fires once, so this ends. Call inside Do, after flush.
func (e *Engine) settleWatches() {
	for round := 0; round < 4 && len(e.watches) > 0; round++ {
		changed := e.fireWatches()
		if !changed {
			return
		}
		e.flush()
	}
}

// fireWatches drops the watches whose subject is gone, fires the ones that are due, and reports
// whether anything changed. Call inside Do.
func (e *Engine) fireWatches() bool {
	var due []models.Watch
	var nows []watched
	kept := make([]models.Watch, 0, len(e.watches))
	for _, watch := range e.watches {
		now, ok := e.watchedNow(watch.Kind, watch.Target)
		switch {
		case !ok:
			// Gone with its agent or project, as the instruction it carried is: it is never given
			// to anyone else.
		case now.outcome != "":
			due = append(due, watch)
			nows = append(nows, now)
		default:
			kept = append(kept, watch)
		}
	}
	if len(due) == 0 && len(kept) == len(e.watches) {
		return false
	}
	e.watches = kept
	e.watchesChanged()
	for index, watch := range due {
		e.fire(watch, nows[index])
	}
	return true
}

// fire tells the person, and sends the instruction the watch carries if the work is done. It runs
// after the watch is out of the list, so it fires only once.
func (e *Engine) fire(watch models.Watch, now watched) {
	fired := models.WatchFired{Watch: watch.ID, Outcome: now.outcome}
	if watch.Kind == models.WatchAgent {
		fired.AgentID = watch.Target
	} else {
		fired.ProjectID, fired.AgentID = watch.Target, now.agent
	}
	name := now.name
	var text string
	switch {
	case watch.Kind == models.WatchAgent && now.outcome == models.WatchDone:
		text = name + " is done"
		if task := models.Clip(strings.TrimSpace(now.task), 80); task != "" {
			text += ": " + strings.TrimSuffix(task, ".")
		}
		text += "."
		fired.Notice = name + " is done"
	case watch.Kind == models.WatchAgent:
		text = name + " stopped with an error"
		if detail := models.Clip(strings.TrimSpace(now.detail), 100); detail != "" {
			text += ": " + strings.TrimSuffix(detail, ".")
		}
		text += "."
		fired.Notice = name + " stopped with an error"
	case now.outcome == models.WatchDone:
		text = name + " is done. Every agent on it has finished."
		fired.Notice = name + " is done"
	default:
		text = name + " has stopped."
		if now.detail != "" {
			text += " " + now.detail + " stopped with an error."
		}
		fired.Notice = name + " stopped with an error"
	}
	logLine := text
	outcome := "Told you"
	if watch.Then != nil {
		said, how := e.sendThen(watch, now)
		text += " " + said
		outcome += ". " + how
	}
	chip := ""
	if now.outcome == models.WatchDone {
		chip = "ok"
	}
	// One row for the whole thing. The instruction it sent has its own row, from the agent that
	// took it. An error is not red here: a watch is calm.
	e.Log("Mabari", models.LogSession, "Watch fired: "+strings.TrimSuffix(logLine, "."), outcome, chip)
	fired.Text = text
	e.broadcast(models.ServerMessage{Type: models.MsgWatchFired, Fired: &fired})
}

// sendThen passes the instruction on to the agent named when the watch was set, through the same
// path as any instruction from the person, and says what came of it, in a sentence for the
// person and in a few words for the log. After an error, or if that agent has gone, it is not
// sent, and never to anyone else. Call inside Do.
func (e *Engine) sendThen(watch models.Watch, now watched) (said, how string) {
	then := watch.Then
	quoted := "“" + models.Clip(then.Text, 80) + "”"
	if now.outcome != models.WatchDone {
		return "I didn't tell " + then.AgentName + " " + quoted + ".",
			"Not sent to " + then.AgentName + ": " + watch.Name + " hit an error."
	}
	target := e.Agent(then.AgentID)
	if target == nil || target.Leaving {
		return then.AgentName + " has left, so I didn't pass on " + quoted + ".",
			"Not sent to " + then.AgentName + ": it has left."
	}
	connector, ok := e.connectors[target.Source]
	if !ok {
		return then.AgentName + " couldn't take it, so I didn't pass on " + quoted + ".",
			"Not sent to " + then.AgentName + ": it couldn't take it."
	}
	connector.Instruct(target, then.Text)
	return "I told " + then.AgentName + " " + quoted + ".", "Sent to " + then.AgentName + "."
}
