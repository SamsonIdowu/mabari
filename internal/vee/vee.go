// SPDX-License-Identifier: Apache-2.0

// Package vee answers the chat on Home from the live office, using fixed rules.
//
// Vee can look things up and pass messages on, but it has no way to decide an approval. A reply
// only ever describes an approval and offers a button that opens the card for the user.
package vee

import (
	"cmp"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// Kind tells the UI how to show a reply. The zero value is plain text.
type Kind string

// Reply kinds.
const (
	KindPlain    Kind = ""
	KindNeeds    Kind = "needs"
	KindWhen     Kind = "when"
	KindStatus   Kind = "status"
	KindOffice   Kind = "office"
	KindEmpty    Kind = "empty"
	KindDispatch Kind = "dispatch"
	KindNewAgent Kind = "newAgent"
)

// Line is one agent in a reply.
type Line struct {
	AgentID string `json:"agentId"`
	Name    string `json:"name"`
	Hue     string `json:"hue"`
	State   string `json:"state"`
	Task    string `json:"task"`
	// Estimate is nil unless the agent is working.
	Estimate *models.Estimate `json:"estimate"`
	// Summary says what the agent needs from the user.
	Summary string `json:"summary"`
	// ApprovalID lets the UI open the card. It is empty for an agent stopped by an error.
	ApprovalID string `json:"approvalId"`
}

// Send asks the server to pass a message on through the normal instruct and query code.
type Send struct {
	AgentID string
	Text    string
	Mode    models.InstructionMode
}

// Reply is what Vee says.
type Reply struct {
	// Text is the whole reply in plain words.
	Text    string `json:"text"`
	Gesture string `json:"gesture"`
	Kind    Kind   `json:"kind"`
	Lines   []Line `json:"lines"`
	// Estimate is when the work in view should finish, or nil.
	Estimate *models.Estimate `json:"estimate"`
	Working  int              `json:"working"`
	Total    int              `json:"total"`
	Need     int              `json:"need"`
	// Message is what the Send to the team button would send.
	Message string `json:"message"`
	// Send is set when the reply passes a message on.
	Send *Send `json:"-"`
}

// Gesture order matters: "star jump" is a jump, as in the prototype.
var gestures = []struct{ name, phrase, quip string }{
	{"wave", "wave", "Hello there!"},
	{"nod", "nod", "Yes, absolutely."},
	{"shake", "shake head", "Nope, not that one."},
	{"shrug", "shrug", "Who knows?"},
	{"point", "point", "Over there!"},
	{"clap", "clap", "Nice work, team!"},
	{"jump", "jump", "Wheee!"},
	{"spin", "spin", "Full spin!"},
	{"dance", "dance", "Don't mind if I do."},
	{"stretch", "star jump", "Star jump! Good for the circulation."},
	{"celebrate", "celebrate", "Party time!"},
	{"bow", "bow", "Thank you, thank you."},
	{"wink", "wink", "You got it."},
}

var (
	message  = regexp.MustCompile(`(?i)^(?:please\s+)?(tell|ask)\s+([a-z ]+?)\s+(?:to\s+)?(.+)$`)
	opening  = regexp.MustCompile(`(?i)^(?:please\s+)?(?:tell|ask)\s+`)
	leadTo   = regexp.MustCompile(`(?i)^to\s+`)
	greeting = regexp.MustCompile(`\b(hello|hi|hey)\b`)
	eta      = regexp.MustCompile(`\beta\b`)
)

func has(text string, phrases ...string) bool {
	for _, phrase := range phrases {
		if strings.Contains(text, phrase) {
			return true
		}
	}
	return false
}

// hasWord matches whole words, so "endpoint" doesn't count as "point".
func hasWord(text, word string) bool {
	return regexp.MustCompile(`\b` + regexp.QuoteMeta(word) + `\b`).MatchString(text)
}

type view struct {
	agents  []*models.LiveAgent
	working []*models.LiveAgent
	need    []*models.LiveAgent
	finish  *models.Estimate
	now     time.Time
}

func estimate(a *models.LiveAgent, now time.Time) *models.Estimate {
	return models.EstimateFor(a.State, a.Progress, a.Rate, now)
}

func look(agents []*models.LiveAgent, now time.Time) view {
	office := view{agents: agents, now: now}
	var estimates []*models.Estimate
	for _, agent := range agents {
		if agent.State.Active() {
			office.working = append(office.working, agent)
			estimates = append(estimates, estimate(agent, now))
		}
		if agent.State.NeedsMe() {
			office.need = append(office.need, agent)
		}
	}
	office.finish = models.LatestFinish(estimates...)
	return office
}

func (o view) reply(text, gesture string, kind Kind) Reply {
	return Reply{
		Text: text, Gesture: gesture, Kind: kind, Estimate: o.finish,
		Working: len(o.working), Total: len(o.agents), Need: len(o.need),
	}
}

// Answer works out Vee's reply. Messages come first, so that "tell Scout to fix the endpoint" is
// an instruction and not a request for the point gesture.
func Answer(text string, agents []*models.LiveAgent, now time.Time) Reply {
	office := look(agents, now)
	q := strings.ToLower(text)
	if reply, ok := office.passOn(text, q); ok {
		return reply
	}
	for _, gesture := range gestures {
		if hasWord(q, gesture.name) || hasWord(q, gesture.phrase) {
			return office.reply(gesture.quip, gesture.name, KindPlain)
		}
	}
	switch {
	case greeting.MatchString(q):
		return office.greet()
	case has(q, "thank"):
		return office.reply("Any time. Keeping an eye on things is my favourite job.", "bow", KindPlain)
	case has(q, "need me", "needs me", "approval", "approve", "waiting on me", "blocked"):
		return office.needs()
	case has(q, "how long", "when", "finish", "done by", "time left") || eta.MatchString(q):
		return office.when()
	case has(q, "agent") && has(q, "new", "create", "add", "make", "hire") && !has(q, "project"):
		return office.reply("Let's add someone to the team. Pick a role and I'll fill in the rest.",
			"point", KindNewAgent)
	case has(q, "project") && has(q, "new", "start", "create", "begin"):
		return office.reply("The project chat arrives in a later stage, so I can't open it yet.", "shrug", KindPlain)
	case has(q, "office", "floor", "show me"):
		return office.reply("Taking you to the office floor.", "point", KindOffice)
	case has(q, "happening", "status", "update", "going on", "summary", "what's up", "whats up", "progress"),
		has(q, "who is", "who's", "whos"):
		return office.status()
	}
	reply := office.reply("I can pass that to the team. The dispatcher will pick the best agent for it.",
		"shrug", KindDispatch)
	reply.Message = text
	return reply
}

// find matches the longest name first, so "tell Atlas scribe" doesn't reach Atlas.
func (o view) find(rest string) (*models.LiveAgent, string) {
	sorted := slices.Clone(o.agents)
	slices.SortStableFunc(sorted, func(a, b *models.LiveAgent) int { return cmp.Compare(len(b.Name), len(a.Name)) })
	for _, agent := range sorted {
		name := strings.ToLower(agent.Name) + " "
		if strings.HasPrefix(strings.ToLower(rest), name) {
			return agent, strings.TrimSpace(leadTo.ReplaceAllString(rest[len(name):], ""))
		}
	}
	return nil, ""
}

func (o view) passOn(text, q string) (Reply, bool) {
	match := message.FindStringSubmatch(q)
	if match == nil {
		return Reply{}, false
	}
	name := strings.TrimSpace(match[2])
	if name == "me" || name == "us" {
		return Reply{}, false
	}
	agent, body := o.find(opening.ReplaceAllString(text, ""))
	if agent == nil {
		names := make([]string, 0, 5)
		for _, candidate := range o.agents[:min(5, len(o.agents))] {
			names = append(names, candidate.Name)
		}
		return o.reply("I couldn't find an agent called "+name+". Try one of: "+strings.Join(names, ", ")+".",
			"shrug", KindPlain), true
	}
	if body == "" {
		return Reply{}, false
	}
	var reply Reply
	switch {
	case strings.EqualFold(match[1], "ask"):
		reply = o.reply("I asked "+agent.Name+". The answer comes from its log, so it won't be interrupted.",
			"nod", KindPlain)
		reply.Send = &Send{AgentID: agent.ID, Text: body, Mode: models.ModeQuery}
		return reply, true
	case agent.Account == models.AccountClaudeCode && agent.State.Active():
		reply = o.reply("Passed it to "+agent.Name+". As a Claude Code agent it picks it up at its next checkpoint.",
			"nod", KindPlain)
	default:
		reply = o.reply("Sent to "+agent.Name+". It has it now.", "nod", KindPlain)
	}
	reply.Send = &Send{AgentID: agent.ID, Text: body, Mode: models.ModeInstruct}
	return reply, true
}

func (o view) greet() Reply {
	text := "Hey! Good to see you. No agents are running yet."
	if len(o.agents) > 0 {
		text = "Hey! Good to see you. " + strconv.Itoa(len(o.working)) + " of your " +
			strconv.Itoa(len(o.agents)) + " agents are working right now."
	}
	return o.reply(text, "wave", KindPlain)
}

func (o view) needs() Reply {
	count := len(o.need)
	if count == 0 {
		return o.reply("Nothing needs you right now. Everyone's either working or happily idle.", "wink", KindPlain)
	}
	text := strconv.Itoa(count) + " things need you."
	if count == 1 {
		text = "1 thing needs you."
	}
	reply := o.reply(text, "point", KindNeeds)
	for _, agent := range o.need {
		line := o.line(agent)
		switch {
		case agent.State == models.StateApproval && agent.Approval != nil:
			line.Summary = models.ApprovalSummary(agent.Approval)
			line.ApprovalID = agent.Approval.ID
		case agent.Error != "":
			line.Summary = agent.Error
		default:
			line.Summary = "stopped with an error"
		}
		reply.Lines = append(reply.Lines, line)
	}
	return reply
}

func (o view) when() Reply {
	if o.finish == nil {
		return o.reply("Nothing is in progress, so there's nothing to wait for.", "shrug", KindPlain)
	}
	slowest := slices.Clone(o.working)
	slices.SortStableFunc(slowest, func(a, b *models.LiveAgent) int {
		return cmp.Compare(seconds(b, o.now), seconds(a, o.now))
	})
	reply := o.reply("Everything should be done in about "+models.MinsText(o.finish.SecondsLeft)+", around "+
		time.UnixMilli(o.finish.FinishAt).Format("15:04")+". "+slowest[0].Name+" will be last.", "nod", KindWhen)
	for _, agent := range slowest[:min(4, len(slowest))] {
		reply.Lines = append(reply.Lines, o.line(agent))
	}
	return reply
}

func seconds(a *models.LiveAgent, now time.Time) int64 {
	if forecast := estimate(a, now); forecast != nil {
		return forecast.SecondsLeft
	}
	return 0
}

func (o view) status() Reply {
	if len(o.agents) == 0 {
		return o.reply("The office is empty for now. Connect an account or explore the demo office to see agents at work.",
			"shrug", KindEmpty)
	}
	reply := o.reply(strconv.Itoa(len(o.working))+" agents are working and "+strconv.Itoa(len(o.need))+" need you.",
		"point", KindStatus)
	for _, agent := range o.working[:min(6, len(o.working))] {
		reply.Lines = append(reply.Lines, o.line(agent))
	}
	return reply
}

func (o view) line(agent *models.LiveAgent) Line {
	return Line{
		AgentID: agent.ID, Name: agent.Name, Hue: agent.Hue,
		State:    strings.ToLower(models.StateLabels[agent.State]),
		Task:     agent.Task,
		Estimate: estimate(agent, o.now),
	}
}

// Dispatched is what Vee says after sending a message to the team. A nil agent means nobody could
// take it.
func Dispatched(name, reason string, agents []*models.LiveAgent, now time.Time) Reply {
	office := look(agents, now)
	if name == "" {
		return office.reply("There's no agent free to take that yet. Start one first.", "shrug", KindPlain)
	}
	text := "Done. I sent it to " + name
	if reason != "" {
		text += ". " + strings.ToUpper(reason[:1]) + strings.TrimSuffix(reason[1:], ".")
	}
	return office.reply(text+".", "nod", KindPlain)
}
