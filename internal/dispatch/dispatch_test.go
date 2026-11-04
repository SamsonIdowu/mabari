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
