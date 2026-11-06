// SPDX-License-Identifier: Apache-2.0

package models

// TimelineBlock is a stretch of time an agent spent in one shown phase. Open is true when the
// block runs up to now.
type TimelineBlock struct {
	Kind Phase `json:"kind"`
	From int64 `json:"from"`
	To   int64 `json:"to"`
	Open bool  `json:"open"`
}

// MarkerKind is what a marker on the timeline stands for.
type MarkerKind string

// Marker kinds.
const (
	MarkerApproval    MarkerKind = "approval"
	MarkerInstruction MarkerKind = "instruction"
)

// TimelineMarker is one approval asked for or instruction sent. Text says which, and Outcome how
// an approval went ("Allowed", "Denied", "Auto-allowed", "Waiting" or "Cancelled").
type TimelineMarker struct {
	Kind    MarkerKind `json:"kind"`
	Time    int64      `json:"time"`
	Text    string     `json:"text"`
	Outcome string     `json:"outcome"`
}

// TimelineLane is one agent's row.
type TimelineLane struct {
	AgentID string `json:"agentId"`
	Agent   string `json:"agent"`
	// Provider is empty once the agent has left the office. So is Present.
	Provider Provider         `json:"provider"`
	Present  bool             `json:"present"`
	Blocks   []TimelineBlock  `json:"blocks"`
	Markers  []TimelineMarker `json:"markers"`
}

// Timeline is one day of the office: a lane for each agent that did anything.
type Timeline struct {
	// Day is the date, such as 2026-11-06, in the computer's own time zone.
	Day string `json:"day"`
	// Start and End bound the day, and Now is the clock, all in Unix milliseconds. The line at
	// now is drawn only when it falls inside the day.
	Start int64          `json:"start"`
	End   int64          `json:"end"`
	Now   int64          `json:"now"`
	Lanes []TimelineLane `json:"lanes"`
}
