// SPDX-License-Identifier: Apache-2.0

package models

import (
	"testing"
	"time"
)

// These positions are pinned in web/src/office/layout.test.ts too, so the two can't drift.
func TestDeskTileKeepsThePrototypeGridThenGrowsToTheRight(t *testing.T) {
	cases := []struct{ index, x, y int }{
		{0, 2, 4}, {5, 7, 8}, {15, 17, 16},
		// A fifth column on the right, top to bottom, then a sixth.
		{16, 22, 4}, {19, 22, 16}, {20, 27, 4}, {23, 27, 16},
		{95, 117, 16},
	}
	for _, c := range cases {
		if x, y := DeskTile(c.index); x != c.x || y != c.y {
			t.Errorf("DeskTile(%d) = %d, %d, want %d, %d", c.index, x, y, c.x, c.y)
		}
	}
}

func TestEveryDeskHasItsOwnTileAndTheGridNeverGrowsDown(t *testing.T) {
	seen := map[[2]int]int{}
	for index := range MaxDesks {
		x, y := DeskTile(index)
		if other, ok := seen[[2]int{x, y}]; ok {
			t.Fatalf("desks %d and %d share tile %d, %d", other, index, x, y)
		}
		seen[[2]int{x, y}] = index
		columns := GridColumns(index + 1)
		if x > DeskX+(columns-1)*5 || y > 4+(BaseGrid-1)*4 {
			t.Errorf("desk %d at %d, %d is outside a grid of %d columns", index, x, y, columns)
		}
	}
}

func TestGridColumns(t *testing.T) {
	for desks, columns := range map[int]int{0: 4, 1: 4, 16: 4, 17: 5, 20: 5, 21: 6, 96: 24} {
		if got := GridColumns(desks); got != columns {
			t.Errorf("GridColumns(%d) = %d, want %d", desks, got, columns)
		}
	}
}

func seated(desks []int) []*LiveAgent {
	agents := make([]*LiveAgent, 0, len(desks))
	for _, desk := range desks {
		agent := &LiveAgent{}
		agent.Desk = desk
		agents = append(agents, agent)
	}
	return agents
}

func upTo(count int) []int {
	desks := make([]int, count)
	for index := range desks {
		desks[index] = index
	}
	return desks
}

func TestFreeDeskTakesTheLowestFreeDesk(t *testing.T) {
	if got := FreeDesk(nil, -1); got != 0 {
		t.Errorf("empty office = %d", got)
	}
	if got := FreeDesk(seated([]int{0, 1, 3}), -1); got != 2 {
		t.Errorf("gap = %d", got)
	}
}

func TestFreeDeskGrowsPastSixteen(t *testing.T) {
	agents := seated(upTo(16))
	if got := FreeDesk(agents, -1); got != 16 {
		t.Fatalf("seventeenth agent = %d, want 16", got)
	}
	agents = seated(upTo(40))
	if got := FreeDesk(agents, -1); got != 40 {
		t.Errorf("forty-first agent = %d, want 40", got)
	}
}

func TestFreeDeskStopsOnlyAtMaxDesks(t *testing.T) {
	if got := FreeDesk(seated(upTo(MaxDesks)), -1); got != -1 {
		t.Errorf("full office = %d", got)
	}
	if got := FreeDesk(seated(upTo(MaxDesks)), 3); got != -1 {
		t.Errorf("full office near a lead = %d", got)
	}
}

func TestAgentsOffTheFloorHoldNoDesk(t *testing.T) {
	agents := append(seated(upTo(2)), seated([]int{OffFloor, OffFloor})...)
	if got := FreeDesk(agents, -1); got != 2 {
		t.Errorf("desk = %d", got)
	}
}

func TestFreeDeskNearALead(t *testing.T) {
	// The nearest free desk on the floor: below desk 0.
	if got := FreeDesk(seated([]int{0, 1, 2}), 0); got != 4 {
		t.Errorf("near 0 = %d, want 4", got)
	}
	// With the grid full, the floor grows by a column, and the helper sits by its lead.
	if got := FreeDesk(seated(upTo(16)), 15); got != 19 {
		t.Errorf("near 15 in a full grid = %d, want 19", got)
	}
}

func TestRefreshMarksActiveAgentsWorkingWithoutARate(t *testing.T) {
	a := &LiveAgent{SessionState: SessionState{State: StateEditing}}
	a.Refresh(time.UnixMilli(0))
	if !a.Working || a.Estimate != nil {
		t.Fatalf("editing without a rate: working %v, estimate %+v", a.Working, a.Estimate)
	}
	for _, state := range []AgentState{StateIdle, StateDone, StateApproval, StateError, StatePaused} {
		a.State = state
		a.Refresh(time.UnixMilli(0))
		if a.Working {
			t.Errorf("%s counts as working", state)
		}
	}
}
