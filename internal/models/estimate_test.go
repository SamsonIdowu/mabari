// SPDX-License-Identifier: Apache-2.0

package models

import (
	"testing"
	"time"
)

var now = time.UnixMilli(1_000_000)

func TestEstimateForActiveAgent(t *testing.T) {
	got := EstimateFor(StateEditing, 0.5, 0.001, now)
	want := Estimate{SecondsLeft: 500, LowSeconds: 400, HighSeconds: 650, FinishAt: 1_500_000}
	if got == nil || *got != want {
		t.Errorf("EstimateFor() = %+v, want %+v", got, want)
	}
}

func TestEstimateForAgentsThatAreNotWorking(t *testing.T) {
	for _, state := range []AgentState{
		StateApproval, StateIdle, StateDone, StateError, StatePaused,
	} {
		if got := EstimateFor(state, 0.5, 0.001, now); got != nil {
			t.Errorf("%s: got %+v, want no estimate", state, got)
		}
	}
}

func TestEstimateWithNoPaceYet(t *testing.T) {
	if got := EstimateFor(StateThinking, 0.5, 0, now); got != nil {
		t.Errorf("got %+v, want no estimate", got)
	}
}

func TestEstimateNeverGoesNegative(t *testing.T) {
	got := EstimateFor(StateEditing, 1.5, 0.001, now)
	if got == nil || got.SecondsLeft != 0 || got.FinishAt != now.UnixMilli() {
		t.Errorf("got %+v", got)
	}
}

func TestLatestFinishUsesTheSlowestAgent(t *testing.T) {
	fast := EstimateFor(StateEditing, 0.9, 0.001, now)
	slow := EstimateFor(StateEditing, 0.1, 0.001, now)
	got := LatestFinish(fast, nil, slow)
	if got == nil || *got != *slow {
		t.Errorf("got %+v, want %+v", got, slow)
	}
}

func TestLatestFinishDoesNotChangeItsInputs(t *testing.T) {
	first := EstimateFor(StateEditing, 0.9, 0.001, now)
	before := *first
	LatestFinish(first, EstimateFor(StateEditing, 0.1, 0.001, now))
	if *first != before {
		t.Errorf("input changed to %+v", first)
	}
}

func TestLatestFinishWhenNobodyIsWorking(t *testing.T) {
	if got := LatestFinish(nil, nil); got != nil {
		t.Errorf("got %+v, want nil", got)
	}
}
