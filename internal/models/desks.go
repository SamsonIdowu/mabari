// SPDX-License-Identifier: Apache-2.0

package models

const (
	// BaseGrid is how many desks a side the grid has before it grows, as in the prototype. The
	// grid keeps this many rows as it grows, so the office only ever gets wider.
	BaseGrid = 4
	// DeskX is the desk grid's first column, in 32 pixel tiles from the left wall.
	DeskX = 2
	// MaxDesks caps the desks, only to bound memory.
	MaxDesks = 96
)

// DeskTile is where a desk stands, in 32 pixel tiles from the office's corner.
//
// Every agent at work sits in one desk grid. It starts as the prototype's four by four, filled
// row by row, and then grows only to the right, a column of four desks at a time, top to bottom.
// It never grows down, so the office keeps the prototype's height and its agents keep their size.
// A desk never moves once it has an index. web/src/office/layout.ts mirrors these functions, and
// tests on both sides pin the same positions so they can't drift.
func DeskTile(index int) (x, y int) {
	column, row := index%BaseGrid, index/BaseGrid
	if index >= BaseGrid*BaseGrid {
		column, row = index/BaseGrid, index%BaseGrid
	}
	return DeskX + column*5, 4 + row*4
}

// GridColumns is how many columns of desks the grid needs to hold this many: at least BaseGrid.
func GridColumns(desks int) int {
	return max(BaseGrid, (desks+BaseGrid-1)/BaseGrid)
}

// FreeDesk picks a desk. With near at -1 it is the lowest free desk, which keeps the floor
// compact. Otherwise it is the free desk closest to near, among the desks already on the floor if
// one is free, so a helper sits beside its lead without growing the floor. Agents off the floor
// hold no desk. It returns -1 only when all MaxDesks are taken.
func FreeDesk(agents []*LiveAgent, near int) int {
	used := map[int]bool{}
	highest := -1
	for _, agent := range agents {
		if agent.Desk >= 0 {
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
	nearX, nearY := DeskTile(near)
	limit := GridColumns(max(highest, near)+1) * BaseGrid
	for {
		best, bestDistance := -1, 0
		for desk := range min(limit, MaxDesks) {
			if used[desk] {
				continue
			}
			x, y := DeskTile(desk)
			distance := abs(x-nearX) + abs(y-nearY)
			if best < 0 || distance < bestDistance {
				best, bestDistance = desk, distance
			}
		}
		if best >= 0 || limit >= MaxDesks {
			return best
		}
		limit = GridColumns(limit+1) * BaseGrid
	}
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}
