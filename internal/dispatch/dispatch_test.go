// SPDX-License-Identifier: Apache-2.0

package dispatch

import (
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/models"
)

func agent(name, task string, state models.AgentState, files ...string) *models.LiveAgent {
	a := &models.LiveAgent{}
	a.ID, a.Name, a.Task, a.State, a.Files = name, name, task, state, files
	return a
}

func office() []*models.LiveAgent {
	return []*models.LiveAgent{
		agent("Ledger", "Refactor invoice totals to use whole cents", models.StateEditing, "src/billing/totals.ts"),
		agent("Scout", "Compare three charting libraries", models.StateBrowsing, "docs/charting-notes.md"),
		agent("Atlas", "Prepare the staging database", models.StateApproval, "db/schema.prisma"),
		agent("Bolt", "Run the full test suite and report failures", models.StateRunning, "ci/report.json"),
		agent("Pixel", "Waiting for work", models.StateIdle),
		agent("Sage", "Add pagination to the orders API", models.StateThinking, "src/api/routes.ts"),
	}
}

func TestRoutesByMeaning(t *testing.T) {
	cases := map[string]string{
		"the tests are flaky, please look":     "Bolt",
		"fix the invoice rounding":             "Ledger",
		"which charting library is best":       "Scout",
		"the orders endpoint needs pagination": "Sage",
		"tidy the kitchen":                     "Pixel",
		"ask Sage to review the invoice":       "Sage",
	}
	for text, want := range cases {
		if got := (Rules{}).Route(text, office()); got == nil || got.Name != want {
			t.Errorf("%q went to %+v, want %s", text, got, want)
		}
	}
}

// A name is whole words. A longer name that starts with a shorter one is its own agent, whichever
// comes first in the office and however busy either is.
func TestANameIsMatchedWhole(t *testing.T) {
	agents := func() []*models.LiveAgent {
		return []*models.LiveAgent{
			agent("Worker", "Waiting", models.StateIdle),
			agent("Worker2", "Waiting", models.StateEditing),
			agent("Atlas", "Waiting", models.StateIdle),
			agent("Atlas scribe", "Waiting", models.StateEditing),
			agent("Atlas (demo)", "Waiting", models.StateEditing),
			agent("Björk", "Waiting", models.StateEditing),
			agent("Bolt", "Waiting", models.StateEditing),
		}
	}
	cases := map[string]string{
		"tell Worker2 to review the work":  "Worker2",
		"tell worker to review the work":   "Worker",
		"Worker2, please look":             "Worker2",
		"have Atlas scribe check it":       "Atlas scribe",
		"have atlas check it":              "Atlas",
		"Atlas (demo) can do it":           "Atlas (demo)",
		"bolt, are you there?":             "Bolt",
		"björk, look":                      "Björk",
		"Worker, look at what Worker2 did": "Worker",
	}
	for text, want := range cases {
		if got := (Rules{}).Route(text, agents()); got == nil || got.Name != want {
			t.Errorf("%q went to %+v, want %s", text, got, want)
		}
	}
	// A word that only contains a name doesn't name anyone.
	if got := (Rules{}).Route("the thunderbolted door", agents()); got == nil || got.Fit >= 100 {
		t.Errorf("got %+v", got)
	}
}

// With the agent it names unable to take it, a message stays unsent rather than reaching another.
func TestAMessageForAnAgentThatCannotTakeItGoesToNobody(t *testing.T) {
	agents := []*models.LiveAgent{agent("Worker", "Waiting", models.StateIdle), agent("Worker2", "Waiting", models.StatePaused)}
	if got := (Rules{}).Route("Worker2, please look", agents); got != nil {
		t.Errorf("got %+v", got)
	}
}

func TestExplainsTheDecision(t *testing.T) {
	cases := map[string]string{
		"Sage, please look": "you named Sage",
		"fix the invoice":   "it is already working on “Refactor invoice totals",
		"tidy the kitchen":  "Pixel is free right now",
	}
	for text, want := range cases {
		if got := (Rules{}).Route(text, office()); !strings.Contains(got.Reason, want) {
			t.Errorf("%q: reason = %q", text, got.Reason)
		}
	}
}

func TestSkipsAgentsThatCannotTakeWork(t *testing.T) {
	stopped := agent("Mori", "Index the docs", models.StateError)
	paused := agent("Rune", "Update the docs", models.StatePaused)
	leaving := agent("Pip", "Write docs", models.StateIdle)
	leaving.Leaving = true
	got := (Rules{}).Route("update the docs", []*models.LiveAgent{stopped, paused, leaving})
	if got != nil {
		t.Errorf("got %+v", got)
	}
}

func TestPrefersALeadOverItsSubagent(t *testing.T) {
	lead := agent("Lead", "Waiting", models.StateThinking)
	sub := agent("Sub", "Waiting", models.StateThinking)
	id := lead.ID
	sub.Lead = &id
	got := (Rules{}).Route("anything", []*models.LiveAgent{sub, lead})
	if got == nil || got.Name != "Lead" {
		t.Errorf("got %+v", got)
	}
}

func TestAvoidsAgentsWithAQueue(t *testing.T) {
	busy := agent("Busy", "Waiting", models.StateThinking)
	busy.Queued = []models.Instruction{{}, {}}
	free := agent("Free", "Waiting", models.StateThinking)
	got := (Rules{}).Route("anything", []*models.LiveAgent{busy, free})
	if got == nil || got.Name != "Free" {
		t.Errorf("got %+v", got)
	}
}

func TestFallsBackToLightestLoad(t *testing.T) {
	got := (Rules{}).Route("hmm", []*models.LiveAgent{agent("Only", "Thing", models.StateEditing)})
	if got == nil || got.Reason != "it has the lightest load right now" {
		t.Errorf("got %+v", got)
	}
}

func TestNobodyToAsk(t *testing.T) {
	if got := (Rules{}).Route("hello", nil); got != nil {
		t.Errorf("got %+v", got)
	}
}
