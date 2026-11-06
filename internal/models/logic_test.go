// SPDX-License-Identifier: Apache-2.0

package models

import (
	"math"
	"strings"
	"testing"
	"time"
)

func TestCostOf(t *testing.T) {
	if got := CostOf(800, 200, "claude-opus-4-1"); math.Abs(got-0.045) > 1e-9 {
		t.Errorf("CostOf = %v", got)
	}
	if got := CostOf(800, 200, "local"); got != 0 {
		t.Errorf("unknown model costs %v", got)
	}
}

func TestAck(t *testing.T) {
	cases := map[string]string{
		// An instruction that starts with a verb is promised back.
		"Sage, Also update the API docs.": "Got it. I'll also update the API docs.",
		"Fix the bug":                     "Got it. I'll fix the bug.",
		"Add the pricing pages":           "Got it. I'll add the pricing pages.",
		"  run   the tests\n":             "Got it. I'll run the tests.",
		"Please check the chart labels":   "Got it. I'll check the chart labels.",
		"also round the tax line":         "Got it. I'll also round the tax line.",
		// Anything else is echoed, so it can't come out as "I'll please check", "I'll after this
		// step" or "I'll we need tests".
		"please":                             "Got it: please.",
		"after this step, run the linter":    "Got it: after this step, run the linter.",
		"After the migration, also seed it.": "Got it: After the migration, also seed it.",
		"we need tests for csv":              "Got it: we need tests for csv.",
		"CSV export is wrong":                "Got it: CSV export is wrong.",
		"can you check the build?":           "Got it: can you check the build?",
		"/ux-audit https://x.io/a":           "Got it: /ux-audit https://x.io/a.",
		"":                                   "Got it.",
		// Too long to repeat back.
		"Use the money helper instead of toFixed and also rewrite every test":                     "Got it. I'll do that next.",
		"after the migration finishes, seed the test database and then run the whole suite again": "Got it. I'll do that next.",
		// Other languages are echoed, and characters that take more than one byte are kept whole
		// and counted once.
		"Écris le test":                  "Got it: Écris le test.",
		"修复登录问题":                         "Got it: 修复登录问题.",
		strings.Repeat("é", 40):          "Got it: " + strings.Repeat("é", 40) + ".",
		strings.Repeat("修", 60):          "Got it: " + strings.Repeat("修", 60) + ".",
		strings.Repeat("修", 61):          "Got it. I'll do that next.",
		"fix " + strings.Repeat("é", 56): "Got it. I'll fix " + strings.Repeat("é", 56) + ".",
		"fix " + strings.Repeat("é", 57): "Got it. I'll do that next.",
	}
	for in, want := range cases {
		if got := Ack(in); got != want {
			t.Errorf("Ack(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNeedsMe(t *testing.T) {
	for state := range StateLabels {
		want := state == StateApproval || state == StateError
		if state.NeedsMe() != want {
			t.Errorf("%s.NeedsMe() = %v", state, !want)
		}
	}
}

func TestRefreshBubbles(t *testing.T) {
	now := time.UnixMilli(5000)
	newAgent := func(state AgentState) *LiveAgent {
		return &LiveAgent{SessionState: SessionState{State: state, Rate: 0.001, Task: "Ship it"}}
	}

	a := newAgent(StateEditing)
	a.Feed = []Event{{Tool: "edit_file", Summary: "src/app.ts  +3 −1"}}
	a.Refresh(now)
	if a.Bubble != "Editing app.ts" || a.BubbleKind != "" {
		t.Errorf("bubble = %q, kind %q", a.Bubble, a.BubbleKind)
	}

	a.Talk, a.TalkUntil = "To Ledger: hi", 6000
	a.Refresh(now)
	if a.Bubble != "To Ledger: hi" || a.BubbleKind != "talk" {
		t.Errorf("talk bubble = %q, kind %q", a.Bubble, a.BubbleKind)
	}

	a.Reply, a.ReplyUntil = "Got it.", 6000
	a.Refresh(now)
	if a.Bubble != "Got it." || a.BubbleKind != "reply" {
		t.Errorf("reply bubble = %q, kind %q", a.Bubble, a.BubbleKind)
	}

	a.Reply, a.ReplyUntil, a.TalkUntil = "Old", 1, 1
	a.Refresh(now)
	if a.Bubble != "Editing app.ts" {
		t.Errorf("expired bubble = %q", a.Bubble)
	}

	done := newAgent(StateDone)
	done.Refresh(now)
	if done.Bubble != "Finished: Ship it" {
		t.Errorf("done bubble = %q", done.Bubble)
	}
}

func TestRefreshSetsEstimateOnlyWhileWorking(t *testing.T) {
	now := time.UnixMilli(0)
	a := &LiveAgent{SessionState: SessionState{State: StateEditing, Progress: 0.5, Rate: 0.001}}
	a.Refresh(now)
	if a.Estimate == nil || a.Estimate.SecondsLeft != 500 {
		t.Fatalf("working estimate = %+v", a.Estimate)
	}
	a.State = StateApproval
	a.Refresh(now)
	if a.Estimate != nil {
		t.Errorf("waiting estimate = %+v", a.Estimate)
	}
}

func TestProjectState(t *testing.T) {
	agent := func(state AgentState, progress float64) *LiveAgent {
		return &LiveAgent{SessionState: SessionState{State: state, Progress: progress}}
	}
	cases := []struct {
		name     string
		project  Project
		agents   []*LiveAgent
		status   ProjectStatus
		progress float64
	}{
		{"done", Project{Done: &ProjectDone{}}, nil, ProjectCompleted, 1},
		{"new", Project{}, nil, ProjectNew, 0},
		{"needs you beats active", Project{},
			[]*LiveAgent{agent(StateEditing, 0.5), agent(StateError, 0.5)}, ProjectNeeds, 0.5},
		{"active", Project{}, []*LiveAgent{agent(StateEditing, 0.25)}, ProjectActive, 0.25},
		{"all finished", Project{}, []*LiveAgent{agent(StateDone, 1)}, ProjectReady, 1},
		{"waiting skips unstarted agents", Project{},
			[]*LiveAgent{agent(StateIdle, 0), agent(StateIdle, 0.5)}, ProjectIdle, 0.5},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, progress := ProjectState(&tc.project, tc.agents)
			if status != tc.status || progress != tc.progress {
				t.Errorf("got %s %v, want %s %v", status, progress, tc.status, tc.progress)
			}
		})
	}
}

// Message colours match the prototype's CONV table, with no purple anywhere.
func TestMessageColoursMatchThePrototype(t *testing.T) {
	want := map[MessageKind]string{
		MessageHandoff: "#1DD1A1", MessageQuestion: "#48DBFB", MessageAnswer: "#4FB3FF",
		MessageReport: "#FF9F43", MessageReview: "#FF6B9A",
	}
	for kind, colour := range want {
		if MessageColors[kind] != colour {
			t.Errorf("%s = %s, want %s", kind, MessageColors[kind], colour)
		}
	}
}

// Every state that has a label for chips has a phrase for sentences, so Mabari never says
// "Atlas is needs approval" or "Mori is error".
func TestEveryStateHasAPhrase(t *testing.T) {
	for state, label := range StateLabels {
		phrase, ok := StatePhrases[state]
		if !ok || phrase == "" {
			t.Errorf("%s has no phrase", state)
			continue
		}
		if !strings.HasPrefix(phrase, "is ") && !strings.HasPrefix(phrase, "hit ") && !strings.HasPrefix(phrase, "was ") {
			t.Errorf("%s: %q doesn't read after a name", state, phrase)
		}
		if phrase == "is "+strings.ToLower(label) && (state == StateApproval || state == StateError) {
			t.Errorf("%s: %q is the chip label in a sentence", state, phrase)
		}
	}
	if len(StatePhrases) != len(StateLabels) {
		t.Errorf("%d phrases for %d labels", len(StatePhrases), len(StateLabels))
	}
	asking := &LiveAgent{SessionState: SessionState{State: StateThinking}, Question: &Question{ID: "q"}}
	if got := Doing(asking); got != "is asking you a question" {
		t.Errorf("an agent asking says %q", got)
	}
	if got := Doing(&LiveAgent{SessionState: SessionState{State: StateApproval}}); got != "is waiting for your approval" {
		t.Errorf("an agent waiting on approval says %q", got)
	}
	if got := Doing(&LiveAgent{SessionState: SessionState{State: StateError}}); got != "hit an error" {
		t.Errorf("an agent in error says %q", got)
	}
}

func TestForwardedTextMentionsNothing(t *testing.T) {
	const zero = "\u200b"
	for text, want := range map[string]string{
		"@/etc/passwd":         "@" + zero + "/etc/passwd",
		"read @~/.ssh/id_rsa":  "read @" + zero + "~/.ssh/id_rsa",
		`see @"my file.txt"`:   `see @` + zero + `"my file.txt"`,
		"(@a.md and @b.md)":    "(@" + zero + "a.md and @" + zero + "b.md)",
		"@@/etc/passwd":        "@@" + zero + "/etc/passwd",
		"me@example.com":       "me@" + zero + "example.com",
		"@@ -14,9 +14,14 @@":   "@@ -14,9 +14,14 @@",
		"no mention, a lone @": "no mention, a lone @",
		"@ at the start":       "@ at the start",
	} {
		if got := InertMentions(text); got != want {
			t.Errorf("%q = %q, want %q", text, got, want)
		}
	}
}
