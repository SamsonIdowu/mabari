// SPDX-License-Identifier: Apache-2.0

package models

// WatchKind says what a Watch waits on.
type WatchKind string

// Watch kinds.
const (
	// WatchAgent waits for one agent to be done.
	WatchAgent WatchKind = "agent"
	// WatchProject waits for every agent on a project to have finished.
	WatchProject WatchKind = "project"
)

// WatchOutcome is how the thing a watch waits on ended: done, or stopped by an error. The empty
// value means it has not ended.
type WatchOutcome string

// Watch outcomes.
const (
	WatchDone   WatchOutcome = "done"
	WatchFailed WatchOutcome = "error"
)

// Watch is "tell me when it's done": a one-shot kept by the server, so it outlives a page reload.
// It fires once, when its agent is done or stops with an error, or when every agent on its project
// has finished, and then clears itself. It also clears itself when its agent or project is gone.
type Watch struct {
	ID   string    `json:"id"`
	Kind WatchKind `json:"kind"`
	// Target is the id of the agent or project.
	Target string `json:"target"`
	// Name is what it was called when the watch was set, for a line about it once it has gone.
	Name string `json:"name"`
	Time int64  `json:"time"`
	// Then is an instruction for another agent, sent when the watch fires with the work done. It
	// is null for a plain watch. Never sent after an error.
	Then *WatchThen `json:"then"`
}

// WatchThen is the instruction a Watch carries: "when Ledger is done, tell Quill to review it".
// It names its agent by id, so if that agent leaves it is never sent to someone else.
type WatchThen struct {
	AgentID   string `json:"agentId"`
	AgentName string `json:"agentName"`
	Text      string `json:"text"`
}

// WatchFired tells the page a watch has just fired, once, with what to say in each place.
type WatchFired struct {
	Watch   string       `json:"watch"`
	Outcome WatchOutcome `json:"outcome"`
	// AgentID is the agent to open from a notification: the one watched, or on a project the one
	// that hit an error. It is empty for a project that finished with no error.
	AgentID   string `json:"agentId"`
	ProjectID string `json:"projectId"`
	// Text is the sentence for the toast and for Home's chat. It may name the task.
	Text string `json:"text"`
	// Notice is the short line for a desktop notification. It names the agent or project and
	// nothing else: no task, command, path or error text.
	Notice string `json:"notice"`
}

// OutcomeOf is how an agent's work has ended, or empty while it hasn't: done, or stopped by an
// error. An agent that is idle has not started anything yet, so it has not finished either.
func OutcomeOf(a *LiveAgent) WatchOutcome {
	switch a.State {
	case StateDone:
		return WatchDone
	case StateError:
		return WatchFailed
	default:
		return ""
	}
}

// ProjectOutcome is how a project's work has ended, or empty while it hasn't. A project has ended
// when it was marked complete, or when every agent on it has stopped: at least one of them done
// or stopped by an error, and the rest done, idle or stopped by an error. One working, waiting
// on you, interrupted or asking a question keeps it open. An error anywhere makes the outcome an
// error, once everyone has stopped.
func ProjectOutcome(project *Project, agents []*LiveAgent) WatchOutcome {
	if project.Done != nil {
		return WatchDone
	}
	finished, failed := false, false
	for _, a := range agents {
		if a.Leaving {
			continue
		}
		switch {
		case a.Asking():
			return ""
		case a.State == StateDone:
			finished = true
		case a.State == StateError:
			failed = true
		case a.State == StateIdle:
			// Nothing running, so it holds nothing up.
		default:
			return ""
		}
	}
	switch {
	case failed:
		return WatchFailed
	case finished:
		return WatchDone
	default:
		return ""
	}
}
