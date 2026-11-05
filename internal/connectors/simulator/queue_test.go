// SPDX-License-Identifier: Apache-2.0

package simulator

import (
	"context"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

func agentSnapshot(engine *events.Engine, name string) models.LiveAgent {
	for _, agent := range engine.Snapshot().Agents {
		if agent.Name == name {
			return agent
		}
	}
	return models.LiveAgent{}
}

func logRow(t *testing.T, engine *events.Engine, search string) models.LogEntry {
	t.Helper()
	rows, err := engine.Store().Log(context.Background(), store.LogQuery{Search: search})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) == 0 {
		t.Fatalf("no activity row mentions %q", search)
	}
	return rows[0]
}

// An agent paused on an approval can't read an instruction, so it is held, amber, and not
// answered. It is delivered and answered once the agent carries on (FIRST-2): after Allow, and
// after Deny too.
func TestAnInstructionWaitsForAnAgentThatWaitsOnYou(t *testing.T) {
	for _, decision := range []string{models.DecisionAllowed, models.DecisionDenied} {
		t.Run(decision, func(t *testing.T) {
			sim, engine, c, _ := setup(t, ":memory:", 1)
			if err := sim.LoadDemo(); err != nil {
				t.Fatal(err)
			}
			const text = "After the migration, also seed the test data"
			var approval string
			if err := engine.Do(func() {
				atlas := engine.AgentByName("Atlas")
				approval = atlas.Approval.ID
				sim.Instruct(atlas, text)
			}); err != nil {
				t.Fatal(err)
			}
			atlas := agentSnapshot(engine, "Atlas")
			if atlas.State != models.StateApproval || len(atlas.Queued) != 1 || len(atlas.Asked) != 0 {
				t.Fatalf("state %s, queued %+v, asked %+v", atlas.State, atlas.Queued, atlas.Asked)
			}
			if atlas.Reply != "" || atlas.BubbleKind == "reply" || atlas.Queued[0].Status != models.InstructionWaiting {
				t.Errorf("Atlas answered while it waited on you: reply %q, bubble %q, %+v", atlas.Reply, atlas.Bubble, atlas.Queued[0])
			}
			if row := logRow(t, engine, "seed the test data"); row.Outcome != "Waiting for checkpoint" || row.Chip != "amber" {
				t.Errorf("row = %+v", row)
			}
			// Seconds pass and nothing is delivered: it still waits on you.
			advance(t, sim, c, 5)
			if atlas = agentSnapshot(engine, "Atlas"); atlas.State != models.StateApproval || len(atlas.Queued) != 1 || len(atlas.Asked) != 0 {
				t.Fatalf("after 5 s: state %s, queued %d, asked %d", atlas.State, len(atlas.Queued), len(atlas.Asked))
			}

			if !decide(t, engine, approval, decision) {
				t.Fatal("the decision was refused")
			}
			atlas = agentSnapshot(engine, "Atlas")
			if atlas.State == models.StateApproval || len(atlas.Queued) != 0 || len(atlas.Asked) != 1 {
				t.Fatalf("after deciding: state %s, queued %d, asked %d", atlas.State, len(atlas.Queued), len(atlas.Asked))
			}
			asked := atlas.Asked[0]
			if asked.Text != text || asked.Status != models.InstructionDelivered ||
				asked.Reply != "Got it: After the migration, also seed the test data." || asked.RepliedAt == 0 {
				t.Errorf("asked = %+v", asked)
			}
			if row := logRow(t, engine, "seed the test data"); row.Outcome != "Replied" || row.Chip != "ok" {
				t.Errorf("row = %+v", row)
			}
		})
	}
}

// An agent asking you a question is waiting on you too: its instruction waits until you answer.
func TestAnInstructionWaitsForAnAgentWithAQuestion(t *testing.T) {
	sim, engine, _, _ := setup(t, ":memory:", 1)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	if err := engine.Do(func() {
		ledger := engine.AgentByName("Ledger")
		engine.Ask(ledger, models.Question{Items: []models.QuestionItem{{
			Question: "Which one?", Options: []models.QuestionOption{{Label: "A"}, {Label: "B"}},
		}}})
		sim.Instruct(ledger, "Also round the totals")
	}); err != nil {
		t.Fatal(err)
	}
	ledger := agentSnapshot(engine, "Ledger")
	if len(ledger.Queued) != 1 || len(ledger.Asked) != 0 || ledger.Reply != "" {
		t.Fatalf("queued %d, asked %d, reply %q", len(ledger.Queued), len(ledger.Asked), ledger.Reply)
	}
}

// A working agent still takes an instruction within a couple of seconds, as before, and an agent
// that isn't waiting on you hears it at once.
func TestInstructionsToAgentsNotWaitingOnYouAreUnchanged(t *testing.T) {
	sim, engine, c, _ := setup(t, ":memory:", 1)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	if err := engine.Do(func() {
		sim.Instruct(engine.AgentByName("Ledger"), "Also round the totals")
		sim.Instruct(engine.AgentByName("Scout"), "Add the pricing pages")
	}); err != nil {
		t.Fatal(err)
	}
	if got := agentSnapshot(engine, "Scout"); len(got.Queued) != 0 || got.Reply != "Got it. I'll add the pricing pages." {
		t.Errorf("Scout: queued %d, reply %q", len(got.Queued), got.Reply)
	}
	if got := agentSnapshot(engine, "Ledger"); len(got.Queued) != 1 {
		t.Fatalf("Ledger should be mid step: %+v", got.Queued)
	}
	advance(t, sim, c, 3)
	if got := agentSnapshot(engine, "Ledger"); len(got.Queued) != 0 || len(got.Asked) != 1 || got.Asked[0].Reply == "" {
		t.Errorf("Ledger after 3 s: queued %d, asked %+v", len(got.Queued), got.Asked)
	}
}

// Instructing an agent that has finished isn't answered early: it starts a new task, so the agent
// really leaves Done, and its reply is true.
func TestAnInstructionTakesADoneAgentOutOfDone(t *testing.T) {
	sim, engine, _, _ := setup(t, ":memory:", 1)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	if finished := agentSnapshot(engine, "Rune"); finished.State != models.StateDone {
		t.Fatalf("Rune is %s", finished.State)
	}
	if err := engine.Do(func() { sim.Instruct(engine.AgentByName("Rune"), "Add a section on uninstalling") }); err != nil {
		t.Fatal(err)
	}
	finished := agentSnapshot(engine, "Rune")
	if finished.State == models.StateDone || !finished.State.Active() || finished.Progress != 0 ||
		finished.Task != "Add a section on uninstalling" || finished.Estimate == nil {
		t.Errorf("Rune is %s on %q at %v", finished.State, finished.Task, finished.Progress)
	}
	if len(finished.Queued) != 0 || len(finished.Asked) != 1 || !strings.HasPrefix(finished.Asked[0].Reply, "Got it. I'll add a section") {
		t.Errorf("queued %d, asked %+v", len(finished.Queued), finished.Asked)
	}
}
