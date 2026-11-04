// SPDX-License-Identifier: Apache-2.0

package models

import (
	"maps"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Limits from the prototype.
const (
	DeskCount    = 16
	MaxSubagents = 3
	FeedLimit    = 40
)

// StateLabels are the words shown for each state.
var StateLabels = map[AgentState]string{
	StateThinking: "Thinking",
	StateReading:  "Reading files",
	StateEditing:  "Editing",
	StateRunning:  "Running tests",
	StateBrowsing: "Browsing",
	StateApproval: "Needs approval",
	StateSpawning: "Starting a subagent",
	StateIdle:     "Idle",
	StateDone:     "Done",
	StateError:    "Error",
	StatePaused:   "Interrupted",
}

// Models lists the demo office's models for each account kind.
var Models = map[AccountKind][]string{
	AccountCodex:        {"gpt-5-codex", "gpt-5", "gpt-5-mini"},
	AccountClaudeCode:   {"claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5"},
	AccountAnthropicKey: {"claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5"},
	AccountOpenAIKey:    {"gpt-5", "gpt-5-mini", "gpt-4.1"},
	AccountHub:          {"any model your app reports"},
}

// AccountKinds is every kind, in the order the Accounts page lists them.
var AccountKinds = []AccountKind{
	AccountCodex, AccountClaudeCode, AccountAnthropicKey, AccountOpenAIKey, AccountHub,
}

// prices are dollars per 1,000 tokens, for the demo office's cost counters.
var prices = map[string]float64{
	"claude-opus-4-1":   0.045,
	"claude-sonnet-4-5": 0.009,
	"claude-haiku-4-5":  0.002,
	"gpt-5":             0.006,
	"gpt-5-codex":       0.006,
	"gpt-5-mini":        0.0012,
	"gpt-4.1":           0.005,
}

// MessageColors are the colours of each message kind.
var MessageColors = map[MessageKind]string{
	MessageHandoff:   "#1DD1A1",
	MessageQuestion:  "#48DBFB",
	MessageAnswer:    "#B794F6",
	MessageReport:    "#FF9F43",
	MessageReview:    "#FF6B9A",
	MessageBroadcast: "#C8B6FF",
}

// Clone copies the settings with their own Defaults map, so a copy can change without touching the
// original.
func (s Settings) Clone() Settings {
	s.Defaults = maps.Clone(s.Defaults)
	return s
}

// DefaultSettings are the settings before the user changes anything.
func DefaultSettings() Settings {
	return Settings{
		QueryModel:      "gpt-5-mini",
		VoiceEngine:     "browser",
		CompletionSound: true,
		RetentionDays:   30,
		Defaults: map[string]string{
			"claude":    "claude-sonnet-4-5",
			"codex":     "gpt-5-codex",
			"anthropic": "claude-sonnet-4-5",
			"openai":    "gpt-5",
		},
		AutoApprove: AutoApprove{Scope: "safe"},
	}
}

// NeedsMe reports whether the state asks for the user's attention.
func (s AgentState) NeedsMe() bool { return s == StateApproval || s == StateError }

// CostOf prices tokens by model. Unknown models cost nothing.
func CostOf(tokensIn, tokensOut int64, model string) float64 {
	return float64(tokensIn+tokensOut) / 1000 * prices[model]
}

// Refresh recomputes the session's derived fields: cost, estimate and speech bubble.
func (a *LiveAgent) Refresh(now time.Time) {
	a.Cost = CostOf(a.TokensIn, a.TokensOut, a.Model)
	a.Estimate = EstimateFor(a.State, a.Progress, a.Rate, now)
	a.Bubble, a.BubbleKind = bubbleFor(a, now.UnixMilli())
}

func bubbleFor(a *LiveAgent, now int64) (text, kind string) {
	if a.Reply != "" && a.ReplyUntil > now {
		return a.Reply, "reply"
	}
	if a.Talk != "" && a.TalkUntil > now {
		return a.Talk, "talk"
	}
	var lastTool, lastSummary string
	if len(a.Feed) > 0 {
		lastTool, lastSummary = a.Feed[0].Tool, a.Feed[0].Summary
	}
	from := func(tool, fallback string, pick func(string) string) string {
		if lastTool == tool {
			return pick(lastSummary)
		}
		return fallback
	}
	baseName := func(s string) string { return s[strings.LastIndex(s, "/")+1:] }
	head := func(s string) string { return strings.SplitN(s, "  ", 2)[0] }
	same := func(s string) string { return s }

	switch a.State {
	case StateThinking:
		return "Working out what to do next", ""
	case StateReading:
		return "Reading " + from("read_file", "files", baseName), ""
	case StateEditing:
		return "Editing " + from("edit_file", "code", func(s string) string {
			return baseName(head(s))
		}), ""
	case StateRunning:
		return "Running " + from("run_shell", "the tests", head), ""
	case StateBrowsing:
		return "Looking up " + from("web_search", "docs", same), ""
	case StateApproval:
		return "Can I run this? Waiting for you", ""
	case StateSpawning:
		return "Bringing in a helper", ""
	case StateIdle:
		return "Free. Having a coffee", ""
	case StateDone:
		return "Finished: " + a.Task, ""
	case StateError:
		if a.Error != "" {
			return a.Error, ""
		}
		return "Something went wrong", ""
	case StatePaused:
		return "Paused. What should I do?", ""
	}
	return "", ""
}

// ETALong is the estimate in plain words, as the panel and answers say it.
func ETALong(a *LiveAgent, now time.Time) string {
	switch a.State {
	case StateApproval:
		return "Paused until you decide on the approval"
	case StateIdle:
		return "No task right now"
	case StateDone:
		return "Finished"
	case StateError:
		return "Stopped by an error"
	case StatePaused:
		return "Interrupted, waiting for your instruction"
	}
	estimate := EstimateFor(a.State, a.Progress, a.Rate, now)
	if estimate == nil {
		return "No estimate yet"
	}
	finish := time.UnixMilli(estimate.FinishAt).Format("15:04")
	if estimate.SecondsLeft < 60 {
		return "Under a minute left, done around " + finish
	}
	minutes := max(1, int(math.Round(float64(estimate.SecondsLeft)/60)))
	return "About " + strconv.Itoa(minutes) + " min left, done around " + finish
}

// MinsText says a length of time in minutes or hours, such as "9 min" or "1 h 5 min".
func MinsText(seconds int64) string {
	minutes := max(1, int(math.Round(float64(seconds)/60)))
	if minutes < 60 {
		return strconv.Itoa(minutes) + " min"
	}
	hours := strconv.Itoa(minutes/60) + " h"
	if minutes%60 == 0 {
		return hours
	}
	return hours + " " + strconv.Itoa(minutes%60) + " min"
}

// ApprovalSummary says what an approval is for in a few words.
func ApprovalSummary(approval *Approval) string {
	switch approval.Type {
	case ApprovalCommand:
		return approval.Detail.Cmd
	case ApprovalPlan:
		return "Approve the plan for " + approval.Detail.Project
	default:
		return "Edit " + approval.Detail.Path
	}
}

var addressedTo = regexp.MustCompile(`^[A-Za-z]+,\s*`)

// WithoutName drops a leading "Sage, " from an instruction.
func WithoutName(text string) string { return addressedTo.ReplaceAllString(text, "") }

// Ack is an agent's reply to an instruction, such as "I'll update the docs."
func Ack(text string) string {
	body := WithoutName(text)
	if len(body) > 60 {
		return "I'll do that next."
	}
	if body != "" {
		body = strings.ToLower(body[:1]) + body[1:]
	}
	return "I'll " + strings.TrimSuffix(body, ".") + "."
}

// ETAWords is the prototype's phrase for when an agent will be free, used in agent chat.
func ETAWords(a *LiveAgent) string {
	if !a.State.Active() || a.Rate <= 0 {
		return "a few minutes"
	}
	minutes := max(1, int(math.Round((1-a.Progress)/a.Rate/60)))
	return "about " + strconv.Itoa(minutes) + " min"
}

// ProjectState works out a project's status and progress from its agents, as the prototype's
// projStatus and projProgress do.
func ProjectState(p *Project, agents []*LiveAgent) (ProjectStatus, float64) {
	if p.Done != nil {
		return ProjectCompleted, 1
	}
	if len(agents) == 0 {
		return ProjectNew, 0
	}
	var total float64
	var counted int
	needs, active, finished := false, false, false
	for _, a := range agents {
		needs = needs || a.State.NeedsMe()
		active = active || a.State.Active()
		finished = finished || a.Progress >= 1 || a.State == StateDone
		if a.State != StateIdle || a.Progress > 0 {
			total += min(1, a.Progress)
			counted++
		}
	}
	progress := 0.0
	if counted > 0 {
		progress = total / float64(counted)
	}
	switch {
	case needs:
		return ProjectNeeds, progress
	case active:
		return ProjectActive, progress
	case finished:
		return ProjectReady, progress
	default:
		return ProjectIdle, progress
	}
}
