// SPDX-License-Identifier: Apache-2.0

package events

import (
	"context"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

func workflowAgent(id string, state models.AgentState) *models.LiveAgent {
	agent := &models.LiveAgent{Agent: models.Agent{ID: id, Name: id, Workflow: true, Desk: models.OffFloor}}
	agent.State = state
	return agent
}

// The benches show exactly the workflow sub-agents on duty: a seat is taken when one starts
// working and given up when it stops, and a freed seat is used again.
func TestWorkflowSubAgentsSitOnlyWhileOnDuty(t *testing.T) {
	engine := newEngine(t)
	one := workflowAgent("one", models.StateEditing)
	two := workflowAgent("two", models.StateIdle)
	three := workflowAgent("three", models.StateApproval)
	_ = engine.Do(func() {
		engine.AddAgent(one)
		engine.AddAgent(two)
		engine.AddAgent(three)
	})
	desks := func() [3]int {
		var got [3]int
		_ = engine.Do(func() { got = [3]int{one.Desk, two.Desk, three.Desk} })
		return got
	}
	// Waiting on you for an approval still counts: it needs a click on the floor.
	if got := desks(); got != [3]int{0, models.OffFloor, 1} {
		t.Fatalf("desks = %v", got)
	}
	_ = engine.Do(func() {
		one.State = models.StateDone
		engine.Touch(one)
	})
	if got := desks(); got != [3]int{models.OffFloor, models.OffFloor, 1} {
		t.Fatalf("after one finished: %v", got)
	}
	_ = engine.Do(func() {
		two.State = models.StateThinking
		engine.Touch(two)
	})
	if got := desks(); got != [3]int{models.OffFloor, 0, 1} {
		t.Fatalf("after two started: %v", got)
	}
	// Paused agents leave too; agents from an agent file keep their desk whatever they do.
	desk := &models.LiveAgent{Agent: models.Agent{ID: "desk", Name: "desk", Desk: 3}}
	desk.State = models.StateIdle
	_ = engine.Do(func() {
		two.State = models.StatePaused
		engine.Touch(two)
		engine.AddAgent(desk)
	})
	if got := desks(); got[1] != models.OffFloor {
		t.Errorf("paused: %v", got)
	}
	_ = engine.Do(func() {
		if desk.Desk != 3 {
			t.Errorf("agent file's desk = %d", desk.Desk)
		}
	})
}

// A workflow subagent that starts working sits beside its lead when the lead is at work too.
func TestAWorkflowHelperSitsBesideItsLead(t *testing.T) {
	engine := newEngine(t)
	lead := workflowAgent("lead", models.StateEditing)
	filler := workflowAgent("filler", models.StateEditing)
	helper := workflowAgent("helper", models.StateIdle)
	helper.Lead = &lead.ID
	_ = engine.Do(func() {
		engine.AddAgent(lead)
		engine.AddAgent(filler)
		engine.AddAgent(helper)
	})
	_ = engine.Do(func() {
		helper.State = models.StateReading
		engine.Touch(helper)
	})
	_ = engine.Do(func() {
		// Desk 1 is the filler's, so the nearest free desk to the lead's (0) is below it, 4.
		if lead.Desk != 0 || helper.Desk != 4 {
			t.Errorf("lead %d, helper %d", lead.Desk, helper.Desk)
		}
	})
}

func clockedEngine(t *testing.T, now *time.Time) *Engine {
	t.Helper()
	s, err := store.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	engine, err := New(context.Background(), s, func() time.Time { return *now })
	if err != nil {
		t.Fatal(err)
	}
	return engine
}

// Subagents are ephemeral: a dismissed one walks out, then is gone, and one nothing has been
// heard from in a long time is dismissed, unless it waits on an approval.
func TestSubagentsLeaveTheOffice(t *testing.T) {
	now := time.UnixMilli(1_000_000)
	engine := clockedEngine(t, &now)
	lead := &models.LiveAgent{Agent: models.Agent{ID: "lead", Name: "lead", Desk: 0}}
	done := &models.LiveAgent{Agent: models.Agent{ID: "done", Name: "done", Desk: 1, Lead: &lead.ID}}
	quiet := &models.LiveAgent{Agent: models.Agent{ID: "quiet", Name: "quiet", Desk: 2, Lead: &lead.ID}}
	asking := &models.LiveAgent{Agent: models.Agent{ID: "asking", Name: "asking", Desk: 3, Lead: &lead.ID}}
	done.State, quiet.State, asking.State = models.StateDone, models.StateThinking, models.StateApproval
	for _, agent := range []*models.LiveAgent{lead, done, quiet, asking} {
		agent.CreatedAt = now.UnixMilli()
	}
	_ = engine.Do(func() {
		for _, agent := range []*models.LiveAgent{lead, done, quiet, asking} {
			engine.AddAgent(agent)
		}
		engine.Dismiss(done, 1000)
	})
	ids := func() []string {
		var got []string
		_ = engine.Do(func() {
			for _, agent := range engine.Agents() {
				got = append(got, agent.ID)
			}
		})
		return got
	}
	step := func(ms int64) {
		now = now.Add(time.Duration(ms) * time.Millisecond)
		_ = engine.Do(engine.Sweep)
	}
	step(1000)
	_ = engine.Do(func() {
		if !done.Leaving {
			t.Error("the finished subagent didn't start walking out")
		}
	})
	step(models.WalkOut)
	if got := ids(); len(got) != 3 || got[1] != "quiet" {
		t.Fatalf("after the walk out: %v", got)
	}
	step(models.SubagentStale + 1)
	step(models.WalkOut)
	if got := ids(); len(got) != 2 || got[0] != "lead" || got[1] != "asking" {
		t.Errorf("after going quiet: %v", got)
	}
}
