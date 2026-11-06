// SPDX-License-Identifier: Apache-2.0

package models

// What an agent was doing, for the day's timeline and for noticing when work finishes. It is worked
// out from the agent's state and whether it is asking a question, and recorded every time it
// changes (see PhaseOf).

// Phase is what an agent was doing over a stretch of time.
type Phase string

// Phases. The first four are drawn as blocks on the timeline; the rest are gaps.
const (
	// PhaseWorking is any of the states in which the agent does work.
	PhaseWorking Phase = "working"
	// PhaseApproval is an agent paused until someone decides on an approval.
	PhaseApproval Phase = "approval"
	// PhaseQuestion is an agent waiting for the answer to a question it asked.
	PhaseQuestion Phase = "question"
	PhaseError    Phase = "error"
	PhaseIdle     Phase = "idle"
	PhaseDone     Phase = "done"
	PhasePaused   Phase = "paused"
	// PhaseOff is for a time Mabari knows nothing about the agent: it left the office, or Mabari
	// was not running.
	PhaseOff Phase = "off"
)

// PhaseOf is what the agent is doing now. A question comes first: an agent asking one waits on
// the person, whatever state it was in when it asked.
func PhaseOf(a *LiveAgent) Phase {
	switch {
	case a.Asking():
		return PhaseQuestion
	case a.State == StateApproval:
		return PhaseApproval
	case a.State == StateError:
		return PhaseError
	case a.State.Active():
		return PhaseWorking
	case a.State == StateDone:
		return PhaseDone
	case a.State == StatePaused:
		return PhasePaused
	default:
		return PhaseIdle
	}
}

// Shown reports whether the timeline draws a block for the phase.
func (p Phase) Shown() bool {
	switch p {
	case PhaseWorking, PhaseApproval, PhaseQuestion, PhaseError:
		return true
	default:
		return false
	}
}

// StateChange is the moment an agent's phase changed. Name is kept so an agent that has left the
// office is still named on the day's timeline.
type StateChange struct {
	AgentID string `json:"agentId"`
	Agent   string `json:"agent"`
	Time    int64  `json:"time"`
	Phase   Phase  `json:"phase"`
}
