// SPDX-License-Identifier: Apache-2.0

package models

import (
	"testing"
	"time"
)

// at is a time on 6 November 2026, local.
func at(hour, minute, second int) time.Time {
	return time.Date(2026, time.November, 6, hour, minute, second, 0, time.Local)
}

func today(t *testing.T, l Ledger, now time.Time) (int, time.Duration) {
	t.Helper()
	finished, worked := l.Today(now)
	return finished, time.Duration(worked) * time.Millisecond
}

// The first sighting only starts the ledger: what the agent did before is unknown, so an agent
// that is found already Done has not finished a task today.
func TestTheFirstSightingOfAnAgentCountsNothing(t *testing.T) {
	var l Ledger
	l.Advance(at(9, 0, 0), StateDone, false)
	if finished, worked := today(t, l, at(9, 0, 0)); finished != 0 || worked != 0 {
		t.Errorf("finished %d, worked %v", finished, worked)
	}
	l.Advance(at(9, 5, 0), StateDone, false)
	if finished, _ := today(t, l, at(9, 5, 0)); finished != 0 {
		t.Errorf("done to done finished %d", finished)
	}
}

// Reaching Done from any other state finishes a task, once, however many times it is reported.
func TestATaskFinishesWhenTheAgentReachesDone(t *testing.T) {
	var l Ledger
	l.Advance(at(9, 0, 0), StateIdle, false)
	l.Advance(at(9, 1, 0), StateEditing, true)
	l.Advance(at(9, 11, 0), StateDone, false)
	l.Advance(at(9, 12, 0), StateDone, false)
	l.Advance(at(9, 13, 0), StateDone, false)
	finished, worked := today(t, l, at(9, 14, 0))
	if finished != 1 || worked != 10*time.Minute {
		t.Errorf("finished %d, worked %v; want 1 and 10m", finished, worked)
	}
	// A second task counts too, and a stop on an error is not a finished task.
	l.Advance(at(10, 0, 0), StateThinking, true)
	l.Advance(at(10, 5, 0), StateError, false)
	l.Advance(at(10, 6, 0), StateRunning, true)
	l.Advance(at(10, 9, 0), StateDone, false)
	finished, worked = today(t, l, at(10, 30, 0))
	if finished != 2 || worked != 18*time.Minute {
		t.Errorf("finished %d, worked %v; want 2 and 18m", finished, worked)
	}
}

// Time spent waiting on you, or paused, is not time worked.
func TestWaitingAndPausedTimeIsNotWork(t *testing.T) {
	var l Ledger
	l.Advance(at(9, 0, 0), StateThinking, true)
	l.Advance(at(9, 4, 0), StateApproval, false)
	l.Advance(at(9, 20, 0), StateEditing, true)
	l.Advance(at(9, 22, 0), StatePaused, false)
	if _, worked := today(t, l, at(9, 40, 0)); worked != 6*time.Minute {
		t.Errorf("worked %v, want 6m", worked)
	}
}

// An agent working now counts the time since its last change, without the stored counts moving.
func TestAnAgentStillWorkingCountsUpToNow(t *testing.T) {
	var l Ledger
	l.Advance(at(9, 0, 0), StateEditing, true)
	if _, worked := today(t, l, at(9, 7, 30)); worked != 7*time.Minute+30*time.Second {
		t.Errorf("worked %v", worked)
	}
	if l.WorkedMs != 0 {
		t.Errorf("reading changed the stored time: %d", l.WorkedMs)
	}
}

// A silence longer than maxSilence counts as maxSilence, so a session closed without a word does
// not claim to have worked all night.
func TestALongSilenceIsCutAtTheLimit(t *testing.T) {
	var l Ledger
	l.Advance(at(9, 0, 0), StateThinking, true)
	if _, worked := today(t, l, at(15, 0, 0)); worked != maxSilence {
		t.Errorf("worked %v while silent, want %v", worked, maxSilence)
	}
	l.Advance(at(15, 0, 0), StateDone, false)
	if _, worked := today(t, l, at(15, 1, 0)); worked != maxSilence {
		t.Errorf("worked %v after, want %v", worked, maxSilence)
	}
}

// A new day starts the counts again, and an agent working across midnight keeps only its own
// day's share.
func TestANewDayStartsTheCountsAgain(t *testing.T) {
	var l Ledger
	l.Advance(at(22, 0, 0), StateIdle, false)
	l.Advance(at(22, 5, 0), StateEditing, true)
	l.Advance(at(22, 20, 0), StateDone, false)
	if finished, _ := today(t, l, at(23, 0, 0)); finished != 1 {
		t.Fatalf("finished %d tonight", finished)
	}
	tomorrow := at(23, 0, 0).Add(2 * time.Hour)
	if finished, worked := today(t, l, tomorrow); finished != 0 || worked != 0 {
		t.Errorf("the next morning: finished %d, worked %v", finished, worked)
	}
	// Working through midnight: 20 minutes before, 10 after, when it is heard from at 00:10.
	l.Advance(at(23, 40, 0), StateEditing, true)
	l.Advance(at(23, 40, 0).Add(30*time.Minute), StateDone, false)
	finished, worked := today(t, l, at(23, 40, 0).Add(time.Hour))
	if finished != 1 || worked != 10*time.Minute {
		t.Errorf("after midnight: finished %d, worked %v; want 1 and 10m", finished, worked)
	}
}

// Unwatched stops the count, because the office wasn't looking while it was off, and the next word
// from the agent starts it again.
func TestAnOfficeThatWasOffDoesNotCountTheGap(t *testing.T) {
	var l Ledger
	l.Advance(at(9, 0, 0), StateEditing, true)
	l.Unwatched(at(9, 10, 0))
	if _, worked := today(t, l, at(11, 0, 0)); worked != 10*time.Minute {
		t.Errorf("worked %v, want the 10 minutes seen", worked)
	}
	l.Advance(at(11, 0, 0), StateDone, false)
	if finished, _ := today(t, l, at(11, 0, 0)); finished != 1 {
		t.Errorf("finished %d", finished)
	}
	var unseen Ledger
	unseen.Unwatched(at(9, 0, 0))
	if unseen.Mark != 0 {
		t.Error("an agent never seen was marked")
	}
}
