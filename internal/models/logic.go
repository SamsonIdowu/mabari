// SPDX-License-Identifier: Apache-2.0

package models

import (
	"maps"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Limits from the prototype. MaxSubagents caps a planned team and the demo's simulated helpers;
// real subagents are never turned away. The desks are in desks.go.
const (
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

// StatePhrases say what an agent is doing in a sentence, after its name: "Atlas is waiting for your
// approval", "Mori hit an error". StateLabels are for chips and headings, where "Needs approval"
// and "Error" read well but "Atlas is needs approval" does not. Every state has one: a test
// compares the two maps.
var StatePhrases = map[AgentState]string{
	StateThinking: "is thinking",
	StateReading:  "is reading files",
	StateEditing:  "is editing",
	StateRunning:  "is running tests",
	StateBrowsing: "is browsing",
	StateApproval: "is waiting for your approval",
	StateSpawning: "is starting a subagent",
	StateIdle:     "is idle",
	StateDone:     "is done",
	StateError:    "hit an error",
	StatePaused:   "was interrupted",
}

// Models lists the demo office's models for each account kind.
var Models = map[AccountKind][]string{
	AccountCodex:        {"gpt-5-codex", "gpt-5", "gpt-5-mini"},
	AccountClaudeCode:   {"claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5"},
	AccountAnthropicKey: {"claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"},
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
	MessageAnswer:    "#4FB3FF",
	MessageReport:    "#FF9F43",
	MessageReview:    "#FF6B9A",
	MessageBroadcast: "#C9C9CE",
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
		QueryModel:    "gpt-5-mini",
		VoiceEngine:   "browser",
		ApprovalSound: true,
		RetentionDays: 30,
		Defaults: map[string]string{
			"claude":    "claude-sonnet-4-5",
			"codex":     "gpt-5-codex",
			"anthropic": "claude-sonnet-5-5",
			"openai":    "gpt-5",
		},
		AutoApprove: AutoApprove{Scope: "safe"},
		MaxSessions: DefaultSessions,
	}
}

// DefaultsKey is the key each account kind has in Settings.Defaults.
var DefaultsKey = map[AccountKind]string{
	AccountClaudeCode: "claude", AccountCodex: "codex",
	AccountAnthropicKey: "anthropic", AccountOpenAIKey: "openai",
}

// AccountLabel is how the pages name each account kind, and so how a message about it should.
var AccountLabel = map[AccountKind]string{
	AccountClaudeCode: "Claude Code", AccountCodex: "ChatGPT (Codex)",
	AccountAnthropicKey: "Anthropic API key", AccountOpenAIKey: "OpenAI API key",
}

// CorrectModels returns the settings with every model choice valid, and a plain sentence for each
// one it had to change. A default must be one of its account's own models, and the query model one
// of any account's. Settings show what is stored, so a value that no list offers would otherwise be
// shown as something else while another is used. The hub's placeholder is not a model. A choice
// that isn't valid becomes the standard one if that is valid, or else the first model offered.
func CorrectModels(settings Settings, accounts []Account) (Settings, []string) {
	settings = settings.Clone()
	if settings.Defaults == nil {
		settings.Defaults = map[string]string{}
	}
	offered := map[AccountKind][]string{}
	var every []string
	for _, account := range accounts {
		if account.Kind == AccountHub {
			continue
		}
		offered[account.Kind] = account.Models
		every = append(every, account.Models...)
	}
	standard := DefaultSettings()
	var changes []string
	pick := PickModel
	for _, kind := range AccountKinds {
		key, list := DefaultsKey[kind], offered[kind]
		if key == "" || len(list) == 0 {
			continue
		}
		current, has := settings.Defaults[key]
		if has && slices.Contains(list, current) {
			continue
		}
		replacement := pick(list, standard.Defaults[key])
		settings.Defaults[key] = replacement
		if has && current != "" {
			changes = append(changes, "The "+AccountLabel[kind]+" default was "+current+
				", which that account doesn't offer, so it is now "+replacement+".")
		}
	}
	if len(every) > 0 && !slices.Contains(every, settings.QueryModel) {
		replacement := pick(every, standard.QueryModel)
		if settings.QueryModel != "" {
			changes = append(changes, "The model that answers queries was "+settings.QueryModel+
				", which no account offers, so it is now "+replacement+".")
		}
		settings.QueryModel = replacement
	}
	return settings, changes
}

// PickModel is the preferred model if the list offers it, and else the first model the list offers.
// With nothing offered there is nothing to correct against, so the preference stands.
func PickModel(offered []string, preferred string) string {
	if len(offered) == 0 || slices.Contains(offered, preferred) {
		return preferred
	}
	return offered[0]
}

// NeedsMe reports whether the state asks for the user's attention.
func (s AgentState) NeedsMe() bool { return s == StateApproval || s == StateError }

// CostOf prices tokens by model. Unknown models cost nothing.
func CostOf(tokensIn, tokensOut int64, model string) float64 {
	return float64(tokensIn+tokensOut) / 1000 * prices[model]
}

// Refresh recomputes the session's derived fields: cost, working, estimate and speech bubble.
func (a *LiveAgent) Refresh(now time.Time) {
	a.Cost = CostOf(a.TokensIn, a.TokensOut, a.Model)
	// An agent waiting on the person's answer isn't working, whatever it was doing when it asked.
	a.Working = a.State.Active() && !a.Asking()
	a.Estimate = a.EstimateAt(now)
	a.Bubble, a.BubbleKind = bubbleFor(a, now.UnixMilli())
	// The demo counts its own office time. Anyone else has been here since it arrived.
	if a.Source != SourceDemo && a.CreatedAt > 0 {
		a.Elapsed = max(0, (now.UnixMilli()-a.CreatedAt)/1000)
	}
}

func bubbleFor(a *LiveAgent, now int64) (text, kind string) {
	// A question waits on the person, so it shows until it is answered.
	if a.Asking() {
		return "Asking you a question", "ask"
	}
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
			// Never a sentence around nothing: "Reading " with no file says less than "Reading files".
			if picked := strings.TrimSpace(pick(lastSummary)); picked != "" {
				return picked
			}
		}
		return fallback
	}
	baseName := BaseName
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

// Doing is what the agent is doing as a phrase after its name: "is editing", "is waiting for your
// approval", "is asking you a question". An agent waiting on your answer says so whatever it was
// doing when it asked.
func Doing(a *LiveAgent) string {
	if a.Asking() {
		return "is asking you a question"
	}
	if phrase, ok := StatePhrases[a.State]; ok {
		return phrase
	}
	return "is " + strings.ToLower(string(a.State))
}

// ETALong is the estimate in plain words, as the panel and answers say it.
func ETALong(a *LiveAgent, now time.Time) string {
	if a.Asking() {
		return "Waiting for your answer"
	}
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
	estimate := a.EstimateAt(now)
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

// ackLimit is the longest instruction an acknowledgement repeats back, in characters.
const ackLimit = 60

// verbs are words that start an instruction on their own: "fix the bug", "run the tests". An
// instruction starting with one can be promised back as "I'll fix the bug." Anything else
// ("after this step, run the linter", "we need tests") would make nonsense after "I'll", so it is
// echoed instead.
var verbs = map[string]bool{
	"add": true, "analyse": true, "analyze": true, "ask": true, "benchmark": true, "build": true,
	"cache": true, "change": true, "check": true, "choose": true, "clean": true, "close": true,
	"commit": true, "compare": true, "configure": true, "continue": true, "copy": true,
	"create": true, "debug": true, "delete": true, "deploy": true, "disable": true, "document": true,
	"downgrade": true, "draft": true, "drop": true, "edit": true, "enable": true, "explain": true,
	"extract": true, "find": true, "finish": true, "fix": true, "focus": true, "format": true,
	"generate": true, "give": true, "go": true, "handle": true, "implement": true, "improve": true,
	"increase": true, "install": true, "investigate": true, "keep": true, "limit": true,
	"lint": true, "list": true, "look": true, "make": true, "merge": true, "move": true,
	"open": true, "optimize": true, "optimise": true, "pause": true, "pick": true, "plan": true,
	"prepare": true, "profile": true, "push": true, "read": true, "reduce": true, "refactor": true,
	"remove": true, "rename": true, "replace": true, "rerun": true, "retry": true, "review": true,
	"revert": true, "rewrite": true, "round": true, "run": true, "search": true, "select": true,
	"send": true, "set": true, "show": true, "simplify": true, "split": true, "start": true,
	"stop": true, "summarise": true, "summarize": true, "switch": true, "take": true, "test": true,
	"try": true, "update": true, "upgrade": true, "use": true, "validate": true, "verify": true,
	"wait": true, "work": true, "write": true,
}

// promiseAdverbs may come before the verb: "also update the docs" is "I'll also update the docs".
var promiseAdverbs = map[string]bool{"also": true, "then": true, "now": true, "first": true, "next": true, "just": true}

// promise gives what follows "I'll" for an instruction, and reports whether it can: only when the
// instruction starts with a verb, after "please" and a word like "also". "please" is dropped.
func promise(body string) (string, bool) {
	words := strings.Fields(body)
	if len(words) > 0 && strings.EqualFold(words[0], "please") {
		words = words[1:]
	}
	verb := 0
	for verb < len(words) && promiseAdverbs[strings.ToLower(words[verb])] {
		verb++
	}
	if verb >= len(words) || !verbs[strings.ToLower(words[verb])] {
		return "", false
	}
	return LowerFirst(strings.Join(words, " ")), true
}

// Ack is an agent's reply to an instruction. An instruction that starts with a verb is promised
// back, "Got it. I'll update the docs."; any other is echoed, "Got it: after this step, run the
// linter.", which can't come out garbled whatever the person typed. A long one only gets "I'll do
// that next." It is the whole reply, "Got it" included.
func Ack(text string) string {
	body := strings.Join(strings.Fields(WithoutName(text)), " ")
	// Characters, not bytes, so an instruction in another language is measured fairly.
	if utf8.RuneCountInString(body) > ackLimit {
		return "Got it. I'll do that next."
	}
	body = strings.TrimSuffix(body, ".")
	if said, ok := promise(body); ok {
		return "Got it. I'll " + said + "."
	}
	if body == "" {
		return "Got it."
	}
	if strings.HasSuffix(body, "?") || strings.HasSuffix(body, "!") {
		return "Got it: " + body
	}
	return "Got it: " + body + "."
}

// LowerFirst lowers the first character, which may take more than one byte.
func LowerFirst(text string) string {
	first, size := utf8.DecodeRuneInString(text)
	if size == 0 || first == utf8.RuneError {
		return text
	}
	return string(unicode.ToLower(first)) + text[size:]
}

// BaseName is the last part of a path, as a sentence names it: "src/app.ts" is "app.ts", and a
// folder keeps its slash so it reads as one: "test/" is "test/", not nothing. It is empty only
// for an empty path, or one with nothing in it but slashes, and callers use a fallback then.
func BaseName(path string) string {
	trimmed := strings.TrimRight(path, "/")
	name := trimmed[strings.LastIndex(trimmed, "/")+1:]
	if name != "" && len(trimmed) < len(path) {
		name += "/"
	}
	return name
}

// ETAWords is the prototype's phrase for when an agent will be free, used in agent chat.
func ETAWords(a *LiveAgent) string {
	if !a.State.Active() || a.RatePerSecond() <= 0 {
		return "a few minutes"
	}
	minutes := max(1, int(math.Round((1-a.Progress)/a.RatePerSecond()/60)))
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
	// Agents in the plan that haven't arrived yet have done none of their share.
	if expected := counted + p.Planned; expected > 0 {
		progress = total / float64(expected)
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

// DemoEmail is the pretend ChatGPT sign in the demo office shows.
const DemoEmail = "you@example.com"

// Clip shortens text to at most limit characters, never cutting a character in half.
func Clip(text string, limit int) string {
	if utf8.RuneCountInString(text) <= limit {
		return text
	}
	return string([]rune(text)[:limit])
}

// AIName is the AI behind an agent, as Mabari names it in chat: "Claude", "ChatGPT" for a Codex
// sign-in, "OpenAI" for an API key, or "Custom AI".
func AIName(a *LiveAgent) string {
	switch {
	case a.Account == AccountCodex:
		return "ChatGPT"
	case a.Provider == ProviderClaude:
		return "Claude"
	case a.Provider == ProviderOpenAI:
		return "OpenAI"
	default:
		return "Custom AI"
	}
}
