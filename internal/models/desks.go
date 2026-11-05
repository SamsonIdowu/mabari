// SPDX-License-Identifier: Apache-2.0

package models

const (
	// BaseGrid is how many desks a side the grid has before it grows, as in the prototype. The
	// grid keeps this many rows as it grows, so the office only ever gets wider.
	BaseGrid = 4
	// MaxDesks caps the seats in each area, desks and benches, only to bound memory.
	MaxDesks = 96
	// BenchRows is how many rows of benches the workflow sub-agents' area has. It grows a
	// column of seats at a time, to the right.
	BenchRows = 4
	// BenchPitchX is the space between bench seats in a row, in world pixels.
	BenchPitchX = 160
	// BenchPitchY is the space between rows of benches, in world pixels: the desk grid's.
	BenchPitchY = 128
)

// DeskTile is where a desk stands, in 32 pixel tiles from the office's corner.
//
// The office has two places to sit. The desk grid starts as the prototype's four by four, filled
// row by row, and then grows only to the right, a column of four desks at a time, top to bottom.
// It never grows down, so the office keeps the prototype's height and its agents keep their size.
// A desk never moves once it has an index. Workflow sub-agents sit at benches in their own area
// (BenchSeat), and Desk counts those seats for them. web/src/office/layout.ts mirrors these
// functions, and tests on both sides pin the same positions so they can't drift.
func DeskTile(index int) (x, y int) {
	column, row := index%BaseGrid, index/BaseGrid
	if index >= BaseGrid*BaseGrid {
		column, row = index/BaseGrid, index%BaseGrid
	}
	return 8 + column*5, 4 + row*4
}

// GridColumns is how many columns of desks the grid needs to hold this many: at least BaseGrid.
func GridColumns(desks int) int {
	return max(BaseGrid, (desks+BaseGrid-1)/BaseGrid)
}

// BenchSeat is where a workflow bench seat's desk stands, in world pixels from the corner of the
// first seat. Seats fill a column top to bottom, then the next column to the right.
func BenchSeat(index int) (x, y int) {
	return index / BenchRows * BenchPitchX, index % BenchRows * BenchPitchY
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

// floorSeats is how many seats the floor shows when it holds this many: whole columns of desks
// or of benches.
func floorSeats(seats int, bench bool) int {
	if bench {
		return max(1, (seats+BenchRows-1)/BenchRows) * BenchRows
	}
	return GridColumns(seats) * BaseGrid
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}
