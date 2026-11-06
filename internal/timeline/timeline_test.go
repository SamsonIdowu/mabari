// SPDX-License-Identifier: Apache-2.0

package timeline

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

// The test day is 6 November, and the clock starts the evening before.
var midnight = time.Date(2026, time.November, 6, 0, 0, 0, 0, time.Local)

type office struct {
	t      *testing.T
	now    time.Time
	engine *events.Engine
}

func newOffice(t *testing.T) *office {
	t.Helper()
	o := &office{t: t, now: midnight.Add(-time.Hour)}
	s, err := store.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	o.engine, err = events.New(context.Background(), s, func() time.Time { return o.now })
	if err != nil {
		t.Fatal(err)
	}
	return o
}

// at moves the clock to a time of day on the test day, such as "09:30", or "-1:00" the evening before.
func (o *office) at(clock string) {
	var hours, minutes int
	if strings.HasPrefix(clock, "-") {
		_, _ = fmt.Sscanf(clock, "-%d:%d", &hours, &minutes)
		o.now = midnight.Add(-time.Duration(hours)*time.Hour - time.Duration(minutes)*time.Minute)
		return
	}
	_, _ = fmt.Sscanf(clock, "%d:%d", &hours, &minutes)
	o.now = midnight.Add(time.Duration(hours)*time.Hour + time.Duration(minutes)*time.Minute)
}

func (o *office) add(name string, state models.AgentState) *models.LiveAgent {
	agent := &models.LiveAgent{Agent: models.Agent{ID: "id-" + name, Name: name, Provider: models.ProviderClaude}}
	agent.State, agent.Task = state, "Task of "+name
	_ = o.engine.Do(func() { o.engine.AddAgent(agent) })
	return agent
}

func (o *office) do(work func()) { _ = o.engine.Do(work) }

func (o *office) set(agent *models.LiveAgent, state models.AgentState) {
	o.do(func() { agent.State = state; o.engine.Touch(agent) })
}

func (o *office) build(day time.Time) models.Timeline {
	o.t.Helper()
	var result models.Timeline
	var err error
	o.do(func() { result, err = Of(context.Background(), o.engine.Store(), o.engine.Agents(), day, o.now) })
	if err != nil {
		o.t.Fatal(err)
	}
	return result
}

// clock writes a Unix millisecond time as its time of day, so a failure is readable.
func clock(ms int64) string { return time.UnixMilli(ms).Format("15:04") }

func blocks(lane models.TimelineLane) string {
	var out []string
	for _, block := range lane.Blocks {
		text := string(block.Kind) + " " + clock(block.From) + "-" + clock(block.To)
		if block.Open {
			text += " open"
		}
		out = append(out, text)
	}
	return strings.Join(out, ", ")
}

func markers(lane models.TimelineLane) string {
	var out []string
	for _, marker := range lane.Markers {
		out = append(out, string(marker.Kind)+" "+clock(marker.Time)+" "+marker.Outcome+" "+marker.Text)
	}
	return strings.Join(out, " | ")
}

func laneOf(t *testing.T, timeline models.Timeline, name string) models.TimelineLane {
	t.Helper()
	for _, lane := range timeline.Lanes {
		if lane.Agent == name {
			return lane
		}
	}
	t.Fatalf("no lane for %s in %d lanes", name, len(timeline.Lanes))
	return models.TimelineLane{}
}

func check(t *testing.T, what, got, want string) {
	t.Helper()
	if got != want {
		t.Errorf("%s:\n got  %s\n want %s", what, got, want)
	}
}

// A day is seeded with transitions as the office writes them, and every block and marker is checked.
func TestADayOfTransitions(t *testing.T) {
	o := newOffice(t)

	// Rune was already at work when the day began, and Quill leaves the office mid-morning.
	rune_ := o.add("Rune", models.StateEditing)
	o.at("9:00")
	atlas := o.add("Atlas", models.StateReading)
	quill := o.add("Quill", models.StateThinking)
	helper := &models.LiveAgent{Agent: models.Agent{ID: "id-helper", Name: "Atlas scribe", Lead: &atlas.ID}}
	helper.State = models.StateEditing
	o.do(func() { o.engine.AddAgent(helper) })

	o.at("9:10")
	o.do(func() { o.engine.Delivered(atlas, "Use the money helper, key sk-ant-api03-abcdefghijkl") })
	mori := o.add("Mori", models.StateEditing)
	o.at("9:15")
	o.set(quill, models.StateEditing) // Still work: no new block.
	o.at("9:20")
	o.do(func() { o.engine.RemoveAgent(quill.ID) })
	o.do(func() { o.engine.Queue(atlas, "Also add a changelog entry") })
	o.at("9:30")
	var approvalID string
	o.do(func() {
		o.engine.RequestApproval(atlas, models.Approval{
			Type: models.ApprovalCommand, Detail: models.ApprovalDetail{Cmd: "npm run db:migrate"}, RiskLevel: models.RiskHigh,
		})
		approvalID = atlas.Approval.ID
	})
	o.at("9:40")
	o.do(func() { mori.State, mori.Error = models.StateError, "Lost the connection"; o.engine.Touch(mori) })
	o.at("9:45")
	o.set(rune_, models.StateIdle)
	o.at("9:50")
	o.do(func() { o.engine.Decide(approvalID, models.DecisionAllowed) })
	o.set(atlas, models.StateEditing)
	o.at("10:00")
	juno := o.add("Juno", models.StateEditing)
	o.at("10:10")
	o.do(func() {
		juno.Question = &models.Question{ID: "q", Items: []models.QuestionItem{{Question: "Which library?"}}}
		o.engine.Touch(juno)
	})
	o.at("10:25")
	o.do(func() { juno.Question = nil; o.engine.Touch(juno) })
	o.at("10:30")
	o.set(atlas, models.StateDone)
	o.at("11:00")

	day := o.build(midnight)
	check(t, "day", day.Day, "2026-11-06")
	if day.Start != midnight.UnixMilli() || day.End != midnight.AddDate(0, 0, 1).UnixMilli() || day.Now != o.now.UnixMilli() {
		t.Errorf("bounds = %d %d %d", day.Start, day.End, day.Now)
	}

	check(t, "Rune's blocks", blocks(laneOf(t, day, "Rune")), "working 00:00-09:45")
	check(t, "Atlas's blocks", blocks(laneOf(t, day, "Atlas")),
		"working 09:00-09:30, approval 09:30-09:50, working 09:50-10:30")
	check(t, "Atlas's markers", markers(laneOf(t, day, "Atlas")),
		"instruction 09:10 Delivered Use the money helper, key [redacted] | "+
			"instruction 09:20 Waiting for checkpoint Also add a changelog entry | "+
			"approval 09:30 Allowed npm run db:migrate")
	check(t, "Quill's blocks", blocks(laneOf(t, day, "Quill")), "working 09:00-09:20")
	check(t, "Mori's blocks", blocks(laneOf(t, day, "Mori")), "working 09:10-09:40, error 09:40-11:00 open")
	check(t, "Juno's blocks", blocks(laneOf(t, day, "Juno")),
		"working 10:00-10:10, question 10:10-10:25, working 10:25-11:00 open")

	// Who is still here to open, and the lane's provider.
	if lane := laneOf(t, day, "Atlas"); !lane.Present || lane.Provider != models.ProviderClaude || lane.AgentID != atlas.ID {
		t.Errorf("Atlas's lane = %+v", lane)
	}
	if lane := laneOf(t, day, "Quill"); lane.Present {
		t.Error("Quill left but its lane says it is here")
	}
	// A subagent is a helper inside its lead's task and has no lane of its own.
	for _, lane := range day.Lanes {
		if lane.Agent == "Atlas scribe" {
			t.Errorf("a subagent has a lane: %+v", lane)
		}
	}
	// Lanes run in the order the agents first did something, and ties go by name.
	var names []string
	for _, lane := range day.Lanes {
		names = append(names, lane.Agent)
	}
	check(t, "order", strings.Join(names, ","), "Rune,Atlas,Quill,Mori,Juno")
}

// The approvals' outcomes, as someone reading the timeline would want them told.
func TestApprovalMarkersSayHowTheyWentAndSecretsAreHidden(t *testing.T) {
	o := newOffice(t)
	o.at("8:00")
	atlas := o.add("Atlas", models.StateEditing)
	ask := func(cmd string, level models.RiskLevel) string {
		var id string
		o.do(func() {
			o.engine.RequestApproval(atlas, models.Approval{
				Type: models.ApprovalCommand, Detail: models.ApprovalDetail{Cmd: cmd}, RiskLevel: level,
			})
			if atlas.Approval != nil {
				id = atlas.Approval.ID
			}
		})
		return id
	}
	o.at("8:10")
	denied := ask("rm -rf ./tmp", models.RiskHigh)
	o.at("8:12")
	o.do(func() { o.engine.Decide(denied, models.DecisionDenied) })
	o.at("8:20")
	o.do(func() { o.engine.SetAutoApprove(true, "safe") })
	ask("git status", models.RiskLow)
	o.do(func() { o.engine.SetAutoApprove(false, "safe") })
	o.at("8:30")
	ask("curl -H 'Authorization: Bearer abcdefghijklmnop' https://example.com", models.RiskHigh)
	o.at("8:40")
	ask("make deploy", models.RiskHigh) // Replaces the last one, which is then cancelled.
	o.at("9:00")

	check(t, "markers", markers(laneOf(t, o.build(midnight), "Atlas")),
		"approval 08:10 Denied rm -rf ./tmp | "+
			"approval 08:20 Auto-allowed git status | "+
			"approval 08:30 Cancelled curl -H 'Authorization: Bearer [redacted]' https://example.com | "+
			"approval 08:40 Waiting make deploy")
}

// A past day ends at midnight, with nothing open, and a day that hasn't begun has nothing yet.
func TestOtherDays(t *testing.T) {
	o := newOffice(t)
	o.at("-3:00")
	atlas := o.add("Atlas", models.StateEditing)
	o.at("9:00")
	o.set(atlas, models.StateDone)
	o.at("12:00")

	yesterday := o.build(midnight.AddDate(0, 0, -1))
	check(t, "yesterday", blocks(laneOf(t, yesterday, "Atlas")), "working 21:00-00:00")
	if yesterday.Lanes[0].Blocks[0].Open {
		t.Error("a block that ended at midnight is open")
	}
	today := o.build(midnight)
	check(t, "today", blocks(laneOf(t, today, "Atlas")), "working 00:00-09:00")

	for _, day := range []time.Time{midnight.AddDate(0, 0, 1), midnight.AddDate(0, 0, -10)} {
		empty := o.build(day)
		if empty.Lanes == nil || len(empty.Lanes) != 0 {
			t.Errorf("%s has lanes: %+v", empty.Day, empty.Lanes)
		}
	}
}

// An agent that did nothing but rest has no lane.
func TestIdleAgentsHaveNoLane(t *testing.T) {
	o := newOffice(t)
	o.at("9:00")
	o.add("Pixel", models.StateIdle)
	atlas := o.add("Atlas", models.StateEditing)
	o.at("9:30")
	o.do(func() { o.engine.Touch(atlas) })
	day := o.build(midnight)
	if len(day.Lanes) != 1 || day.Lanes[0].Agent != "Atlas" {
		t.Fatalf("lanes = %+v", day.Lanes)
	}
	check(t, "Atlas", blocks(day.Lanes[0]), "working 09:00-09:30 open")
}

// A stretch Mabari wasn't running, recorded as "off", is a gap in the lane and not time worked.
func TestAGapIsNotTimeWorked(t *testing.T) {
	o := newOffice(t)
	ctx := context.Background()
	for _, change := range []struct {
		at    string
		phase models.Phase
	}{{"9:00", models.PhaseWorking}, {"9:20", models.PhaseOff}, {"10:00", models.PhaseApproval}, {"10:30", models.PhaseWorking}} {
		o.at(change.at)
		if err := o.engine.Store().AddStateChange(ctx, models.StateChange{
			AgentID: "gone", Agent: "Atlas", Time: o.now.UnixMilli(), Phase: change.phase,
		}); err != nil {
			t.Fatal(err)
		}
	}
	o.at("11:00")
	check(t, "Atlas", blocks(o.build(midnight).Lanes[0]),
		"working 09:00-09:20, approval 10:00-10:30, working 10:30-11:00 open")
}
