// SPDX-License-Identifier: Apache-2.0

package models

import (
	"math"
	"strings"
	"testing"
	"time"
)

func agent(name string, provider Provider, account AccountKind) *LiveAgent {
	a := &LiveAgent{Agent: Agent{ID: "id-" + name, Name: name, Provider: provider, Account: account}}
	return a
}

func TestAnAgentsRoleSaysWhatItIsFor(t *testing.T) {
	lead := agent("Atlas", ProviderClaude, AccountClaudeCode)
	helper := agent("Scribe", ProviderClaude, AccountClaudeCode)
	helper.Lead = &lead.ID
	reviewer := &AgentDef{Description: "Reviews a change for bugs and style. Use it after every edit."}
	long := &AgentDef{Description: strings.Repeat("word ", 40)}
	session := agent("Shop", ProviderClaude, AccountClaudeCode)
	session.Workflow = true
	for _, test := range []struct {
		name    string
		agent   *LiveAgent
		lead    *LiveAgent
		helpers int
		def     *AgentDef
		want    string
	}{
		{"a helper", helper, lead, 0, nil, "Helper to Atlas"},
		{"a lead", lead, nil, 2, nil, "Leads a team of 3"},
		{"from an agent file", agent("Quill", ProviderOpenAI, AccountCodex), nil, 0, reviewer, "Reviews a change for bugs and style"},
		{"Mabari", agent("Mabari", ProviderClaude, AccountClaudeCode), nil, 0, &AgentDef{System: true, Description: "x"}, "Office manager"},
		{"a session", session, nil, 0, nil, "Claude session"},
		{"a hub app", agent("Mori", ProviderCustom, AccountHub), nil, 0, nil, "Custom AI agent"},
		{"a codex agent", agent("Rune", ProviderOpenAI, AccountCodex), nil, 0, nil, "ChatGPT agent"},
	} {
		if got := RoleOf(test.agent, test.lead, test.helpers, test.def); got != test.want {
			t.Errorf("%s: role = %q, want %q", test.name, got, test.want)
		}
	}
	got := RoleOf(agent("Quill", ProviderOpenAI, AccountCodex), nil, 0, long)
	if n := len([]rune(got)); n > roleLimit || !strings.HasSuffix(got, "…") {
		t.Errorf("a long description gave %q (%d characters)", got, n)
	}
}

// The card's numbers are the ledger's and the agent's own, worked out here.
func TestACardHasTheNumbersFromTheLedger(t *testing.T) {
	a := agent("Atlas", ProviderClaude, AccountAnthropicKey)
	a.Model = "claude-sonnet-4-5"
	a.TokensIn, a.TokensOut = 80000, 20000
	a.Ledger.Advance(at(9, 0, 0), StateIdle, false)
	a.Ledger.Advance(at(9, 0, 0).Add(time.Minute), StateEditing, true)
	a.Ledger.Advance(at(9, 0, 0).Add(21*time.Minute), StateDone, false)
	card := CardFor(a, nil, 0, nil, at(9, 30, 0))
	if card.FinishedToday != 1 || card.WorkedSeconds != 20*60 {
		t.Errorf("finished %d, worked %d s", card.FinishedToday, card.WorkedSeconds)
	}
	if math.Abs(card.Cost-0.9) > 1e-9 || !card.CostKnown || card.CostBasis != "estimate" {
		t.Errorf("cost %v known %v basis %q", card.Cost, card.CostKnown, card.CostBasis)
	}
	// A plan isn't billed per token, so its number is an estimate for comparing; an agent that
	// reports no tokens has no cost to show, rather than $0.00.
	plan := agent("Rune", ProviderOpenAI, AccountCodex)
	if got := CardFor(plan, nil, 0, nil, at(9, 30, 0)); got.CostBasis != "plan" || got.CostKnown {
		t.Errorf("plan card %+v", got)
	}
}
