// SPDX-License-Identifier: Apache-2.0

package events

import (
	"testing"

	"github.com/SamsonIdowu/mabari/internal/models"
)

func workflowAgent(id string, state models.AgentState) *models.LiveAgent {
	agent := &models.LiveAgent{Agent: models.Agent{ID: id, Name: id, Workflow: true, Bench: true, Desk: models.OffFloor}}
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
		// Seat 1 is the filler's, so the nearest free seat to the lead's (0) is below it, 2.
		if lead.Desk != 0 || helper.Desk != 2 {
			t.Errorf("lead %d, helper %d", lead.Desk, helper.Desk)
		}
	})
}
