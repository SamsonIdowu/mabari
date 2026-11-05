// SPDX-License-Identifier: Apache-2.0

package models

import (
	"testing"
	"time"
)

// These positions are pinned in web/src/office/layout.test.ts too, so the two can't drift.
func TestDeskTileKeepsThePrototypeGridThenGrowsByRings(t *testing.T) {
	cases := []struct{ index, x, y int }{
		{0, 8, 4}, {5, 13, 8}, {15, 23, 16},
		// The fifth ring: a column on the right, then a row below.
		{16, 28, 4}, {20, 28, 20}, {21, 8, 20}, {24, 23, 20},
		// The sixth.
		{25, 33, 4}, {30, 33, 24}, {35, 28, 24},
		{95, 28, 40},
	}
	for _, c := range cases {
		if x, y := DeskTile(c.index); x != c.x || y != c.y {
			t.Errorf("DeskTile(%d) = %d, %d, want %d, %d", c.index, x, y, c.x, c.y)
		}
	}
}

func TestEveryDeskHasItsOwnTile(t *testing.T) {
	seen := map[[2]int]int{}
	for index := range MaxDesks {
		x, y := DeskTile(index)
		if other, ok := seen[[2]int{x, y}]; ok {
			t.Fatalf("desks %d and %d share tile %d, %d", other, index, x, y)
		}
		seen[[2]int{x, y}] = index
		side := GridSide(index + 1)
		if x > 8+(side-1)*5 || y > 4+(side-1)*4 {
			t.Errorf("desk %d at %d, %d is outside a grid of %d", index, x, y, side)
		}
	}
}

func TestGridSide(t *testing.T) {
	for desks, side := range map[int]int{0: 4, 1: 4, 16: 4, 17: 5, 25: 5, 26: 6, 96: 10} {
		if got := GridSide(desks); got != side {
			t.Errorf("GridSide(%d) = %d, want %d", desks, got, side)
		}
	}
}

func TestBenchSeat(t *testing.T) {
	cases := []struct{ index, x, y int }{{0, 0, 0}, {3, 432, 0}, {4, 0, 112}, {9, 144, 224}}
	for _, c := range cases {
		if x, y := BenchSeat(c.index); x != c.x || y != c.y {
			t.Errorf("BenchSeat(%d) = %d, %d, want %d, %d", c.index, x, y, c.x, c.y)
		}
	}
}

func seated(desks []int, bench bool) []*LiveAgent {
	agents := make([]*LiveAgent, 0, len(desks))
	for _, desk := range desks {
		agent := &LiveAgent{}
		agent.Desk, agent.Bench = desk, bench
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
	if got := FreeDesk(nil, false, -1); got != 0 {
		t.Errorf("empty office = %d", got)
	}
	if got := FreeDesk(seated([]int{0, 1, 3}, false), false, -1); got != 2 {
		t.Errorf("gap = %d", got)
	}
}

func TestFreeDeskGrowsPastSixteen(t *testing.T) {
	agents := seated(upTo(16), false)
	if got := FreeDesk(agents, false, -1); got != 16 {
		t.Fatalf("seventeenth agent = %d, want 16", got)
	}
	agents = seated(upTo(40), false)
	if got := FreeDesk(agents, false, -1); got != 40 {
		t.Errorf("forty-first agent = %d, want 40", got)
	}
}

func TestFreeDeskStopsOnlyAtMaxDesks(t *testing.T) {
	if got := FreeDesk(seated(upTo(MaxDesks), false), false, -1); got != -1 {
		t.Errorf("full office = %d", got)
	}
	if got := FreeDesk(seated(upTo(MaxDesks), false), false, 3); got != -1 {
		t.Errorf("full office near a lead = %d", got)
	}
}

func TestDesksAndBenchesAreSeparate(t *testing.T) {
	agents := append(seated(upTo(5), false), seated([]int{0, 1}, true)...)
	if got := FreeDesk(agents, false, -1); got != 5 {
		t.Errorf("desk = %d", got)
	}
	if got := FreeDesk(agents, true, -1); got != 2 {
		t.Errorf("bench = %d", got)
	}
}

func TestFreeDeskNearALead(t *testing.T) {
	// The nearest free desk on the floor: below desk 0.
	if got := FreeDesk(seated([]int{0, 1, 2}, false), false, 0); got != 4 {
		t.Errorf("near 0 = %d, want 4", got)
	}
	// With the grid full, the floor grows by a ring, and the helper sits by its lead.
	if got := FreeDesk(seated(upTo(16), false), false, 15); got != 24 {
		t.Errorf("near 15 in a full grid = %d, want 24", got)
	}
	// A bench helper sits beside its lead, then in the row below.
	if got := FreeDesk(seated([]int{0}, true), true, 0); got != 1 {
		t.Errorf("bench near 0 = %d, want 1", got)
	}
	if got := FreeDesk(seated(upTo(4), true), true, 2); got != 6 {
		t.Errorf("bench near 2 in a full row = %d, want 6", got)
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
