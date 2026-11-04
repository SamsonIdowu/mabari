// SPDX-License-Identifier: Apache-2.0

// Package dispatch chooses the best agent for a message. It lives only on the server, so the live
// hint in the command bar and the real decision can never disagree.
package dispatch

import (
	"regexp"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// Decision is who a message should go to, and why in plain words.
type Decision struct {
	AgentID string `json:"agentId"`
	Name    string `json:"name"`
	Hue     string `json:"hue"`
	Reason  string `json:"reason"`
}

// Router picks an agent for a message. Rules is the default, and a model based router can replace
// it once accounts exist.
type Router interface {
	Route(text string, agents []*models.LiveAgent) *Decision
}

type hint struct {
	message *regexp.Regexp
	keys    []string
}

var hints = []hint{
	{regexp.MustCompile(`test|spec|flaky|coverage|\bci\b`), []string{"test", "spec", "suite", "report"}},
	{regexp.MustCompile(`doc|readme|guide|changelog|install`), []string{"readme", "docs", "changelog"}},
	{regexp.MustCompile(`database|migrat|schema|staging|sql`), []string{"database", "migration", "schema", "staging"}},
	{regexp.MustCompile(`chart|librar|research|compare|look up|find out|source`), []string{"compare", "librar", "charting"}},
	{regexp.MustCompile(`invoice|billing|total|price|cents|money`), []string{"invoice", "billing", "totals"}},
	{regexp.MustCompile(`\bapi\b|endpoint|route|paginat`), []string{"api", "pagination", "routes"}},
	{regexp.MustCompile(`index|search|embedding`), []string{"index", "search"}},
	{regexp.MustCompile(`export|csv`), []string{"export"}},
}

var nonWord = regexp.MustCompile(`\W+`)

// Rules scores agents the way the prototype's dispatcher does.
type Rules struct{}

func onTopic(text, profile string) bool {
	for _, item := range hints {
		if !item.message.MatchString(text) {
			continue
		}
		for _, key := range item.keys {
			if strings.Contains(profile, key) {
				return true
			}
		}
	}
	return false
}

func score(text string, agent *models.LiveAgent, queued int) (int, []string) {
	total := 0
	var why []string
	profile := strings.ToLower(agent.Task + " " + strings.Join(agent.Files, " "))
	if text != "" && strings.Contains(text, strings.ToLower(agent.Name)) {
		total += 100
		why = append(why, "you named "+agent.Name)
	}
	if onTopic(text, profile) {
		total += 8
		why = append(why, "it is already working on “"+agent.Task+"”")
	}
	for _, word := range nonWord.Split(text, -1) {
		if len(word) > 4 && strings.Contains(profile, word) {
			total += 3
		}
	}
	switch {
	case agent.State == models.StateIdle || agent.State == models.StateDone:
		total += 4
		why = append(why, agent.Name+" is free right now")
	case agent.State == models.StateApproval:
		total -= 4
	case agent.State.Active():
		total--
	}
	total -= queued * 2
	if agent.Lead == nil {
		total++
	}
	return total, why
}

// Route returns the best agent, or nil if nobody can take the message.
func (Rules) Route(text string, agents []*models.LiveAgent) *Decision {
	lower := strings.ToLower(text)
	var best *models.LiveAgent
	var bestScore int
	var bestWhy []string
	for _, agent := range agents {
		if agent.Leaving || agent.State == models.StateError || agent.State == models.StatePaused {
			continue
		}
		total, why := score(lower, agent, len(agent.Queued))
		if best == nil || total > bestScore {
			best, bestScore, bestWhy = agent, total, why
		}
	}
	if best == nil {
		return nil
	}
	reason := "it has the lightest load right now"
	if len(bestWhy) > 0 {
		reason = strings.Join(bestWhy, " and ")
	}
	return &Decision{AgentID: best.ID, Name: best.Name, Hue: best.Hue, Reason: reason}
}
