// SPDX-License-Identifier: Apache-2.0

package models

// How the activity log words the three kinds of row a recap reads back, so what writes them and
// what reads them can't drift apart.
const (
	OutcomeFinished    = "Finished"
	PrefixFinished     = "Finished: "
	OutcomeError       = "Error"
	PrefixError        = "Stopped by an error: "
	OutcomeAutoAllowed = "Auto-allowed"
)

// RecapListed is the most items a recap lists under each heading. The rest are counted.
const RecapListed = 5

// RecapItem is one thing in a recap. AgentID is empty when the agent has left the office.
type RecapItem struct {
	AgentID string `json:"agentId"`
	Agent   string `json:"agent"`
	Hue     string `json:"hue"`
	// Text is what happened: the task finished, the command auto approved, the error.
	Text string `json:"text"`
	Time int64  `json:"time"`
}

// RecapGroup is everything of one kind in a recap: how many, and the newest few.
type RecapGroup struct {
	Count int         `json:"count"`
	Items []RecapItem `json:"items"`
}

// Recap is what happened while the person was away, worked out from the activity log and the
// office as they are. It has no spend: only each agent's running total is kept, not what it spent
// in any one period, so a figure for the period could not be true.
type Recap struct {
	// Since and Until are the period, in Unix milliseconds.
	Since int64 `json:"since"`
	Until int64 `json:"until"`
	// Finished are tasks agents finished, AutoApproved approvals decided by auto approve,
	// Errors agents that stopped with an error, and Needs what waits for the person now.
	Finished     RecapGroup `json:"finished"`
	AutoApproved RecapGroup `json:"autoApproved"`
	Errors       RecapGroup `json:"errors"`
	Needs        RecapGroup `json:"needs"`
	// Happened is true when something took place in the period. An approval, error or question
	// that was already waiting when the person left is listed under Needs but is not news.
	Happened bool `json:"happened"`
}
