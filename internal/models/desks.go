// SPDX-License-Identifier: Apache-2.0

package models

const (
	// BaseGrid is how many desks a side the grid has before it grows, as in the prototype.
	BaseGrid = 4
	// MaxDesks caps the seats in each area, desks and benches, only to bound memory.
	MaxDesks = 96
	// BenchColumns is how many seats a row of benches has.
	BenchColumns = 4
	// BenchPitchX is the space between bench seats in a row, in world pixels.
	BenchPitchX = 160
	// BenchPitchY is the space between rows of benches, in world pixels.
	BenchPitchY = 112
)

// DeskTile is where a desk stands, in 32 pixel tiles from the office's corner.
//
// The office has two places to sit. The desk grid starts as the prototype's four by four, filled
// row by row, and grows a ring at a time: a column on the right, top to bottom, then a row below,
// left to right. So a desk never moves once it has an index. Workflow sub-agents sit at benches
// in their own area (BenchSeat), and Desk counts those seats for them. web/src/office/layout.ts
// mirrors these functions, and tests on both sides pin the same positions so they can't drift.
func DeskTile(index int) (x, y int) {
	column, row := index%BaseGrid, index/BaseGrid
	if index >= BaseGrid*BaseGrid {
		side := BaseGrid
		for (side+1)*(side+1) <= index {
			side++
		}
		step := index - side*side
		if step <= side {
			column, row = side, step
		} else {
			column, row = step-side-1, side
		}
	}
	return 8 + column*5, 4 + row*4
}

// GridSide is how many desks a side the grid needs to hold this many desks: at least BaseGrid.
func GridSide(desks int) int {
	side := BaseGrid
	for side*side < desks {
		side++
	}
	return side
}

// BenchSeat is where a workflow bench seat's desk stands, in world pixels from the corner of the
// first seat.
func BenchSeat(index int) (x, y int) {
	return index % BenchColumns * BenchPitchX, index / BenchColumns * BenchPitchY
}

// FreeDesk picks a seat in one area: the benches when bench is true, otherwise the desk grid.
// With near at -1 it is the lowest free index, which keeps the floor compact. Otherwise it is the
// free seat closest to near, among the seats already on the floor if one is free, so a helper
// sits beside its lead without growing the floor. It returns -1 only when all MaxDesks are taken.
func FreeDesk(agents []*LiveAgent, bench bool, near int) int {
	used := map[int]bool{}
	highest := -1
	for _, agent := range agents {
		if agent.Bench == bench {
			used[agent.Desk] = true
			highest = max(highest, agent.Desk)
		}
	}
	if near < 0 {
		for desk := range MaxDesks {
			if !used[desk] {
				return desk
			}
		}
		return -1
	}
	place := func(index int) (int, int) {
		if bench {
			return BenchSeat(index)
		}
		return DeskTile(index)
	}
	nearX, nearY := place(near)
	limit := floorSeats(max(highest, near)+1, bench)
	for {
		best, bestDistance := -1, 0
		for desk := range min(limit, MaxDesks) {
			if used[desk] {
				continue
			}
			x, y := place(desk)
			distance := abs(x-nearX) + abs(y-nearY)
			if best < 0 || distance < bestDistance {
				best, bestDistance = desk, distance
			}
		}
		if best >= 0 || limit >= MaxDesks {
			return best
		}
		limit = floorSeats(limit+1, bench)
	}
}

// floorSeats is how many seats the floor shows when it holds this many: a whole grid, or whole
// rows of benches.
func floorSeats(seats int, bench bool) int {
	if bench {
		rows := max(1, (seats+BenchColumns-1)/BenchColumns)
		return rows * BenchColumns
	}
	side := GridSide(seats)
	return side * side
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}
