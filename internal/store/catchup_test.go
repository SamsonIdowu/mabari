// SPDX-License-Identifier: Apache-2.0

package store

import (
	"context"
	"strconv"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/models"
)

func TestLogCountIgnoresTheLimit(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	for i := range 7 {
		must(t, s.SaveLog(ctx, models.LogEntry{
			ID: strconv.Itoa(i), Time: int64(i + 1), Agent: "Sage", Type: models.LogSession, Outcome: "Finished",
		}))
	}
	must(t, s.SaveLog(ctx, models.LogEntry{ID: "other", Time: 3, Agent: "Sage", Type: models.LogQuery}))
	got, err := s.LogCount(ctx, LogQuery{Type: models.LogSession, Outcome: "Finished", Since: 3, Limit: 2})
	must(t, err)
	if got != 5 {
		t.Errorf("count = %d, want 5", got)
	}
}

func describe(changes []models.StateChange) string {
	var out []string
	for _, change := range changes {
		out = append(out, change.AgentID+":"+strconv.FormatInt(change.Time, 10)+":"+string(change.Phase))
	}
	return strings.Join(out, " ")
}

func TestStateChangesAreReadBackByTime(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	for _, change := range []models.StateChange{
		{AgentID: "a", Agent: "Atlas", Time: 10, Phase: models.PhaseWorking},
		{AgentID: "a", Agent: "Atlas", Time: 20, Phase: models.PhaseApproval},
		{AgentID: "a", Agent: "Atlas", Time: 30, Phase: models.PhaseWorking},
		{AgentID: "b", Agent: "Mori", Time: 15, Phase: models.PhaseError},
	} {
		must(t, s.AddStateChange(ctx, change))
	}
	within, err := s.StateChanges(ctx, 15, 30)
	must(t, err)
	if got := describe(within); got != "b:15:error a:20:approval" {
		t.Errorf("within = %s", got)
	}
	// What each agent was doing as 25 began: its last change before it.
	before, err := s.StateBefore(ctx, 25)
	must(t, err)
	if got := describe(before); got != "b:15:error a:20:approval" {
		t.Errorf("before = %s", got)
	}
	last, err := s.LastStateChanges(ctx)
	must(t, err)
	if len(last) != 2 || last["a"].Time != 30 || last["b"].Phase != models.PhaseError {
		t.Errorf("last = %+v", last)
	}
}

// Retention drops old changes, but never an agent's latest, which says what it is still doing.
func TestRetentionKeepsEachAgentsLatestStateChange(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	for _, change := range []models.StateChange{
		{AgentID: "a", Time: 1, Phase: models.PhaseWorking},
		{AgentID: "a", Time: 2, Phase: models.PhaseIdle},
		{AgentID: "b", Time: 3, Phase: models.PhaseWorking},
		{AgentID: "c", Time: 500, Phase: models.PhaseWorking},
	} {
		must(t, s.AddStateChange(ctx, change))
	}
	_, _, err := s.DeleteOlderThan(ctx, 100)
	must(t, err)
	left, err := s.StateChanges(ctx, 0, 1000)
	must(t, err)
	if got := describe(left); got != "a:2:idle b:3:working c:500:working" {
		t.Errorf("left = %s", got)
	}
}

func TestApprovalsAndInstructionsBetween(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	agent := "agent"
	for _, approval := range []models.Approval{
		{ID: "early", Agent: agent, Time: 5}, {ID: "in", Agent: agent, Time: 10}, {ID: "late", Agent: agent, Time: 20},
	} {
		must(t, s.SaveApproval(ctx, approval))
	}
	for _, instruction := range []models.Instruction{
		{ID: "sent", Agent: &agent, Time: 10, Status: models.InstructionDelivered},
		{ID: "back", Agent: &agent, Time: 11, Status: models.InstructionRemoved},
		{ID: "project", Time: 12, Status: models.InstructionWaiting},
	} {
		must(t, s.SaveInstruction(ctx, instruction))
	}
	approvals, err := s.ApprovalsBetween(ctx, 10, 20)
	must(t, err)
	if len(approvals) != 1 || approvals[0].ID != "in" {
		t.Errorf("approvals = %+v", approvals)
	}
	instructions, err := s.InstructionsBetween(ctx, 0, 100)
	must(t, err)
	if len(instructions) != 1 || instructions[0].ID != "sent" {
		t.Errorf("instructions = %+v", instructions)
	}
}
