// SPDX-License-Identifier: Apache-2.0

package models

import (
	"strconv"
	"strings"
	"time"
)

// AgentCard is what the card over an agent's name tag shows. Every number is worked out here, so
// the page only formats them.
type AgentCard struct {
	ID   string `json:"agentId"`
	Name string `json:"name"`
	// Role says what the agent is for, in a few words.
	Role string `json:"role"`
	// FinishedToday is how many tasks it finished since local midnight, and WorkedSeconds how long
	// it worked in that time.
	FinishedToday int   `json:"finishedToday"`
	WorkedSeconds int64 `json:"workedSeconds"`
	// Cost is the estimated spend so far. CostKnown is false when nothing is counted for this
	// agent, such as a hub app that reports no tokens, and the card then shows a dash and not
	// "$0.00". CostBasis is "estimate" for an API price estimate, or "plan" when the agent runs
	// on a subscription that isn't billed per token, so the number is only for comparing agents.
	Cost      float64 `json:"cost"`
	CostKnown bool    `json:"costKnown"`
	CostBasis string  `json:"costBasis"`
}

// roleLimit is the longest role the card shows, in characters.
const roleLimit = 56

// RoleOf says what an agent is for. A helper is its lead's; a lead says how big its team is; an
// agent made from an agent file says what that file says it is for; anything else is named after
// the AI behind it. lead is the agent's lead or nil, helpers is how many agents work for it, and
// def is the agent file it was made from or nil.
func RoleOf(a *LiveAgent, lead *LiveAgent, helpers int, def *AgentDef) string {
	switch {
	case lead != nil:
		return "Helper to " + lead.Name
	case def != nil && def.System:
		return "Office manager"
	case helpers > 0:
		return "Leads a team of " + strconv.Itoa(helpers+1)
	case def != nil && strings.TrimSpace(def.Description) != "":
		return firstSentence(def.Description, roleLimit)
	case a.Workflow:
		return AIName(a) + " session"
	default:
		return AIName(a) + " agent"
	}
}

// firstSentence is the text up to its first full stop or line, cut to at most limit characters
// with an ellipsis if it runs longer.
func firstSentence(text string, limit int) string {
	text = strings.TrimSpace(strings.SplitN(strings.TrimSpace(text), "\n", 2)[0])
	if cut := strings.Index(text, ". "); cut > 0 {
		text = text[:cut]
	}
	text = strings.TrimSuffix(text, ".")
	if runes := []rune(text); len(runes) > limit {
		return strings.TrimSpace(string(runes[:limit-1])) + "…"
	}
	return text
}

// CardFor works out an agent's card at `now`. See RoleOf for its arguments.
func CardFor(a *LiveAgent, lead *LiveAgent, helpers int, def *AgentDef, now time.Time) AgentCard {
	finished, worked := a.Ledger.Today(now)
	basis := "estimate"
	if a.Account == AccountCodex || a.Account == AccountClaudeCode {
		basis = "plan"
	}
	return AgentCard{
		ID:            a.ID,
		Name:          a.Name,
		Role:          RoleOf(a, lead, helpers, def),
		FinishedToday: finished,
		WorkedSeconds: worked / 1000,
		Cost:          CostOf(a.TokensIn, a.TokensOut, a.Model),
		CostKnown:     a.TokensIn+a.TokensOut > 0,
		CostBasis:     basis,
	}
}
