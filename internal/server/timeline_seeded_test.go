// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// A day of transitions is written to the store as the engine writes them, and read back through
// the route: every block, every mark, and who is still in the office.
func TestTimelineRouteDrawsSeededTransitions(t *testing.T) {
	o := newOffice(t)
	now := o.engine.Now()
	// Yesterday, so the test is the same at any time of day.
	yesterday := time.Date(now.Year(), now.Month(), now.Day()-1, 0, 0, 0, 0, now.Location())
	at := func(hour, minute int) int64 {
		return time.Date(yesterday.Year(), yesterday.Month(), yesterday.Day(), hour, minute, 0, 0, now.Location()).UnixMilli()
	}
	ctx := context.Background()
	store := o.engine.Store()
	for _, change := range []models.StateChange{
		{AgentID: "ag-1", Agent: "Atlas", Time: at(9, 0), Phase: models.PhaseWorking},
		{AgentID: "ag-1", Agent: "Atlas", Time: at(9, 30), Phase: models.PhaseApproval},
		{AgentID: "ag-1", Agent: "Atlas", Time: at(9, 50), Phase: models.PhaseWorking},
		{AgentID: "ag-1", Agent: "Atlas", Time: at(10, 30), Phase: models.PhaseDone},
		{AgentID: "ag-2", Agent: "Mori", Time: at(9, 15), Phase: models.PhaseWorking},
		{AgentID: "ag-2", Agent: "Mori", Time: at(9, 40), Phase: models.PhaseError},
		{AgentID: "ag-2", Agent: "Mori", Time: at(9, 55), Phase: models.PhaseOff},
		{AgentID: "ag-3", Agent: "Quill", Time: at(11, 0), Phase: models.PhaseQuestion},
		{AgentID: "ag-3", Agent: "Quill", Time: at(11, 20), Phase: models.PhaseIdle},
	} {
		if err := store.AddStateChange(ctx, change); err != nil {
			t.Fatal(err)
		}
	}
	allowed, by, agent := models.DecisionAllowed, models.DecidedByUser, "ag-1"
	if err := store.SaveApproval(ctx, models.Approval{
		ID: "ap-1", Agent: "ag-1", Type: models.ApprovalCommand, Time: at(9, 30), Decision: &allowed, DecidedBy: &by,
		Detail: models.ApprovalDetail{Cmd: "npm run db:migrate"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveInstruction(ctx, models.Instruction{
		ID: "in-1", Agent: &agent, Time: at(9, 10), Status: models.InstructionDelivered, Mode: models.ModeInstruct,
		Text: "Use the money helper, key sk-ant-api03-PLANTEDSECRETKEY123456",
	}); err != nil {
		t.Fatal(err)
	}

	response := o.do(t, http.MethodGet, "/api/timeline?day="+yesterday.Format("2006-01-02"), "")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d %s", response.Code, response.Body)
	}
	if strings.Contains(response.Body.String(), "PLANTEDSECRETKEY") {
		t.Errorf("the timeline shows a secret: %s", response.Body)
	}
	got := decode[models.Timeline](t, response)
	if got.Day != yesterday.Format("2006-01-02") || got.Start != yesterday.UnixMilli() {
		t.Errorf("day = %q from %d", got.Day, got.Start)
	}
	describe := func(lane models.TimelineLane) string {
		var out []string
		for _, block := range lane.Blocks {
			out = append(out, fmt.Sprintf("%s %d-%d open=%v", block.Kind, block.From, block.To, block.Open))
		}
		return strings.Join(out, "; ")
	}
	want := map[string]string{
		"Atlas": fmt.Sprintf("working %d-%d open=false; approval %d-%d open=false; working %d-%d open=false",
			at(9, 0), at(9, 30), at(9, 30), at(9, 50), at(9, 50), at(10, 30)),
		"Mori":  fmt.Sprintf("working %d-%d open=false; error %d-%d open=false", at(9, 15), at(9, 40), at(9, 40), at(9, 55)),
		"Quill": fmt.Sprintf("question %d-%d open=false", at(11, 0), at(11, 20)),
	}
	var order []string
	for _, lane := range got.Lanes {
		order = append(order, lane.Agent)
		if lane.Present {
			t.Errorf("%s is in the office, but nobody was added", lane.Agent)
		}
		if blocks := describe(lane); blocks != want[lane.Agent] {
			t.Errorf("%s's blocks:\n got  %s\n want %s", lane.Agent, blocks, want[lane.Agent])
		}
	}
	// In the order they first did anything.
	if strings.Join(order, ",") != "Atlas,Mori,Quill" {
		t.Errorf("lanes = %v", order)
	}
	atlas := got.Lanes[0]
	if len(atlas.Markers) != 2 ||
		atlas.Markers[0].Kind != models.MarkerInstruction || atlas.Markers[0].Time != at(9, 10) ||
		atlas.Markers[0].Outcome != "Delivered" || atlas.Markers[0].Text != "Use the money helper, key [redacted]" ||
		atlas.Markers[1].Kind != models.MarkerApproval || atlas.Markers[1].Time != at(9, 30) ||
		atlas.Markers[1].Outcome != "Allowed" || atlas.Markers[1].Text != "npm run db:migrate" {
		t.Errorf("Atlas's markers = %+v", atlas.Markers)
	}
	// The day before that has nothing, and the day after is today, which has not seen any of it.
	before := yesterday.AddDate(0, 0, -1).Format("2006-01-02")
	if empty := decode[models.Timeline](t, o.do(t, http.MethodGet, "/api/timeline?day="+before, "")); len(empty.Lanes) != 0 {
		t.Errorf("the day before has lanes: %+v", empty.Lanes)
	}
	// Today starts with what each agent was doing as it began: done, idle and off draw nothing.
	if today := decode[models.Timeline](t, o.do(t, http.MethodGet, "/api/timeline", "")); len(today.Lanes) != 0 {
		t.Errorf("today has lanes: %+v", today.Lanes)
	}
}
