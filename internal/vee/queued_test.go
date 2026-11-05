// SPDX-License-Identifier: Apache-2.0

package vee

import (
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// A message held for an agent that waits on you says so, not that it's "mid step" (FIRST-2).
func TestPassedSaysWhyAMessageWaits(t *testing.T) {
	agents := office()
	atlas, ledger := agents[0], agents[2]
	where := Where{InstructionID: "ins-1", Queued: true}

	got := Passed(atlas, where, agents, now).Text
	want := "Passed it to Atlas. Atlas is waiting for your approval, so it gets it once you decide. I'll tell you what it says."
	if got != want {
		t.Errorf("approval: got %q", got)
	}
	if strings.Contains(got, "mid step") {
		t.Errorf("an agent waiting on you isn't mid step: %q", got)
	}

	asking := agent("Quill", models.StateThinking)
	asking.Question = &models.Question{ID: "q-1"}
	if got := Passed(asking, where, agents, now).Text; !strings.Contains(got, "Quill is waiting for your answer, so it gets it once you've answered.") {
		t.Errorf("question: got %q", got)
	}

	if got := Passed(ledger, where, agents, now).Text; !strings.Contains(got, "It's mid step, so it gets it at its next checkpoint.") {
		t.Errorf("busy agent: got %q", got)
	}
}

func TestAMessageToAProjectSaysWhyItWaits(t *testing.T) {
	agents := office()
	project := &models.Project{ID: "shop", Name: "Shop"}
	sent := ProjectSent{Project: project, Agent: agents[0], Where: Where{InstructionID: "ins-1", Queued: true}}
	if got := SentToProject(sent, agents, now).Text; !strings.Contains(got, "Atlas is waiting for your approval, so it gets it once you decide.") {
		t.Errorf("got %q", got)
	}
}

// With nobody to take a task the reply says how to get an agent: Accounts when there is nobody at
// all (SETUP-9), and New agent when everyone is busy.
func TestNoAgentFreeSaysHowToStart(t *testing.T) {
	empty := Dispatched(nil, "", Where{}, nil, now).Text
	for _, want := range []string{"no agent free", "Accounts", "Claude Code", "ChatGPT", "New agent", "send this again"} {
		if !strings.Contains(empty, want) {
			t.Errorf("an empty office: %q lacks %q", empty, want)
		}
	}
	busy := Dispatched(nil, "", Where{}, office(), now).Text
	for _, want := range []string{"no agent free", "New agent", "send this again"} {
		if !strings.Contains(busy, want) {
			t.Errorf("a busy office: %q lacks %q", busy, want)
		}
	}
	if strings.Contains(busy, "Accounts") {
		t.Errorf("an office with agents is already connected: %q", busy)
	}
	if strings.Contains(empty, "Start one first") || strings.Contains(busy, "Start one first") {
		t.Error("the old reply, which didn't say how, is back")
	}
}
