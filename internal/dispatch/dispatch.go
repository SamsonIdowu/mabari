// SPDX-License-Identifier: Apache-2.0

// Package dispatch chooses the best agent for a message. It lives only on the server, so the live
// hint in the command bar and the real decision can never disagree.
package dispatch

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// Decision is who a message should go to, and why in plain words.
type Decision struct {
	AgentID string `json:"agentId"`
	Name    string `json:"name"`
	Hue     string `json:"hue"`
	Reason  string `json:"reason"`
	// Fit is how well the message matches the agent itself: its name, its work and its files,
	// leaving out how busy it is. Zero means the agent was picked only for being free.
	Fit int `json:"-"`
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

// nameAt is where name stands as whole words in text, or -1: "worker" isn't named in "worker2".
func nameAt(text, name string) int {
	for from := 0; name != ""; {
		at := strings.Index(text[from:], name)
		if at < 0 {
			break
		}
		at += from
		before, _ := utf8.DecodeLastRuneInString(text[:at])
		after, _ := utf8.DecodeRuneInString(text[at+len(name):])
		if !wordRune(before) && !wordRune(after) {
			return at
		}
		from = at + 1
	}
	return -1
}

func wordRune(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }

// addressed is the agent the message names, or nil: the name that comes first, and of two that
// start in the same place, the longer, so "atlas scribe" isn't Atlas.
func addressed(text string, agents []*models.LiveAgent) *models.LiveAgent {
	var named *models.LiveAgent
	first := -1
	for _, agent := range agents {
		name := strings.ToLower(agent.Name)
		at := nameAt(text, name)
		if at < 0 {
			continue
		}
		if named == nil || at < first || (at == first && len(name) > len(named.Name)) {
			named, first = agent, at
		}
	}
	return named
}

func score(text string, agent *models.LiveAgent, named bool, queued int) (int, int, []string) {
	total := 0
	var why []string
	profile := strings.ToLower(agent.Task + " " + strings.Join(agent.Files, " "))
	if named {
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
	fit := total
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
	return total, fit, why
}

// Route returns the best agent, or nil if nobody can take the message. A message that names an
// agent goes to that agent or to nobody: it is never passed to someone else in its place.
func (Rules) Route(text string, agents []*models.LiveAgent) *Decision {
	lower := strings.ToLower(text)
	named := addressed(lower, agents)
	var best *models.LiveAgent
	var bestScore, bestFit int
	var bestWhy []string
	for _, agent := range agents {
		if agent.Leaving || agent.State == models.StateError || agent.State == models.StatePaused ||
			(named != nil && agent != named) {
			continue
		}
		total, fit, why := score(lower, agent, agent == named, len(agent.Queued))
		if best == nil || total > bestScore {
			best, bestScore, bestFit, bestWhy = agent, total, fit, why
		}
	}
	if best == nil {
		return nil
	}
	reason := "it has the lightest load right now"
	if len(bestWhy) > 0 {
		reason = strings.Join(bestWhy, " and ")
	}
	return &Decision{AgentID: best.ID, Name: best.Name, Hue: best.Hue, Reason: reason, Fit: bestFit}
}
