// SPDX-License-Identifier: Apache-2.0

package models

import "testing"

func inState(state AgentState) *LiveAgent {
	a := &LiveAgent{}
	a.State = state
	return a
}

func TestOutcomeOfAnAgent(t *testing.T) {
	for state, want := range map[AgentState]WatchOutcome{
		StateDone: WatchDone, StateError: WatchFailed,
		StateThinking: "", StateEditing: "", StateApproval: "", StateIdle: "", StatePaused: "",
	} {
		if got := OutcomeOf(inState(state)); got != want {
			t.Errorf("%s: %q, want %q", state, got, want)
		}
	}
}

func TestProjectOutcome(t *testing.T) {
	asking := inState(StateThinking)
	asking.Question = &Question{}
	leaving := inState(StateEditing)
	leaving.Leaving = true
	cases := []struct {
		name    string
		project *Project
		agents  []*LiveAgent
		want    WatchOutcome
	}{
		{"nobody on it", &Project{}, nil, ""},
		{"only idle agents", &Project{}, []*LiveAgent{inState(StateIdle)}, ""},
		{"one done", &Project{}, []*LiveAgent{inState(StateDone)}, WatchDone},
		{"done beside idle", &Project{}, []*LiveAgent{inState(StateDone), inState(StateIdle)}, WatchDone},
		{"one still working", &Project{}, []*LiveAgent{inState(StateDone), inState(StateEditing)}, ""},
		{"one waiting on an approval", &Project{}, []*LiveAgent{inState(StateDone), inState(StateApproval)}, ""},
		{"one interrupted", &Project{}, []*LiveAgent{inState(StateDone), inState(StatePaused)}, ""},
		{"one asking a question", &Project{}, []*LiveAgent{inState(StateDone), asking}, ""},
		{"an error with the rest finished", &Project{}, []*LiveAgent{inState(StateDone), inState(StateError)}, WatchFailed},
		{"an error with work still going", &Project{}, []*LiveAgent{inState(StateError), inState(StateRunning)}, ""},
		{"a leaving agent holds nothing up", &Project{}, []*LiveAgent{inState(StateDone), leaving}, WatchDone},
		{"marked complete", &Project{Done: &ProjectDone{}}, []*LiveAgent{inState(StateEditing)}, WatchDone},
	}
	for _, tc := range cases {
		if got := ProjectOutcome(tc.project, tc.agents); got != tc.want {
			t.Errorf("%s: %q, want %q", tc.name, got, tc.want)
		}
	}
}
