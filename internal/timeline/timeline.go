// SPDX-License-Identifier: Apache-2.0

// Package timeline works out one day of the office for the Activity page: for each agent, when it
// worked, when it waited on the person and when it hit an error, with a marker for each approval
// and instruction. It reads what was recorded, never guesses, and the page only draws it.
package timeline

import (
	"cmp"
	"context"
	"slices"
	"strings"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/redact"
	"github.com/SamsonIdowu/mabari/internal/store"
)

// DayFormat is how a day is written: 2026-11-06.
const DayFormat = "2006-01-02"

// markerText is the most a marker's text says. The full text is on the agent's own panel.
const markerText = 120

// Of builds the timeline for the day that begins at start, in start's own time zone. now is the
// clock. agents are the office as it is, which says who is still here to open.
func Of(
	ctx context.Context, s *store.Store, agents []*models.LiveAgent, start, now time.Time,
) (models.Timeline, error) {
	end := start.AddDate(0, 0, 1)
	startMs, endMs, nowMs := start.UnixMilli(), end.UnixMilli(), now.UnixMilli()
	result := models.Timeline{Day: start.Format(DayFormat), Start: startMs, End: endMs, Now: nowMs, Lanes: []models.TimelineLane{}}
	// What is known stops at now, and a day that hasn't begun has nothing yet.
	horizon := min(nowMs, endMs)
	if horizon <= startMs {
		return result, nil
	}
	before, err := s.StateBefore(ctx, startMs)
	if err != nil {
		return result, err
	}
	within, err := s.StateChanges(ctx, startMs, endMs)
	if err != nil {
		return result, err
	}
	approvals, err := s.ApprovalsBetween(ctx, startMs, endMs)
	if err != nil {
		return result, err
	}
	instructions, err := s.InstructionsBetween(ctx, startMs, endMs)
	if err != nil {
		return result, err
	}

	live := map[string]*models.LiveAgent{}
	for _, agent := range agents {
		live[agent.ID] = agent
	}
	lanes := map[string]*models.TimelineLane{}
	var order []string
	lane := func(id, name string) *models.TimelineLane {
		if existing := lanes[id]; existing != nil {
			return existing
		}
		item := &models.TimelineLane{AgentID: id, Agent: name, Blocks: []models.TimelineBlock{}, Markers: []models.TimelineMarker{}}
		if agent := live[id]; agent != nil {
			item.Agent, item.Provider, item.Present = agent.Name, agent.Provider, !agent.Leaving
		}
		lanes[id] = item
		order = append(order, id)
		return item
	}

	// Each agent's changes in order, starting with what it was doing as the day began.
	changes := map[string][]models.StateChange{}
	var ids []string
	for _, change := range append(before, within...) {
		if _, ok := changes[change.AgentID]; !ok {
			ids = append(ids, change.AgentID)
		}
		changes[change.AgentID] = append(changes[change.AgentID], change)
	}
	for _, id := range ids {
		list := changes[id]
		slices.SortStableFunc(list, func(a, b models.StateChange) int { return cmp.Compare(a.Time, b.Time) })
		blocks := blocksOf(list, startMs, horizon, nowMs < endMs)
		if len(blocks) == 0 {
			continue
		}
		item := lane(id, list[len(list)-1].Agent)
		item.Blocks = blocks
	}

	for _, approval := range approvals {
		if marker, name, ok := approvalMarker(approval, live, changes); ok {
			item := lane(approval.Agent, name)
			item.Markers = append(item.Markers, marker)
		}
	}
	for _, instruction := range instructions {
		if instruction.Agent == nil {
			continue
		}
		id := *instruction.Agent
		if name, ok := knownName(id, live, changes); ok {
			item := lane(id, name)
			item.Markers = append(item.Markers, models.TimelineMarker{
				Kind: models.MarkerInstruction, Time: instruction.Time,
				Text: clip(instruction.Text), Outcome: instructionOutcome(instruction.Status),
			})
		}
	}

	// Lanes run in the order the agents first did something.
	first := func(item *models.TimelineLane) int64 {
		at := int64(1<<62 - 1)
		if len(item.Blocks) > 0 {
			at = item.Blocks[0].From
		}
		if len(item.Markers) > 0 {
			at = min(at, item.Markers[0].Time)
		}
		return at
	}
	for _, id := range order {
		item := lanes[id]
		slices.SortStableFunc(item.Markers, func(a, b models.TimelineMarker) int { return cmp.Compare(a.Time, b.Time) })
		result.Lanes = append(result.Lanes, *item)
	}
	slices.SortStableFunc(result.Lanes, func(a, b models.TimelineLane) int {
		return cmp.Or(cmp.Compare(first(&a), first(&b)), strings.Compare(strings.ToLower(a.Agent), strings.ToLower(b.Agent)))
	})
	return result, nil
}

// blocksOf turns one agent's changes into the blocks to draw, clipped to the day and to the
// horizon. A block runs until the next change, and the last runs to the horizon, which is now on
// a day that isn't over (live). Neighbouring blocks of the same kind are joined.
func blocksOf(list []models.StateChange, start, horizon int64, live bool) []models.TimelineBlock {
	blocks := []models.TimelineBlock{}
	for index, change := range list {
		from := max(change.Time, start)
		to := horizon
		last := index == len(list)-1
		if !last {
			to = min(list[index+1].Time, horizon)
		}
		if !change.Phase.Shown() || to <= from {
			continue
		}
		if n := len(blocks); n > 0 && blocks[n-1].Kind == change.Phase && blocks[n-1].To == from {
			blocks[n-1].To, blocks[n-1].Open = to, last && live
			continue
		}
		blocks = append(blocks, models.TimelineBlock{Kind: change.Phase, From: from, To: to, Open: last && live})
	}
	return blocks
}

// knownName finds an agent's name for a marker: from the office, or from what was recorded about
// it. An agent nothing is known of, or a subagent, gets no lane.
func knownName(id string, live map[string]*models.LiveAgent, changes map[string][]models.StateChange) (string, bool) {
	if agent := live[id]; agent != nil {
		return agent.Name, agent.Lead == nil
	}
	if list := changes[id]; len(list) > 0 {
		return list[len(list)-1].Agent, true
	}
	return "", false
}

func approvalMarker(
	approval models.Approval, live map[string]*models.LiveAgent, changes map[string][]models.StateChange,
) (models.TimelineMarker, string, bool) {
	name, ok := knownName(approval.Agent, live, changes)
	if !ok {
		return models.TimelineMarker{}, "", false
	}
	return models.TimelineMarker{
		Kind: models.MarkerApproval, Time: approval.Time,
		Text: clip(models.ApprovalSummary(&approval)), Outcome: approvalOutcome(approval),
	}, name, true
}

func approvalOutcome(approval models.Approval) string {
	switch {
	case approval.Decision == nil:
		return "Waiting"
	case *approval.Decision == models.DecisionCancelled:
		return "Cancelled"
	case *approval.Decision == models.DecisionDenied:
		return "Denied"
	case approval.DecidedBy != nil && *approval.DecidedBy == models.DecidedByAuto:
		return models.OutcomeAutoAllowed
	default:
		return "Allowed"
	}
}

func instructionOutcome(status models.InstructionStatus) string {
	switch status {
	case models.InstructionWaiting:
		return "Waiting for checkpoint"
	case models.InstructionAnswered:
		return "Answered"
	default:
		return "Delivered"
	}
}

// clip shortens text for a marker and hides anything that looks like a secret.
func clip(text string) string {
	return models.Clip(redact.Text(strings.Join(strings.Fields(text), " ")), markerText)
}
