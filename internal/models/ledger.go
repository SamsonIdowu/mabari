// SPDX-License-Identifier: Apache-2.0

package models

import "time"

// Ledger is one agent's day: how many tasks it finished and how long it worked since local
// midnight. Every connector's agents go through the same engine, so the engine keeps it from the
// states it sees, and the numbers mean the same for a demo agent, a Claude Code session and a hub
// app. It is stored with the agent's session, so a restart doesn't lose the day.
type Ledger struct {
	// Day is the local date the counts are for, such as "2026-11-06". A new day starts them again.
	Day string `json:"day"`
	// Finished is how many times the agent reached Done on Day.
	Finished int `json:"finished"`
	// WorkedMs is how long it was working on Day, as of Mark.
	WorkedMs int64 `json:"workedMs"`
	// Mark is when the ledger was last brought up to date, in Unix milliseconds. Zero means the
	// agent has not been seen yet.
	Mark int64 `json:"mark"`
	// State and Working are what the agent was doing at Mark. Time since then counts as work
	// while Working is true.
	State   AgentState `json:"state"`
	Working bool       `json:"working"`
}

// maxSilence is the longest stretch with no word from an agent that still counts as work. A
// session that was closed without telling anyone stays "working" in the office for a long time,
// and a card saying it worked all night would be false. A real silent stretch longer than this,
// such as one long build, is counted as this much.
const maxSilence = 30 * time.Minute

func dayOf(t time.Time) string { return t.Format("2006-01-02") }

// midnight is the start of t's local day.
func midnight(t time.Time) time.Time {
	year, month, day := t.Date()
	return time.Date(year, month, day, 0, 0, 0, 0, t.Location())
}

// workedSince is how much of the stretch from `from` to `now` counts as work: the stretch is cut
// at maxSilence, and only the part inside now's own day is kept.
func workedSince(from int64, now time.Time) int64 {
	end := min(now.UnixMilli(), from+maxSilence.Milliseconds())
	start := max(from, midnight(now).UnixMilli())
	return max(0, end-start)
}

// settle brings the counts up to now under what the agent was doing until now, starting a new
// day's counts when the day changed.
func (l *Ledger) settle(now time.Time) {
	if l.Day != dayOf(now) {
		l.Day, l.Finished, l.WorkedMs = dayOf(now), 0, 0
	}
	if l.Working {
		l.WorkedMs += workedSince(l.Mark, now)
	}
	l.Mark = now.UnixMilli()
}

// Advance records what the agent is doing now. It runs whenever the agent changes, and so sees
// every change of state: the time since the last change counts as work if the agent was working
// then, and reaching Done from any other state finishes a task. The first time an agent is seen
// only starts the ledger, because what it did before is unknown.
func (l *Ledger) Advance(now time.Time, state AgentState, working bool) {
	if l.Mark == 0 {
		*l = Ledger{Day: dayOf(now), Mark: now.UnixMilli(), State: state, Working: working}
		return
	}
	l.settle(now)
	if state == StateDone && l.State != StateDone {
		l.Finished++
	}
	l.State, l.Working = state, working
}

// Unwatched stops counting work from now until the agent is heard from again. The engine calls it
// when it starts: it wasn't watching while it was off, and the agent may have worked or stopped.
func (l *Ledger) Unwatched(now time.Time) {
	if l.Mark == 0 {
		return
	}
	l.settle(now)
	l.Working = false
}

// Today is what the agent did on the local day of `now`, counting the time since the last change
// if it is working now. The stored counts stay as they are.
func (l Ledger) Today(now time.Time) (finished int, workedMs int64) {
	if l.Mark == 0 {
		return 0, 0
	}
	if l.Day != dayOf(now) {
		// Nothing was recorded today yet, but an agent still working has been since midnight.
		if l.Working {
			return 0, workedSince(l.Mark, now)
		}
		return 0, 0
	}
	workedMs = l.WorkedMs
	if l.Working {
		workedMs += workedSince(l.Mark, now)
	}
	return l.Finished, workedMs
}
