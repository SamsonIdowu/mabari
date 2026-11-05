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
	KindNewAgent Kind = "newAgent"
	KindReplies  Kind = "replies"
	// KindImprove asks the page to open Target in the builder with Mabari's suggestions.
	KindImprove Kind = "improve"
	// KindBuilder opens the agent builder.
	KindBuilder Kind = "builder"
)

// Line is one agent in a reply.
type Line struct {
	AgentID string `json:"agentId"`
	Name    string `json:"name"`
	Hue     string `json:"hue"`
	// Label says what kind of agent it is, shown after the name: "workflow sub-agent" for one not
	// started from an agent definition file, or empty.
	Label string `json:"label"`
	State string `json:"state"`
	Task  string `json:"task"`
	// Estimate is nil unless the agent is working.
	Estimate *models.Estimate `json:"estimate"`
	// Summary says what the agent needs from the user.
	Summary string `json:"summary"`
	// ApprovalID lets the UI open the card. It is empty for an agent stopped by an error.
	ApprovalID string `json:"approvalId"`
	// AI and Reply are set in a list of replies: who answered, and what it said.
	AI    string `json:"ai"`
	Reply string `json:"reply"`
}

// Relay tells the UI which instruction to watch, so it can read out the agent's reply the moment
// it lands.
type Relay struct {
	// AgentID is the agent that holds the instruction. For a Claude Code subagent that is its lead.
	AgentID       string `json:"agentId"`
	InstructionID string `json:"instructionId"`
	// Agent and AI name who will answer, for "Ledger (Claude) replied: …".
	Agent string `json:"agent"`
	AI    string `json:"ai"`
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
	// Target is what a builder reply works on: the agent to improve, or what a new agent should do.
	Target string `json:"target"`
	// Relay is set when Mabari passed an instruction on and will relay the reply.
	Relay *Relay `json:"relay"`
	// Project is the project a message went to.
	Project *ProjectChoice `json:"project"`
	// Projects are the choices when Mabari asks which project a message is for.
	Projects []ProjectChoice `json:"projects"`
	// Route is set when the message is for a project.
	Route *Route `json:"-"`
	// Send is set when the reply passes a message to a named agent.
	Send *Send `json:"-"`
	// Dispatch is set when the message is a task for the dispatcher, not something Mabari answers.
	Dispatch bool `json:"-"`
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
	greeting = regexp.MustCompile(`^(hello|hi|hey)\b`)
	// eta is a question about when work will be done.
	eta = regexp.MustCompile(`^when\b|\beta\b|how long|time left|done by|\bfinish(?:ed)?\b.*\?$`)
	// question is how a question to Mabari starts, when it doesn't end with "?".
	question = regexp.MustCompile(`^(what|what's|whats|who|who's|whos|how|how's|hows|when|is|are|any|anything|has|did|show|give me|tell me|status|eta|summary|update me|catch me up)\b`)
	// asking is how a request for a gesture starts. What follows must be short too.
	asking   = regexp.MustCompile(`^(can you|could you|do a|give me a|show me a|let's see a)\b`)
	newAgent = regexp.MustCompile(`^(?:please\s+)?(?:(?:can|could) you\s+)?(?:add|create|make|hire|start|build)\s+(?:me\s+)?(?:a\s+|an\s+|another\s+)?(?:new\s+)?agent(?:\s+(?:for|to|that|who|which|called|named|please)\b.*)?[.!]?$`)
	// deciding is an order to decide an approval. Mabari never does, so it lists what waits instead.
	deciding  = regexp.MustCompile(`^(?:please\s+)?(?:approve|allow|deny|reject)\b`)
	improving = regexp.MustCompile(`^(?:please\s+)?(?:can you\s+)?(?:improve|tune|upgrade|make better)\s+(?:the\s+)?([a-z0-9 -]+?)(?:\s+agent)?[.!?]*$`)
	whatFor   = regexp.MustCompile(`(?i)^.*?\bagent\b\s*(?:that|to|for|which|who|called|named)?\s*`)
	builder   = regexp.MustCompile(`\b(builder|reusable agents|manage agents|my agents)\b`)
	newProj   = regexp.MustCompile(`^(?:please\s+)?(?:(?:can|could) you\s+)?(?:start|create|begin|make)\s+(?:a\s+)?(?:new\s+)?project\b`)
)

// shortWords is the most a message can have and still be small talk or a gesture.
const shortWords = 3

// replyShown is how much of an agent's reply a list of replies shows. The full text is in the
// agent's panel.
const replyShown = 200

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

// IsQuestion reports whether a message is phrased as a question: it ends with "?" or starts the
// way questions do.
func IsQuestion(q string) bool {
	q = strings.TrimSpace(strings.ToLower(q))
	return strings.HasSuffix(q, "?") || question.MatchString(q)
}

// short reports whether a message is short enough for a gesture: a few words, or "can you"
// and a few words.
func short(q string) bool {
	words := strings.Fields(q)
	if len(words) <= shortWords {
		return true
	}
	if match := asking.FindString(q); match != "" {
		return len(strings.Fields(q[len(match):])) <= shortWords+1
	}
	return false
}

// Answer works out Mabari's reply in an office with no projects. See AnswerIn.
func Answer(text string, agents []*models.LiveAgent, now time.Time) Reply {
	return AnswerIn(text, Office{Agents: agents}, now)
}

// AnswerIn works out Mabari's reply. Messages to a named agent come first, so that "tell Scout to
// fix the endpoint" is an instruction and not a request for the point gesture, then messages to a
// named project. Mabari answers questions about the office itself; everything else is a task for
// a project (Route), a question about which project (KindPickProject), or, in an office with no
// projects, a task for the dispatcher (Dispatch).
func AnswerIn(text string, in Office, now time.Time) Reply {
	office := look(in.Agents, now)
	q := strings.TrimSpace(strings.ToLower(text))
	reply, ok := office.passOn(text, q)
	project, body, nameLength := namedProject(text, open(in.Projects))
	// An agent's name wins, unless a longer project name starts with it: "tell Shop Admin to …"
	// is for the project Shop Admin, not the agent Shop.
	agentNamed := ok && reply.Send != nil
	if agentNamed && (project == nil || nameLength <= len(office.agentName(reply.Send.AgentID))) || ok && in.Projects == nil {
		return reply
	}
	if project != nil && body != "" {
		routed := office.reply("", "nod", KindPlain)
		routed.Route = &Route{ProjectID: project.ID, Text: body}
		return routed
	}
	if agentNamed {
		return reply
	}
	if ok {
		return office.unknown(q, in.Projects)
	}
	isQ, small := IsQuestion(q), short(q)
	if small {
		for _, gesture := range gestures {
			if hasWord(q, gesture.name) || hasWord(q, gesture.phrase) {
				return office.reply(gesture.quip, gesture.name, KindPlain)
			}
		}
	}
	chat := len(strings.Fields(q)) <= shortWords+2
	named := office.named(q)
	switch {
	case chat && greeting.MatchString(q):
		return office.greet()
	case chat && has(q, "thank"):
		return office.reply("Any time. Keeping an eye on things is my favourite job.", "bow", KindPlain)
	case isQ && has(q, "need me", "needs me", "approval", "approve", "waiting on me", "blocked"),
		deciding.MatchString(q):
		return office.needs()
	case isQ && eta.MatchString(q):
		return office.when()
	case improving.MatchString(q):
		reply := office.reply("", "nod", KindImprove)
		reply.Target = strings.TrimSpace(improving.FindStringSubmatch(q)[1])
		return reply
	case newAgent.MatchString(q):
		reply := office.reply("", "point", KindNewAgent)
		reply.Target = strings.TrimSpace(whatFor.ReplaceAllString(text, ""))
		return reply
	case builder.MatchString(q) && !has(q, "create", "new", "make"):
		return office.reply("Opening the agent builder. You can build agents for one project or for your whole "+
			"Claude account.", "point", KindBuilder)
	case newProj.MatchString(q):
		return office.reply("The project chat arrives in a later stage, so I can't open it yet.", "shrug", KindPlain)
	case isQ && has(q, "office", "floor") || q == "office":
		return office.reply("Taking you to the office floor.", "point", KindOffice)
	case named != nil && isQ && has(q, "doing", "working", "status", "how is", "how's", "what is", "what's",
		"progress", "update", "done", "finished", "up to"):
		return office.agentStatus(named)
	case isQ && has(q, "happening", "status", "update", "going on", "summary", "what's up", "whats up",
		"progress", "catch me up"),
		isQ && has(q, "who is", "who's", "whos"):
		return office.status()
	case isQ && has(q, "claude", "codex", "chatgpt", "gpt", "ai said", "ai say", "asked", "replies", "replied",
		"responses", "answers"):
		return office.replies()
	}
	if route, ask := office.forProject(text, in); ask != nil {
		return *ask
	} else if route != nil {
		routed := office.reply("", "nod", KindPlain)
		routed.Route = route
		return routed
	}
	dispatched := office.reply("", "nod", KindPlain)
	dispatched.Dispatch = true
	return dispatched
}

// unknown is the reply to "tell X to …" when X is neither an agent nor a project.
func (o view) unknown(q string, projects []*models.Project) Reply {
	name := strings.TrimSpace(message.FindStringSubmatch(q)[2])
	names := make([]string, 0, 6)
	for _, candidate := range o.agents[:min(4, len(o.agents))] {
		names = append(names, candidate.Name)
	}
	for _, project := range open(projects)[:min(3, len(open(projects)))] {
		names = append(names, project.Name)
	}
	return o.reply("I couldn't find an agent or project called "+name+". Try one of: "+strings.Join(names, ", ")+".",
		"shrug", KindPlain)
}

func (o view) agentName(id string) string {
	for _, agent := range o.agents {
		if agent.ID == id {
			return agent.Name
		}
	}
	return ""
}

// named finds an agent the message mentions by name, longest name first.
func (o view) named(q string) *models.LiveAgent {
	sorted := slices.Clone(o.agents)
	slices.SortStableFunc(sorted, func(a, b *models.LiveAgent) int { return cmp.Compare(len(b.Name), len(a.Name)) })
	for _, agent := range sorted {
		if agent.Name != "" && hasWord(q, strings.ToLower(agent.Name)) {
			return agent
		}
	}
	return nil
}

// lastReply is the newest reply the agent gave to something sent from Mabari.
func lastReply(agent *models.LiveAgent) (models.Instruction, bool) {
	var last models.Instruction
	for _, asked := range agent.Asked {
		if asked.Reply != "" && asked.RepliedAt >= last.RepliedAt {
			last = asked
		}
	}
	return last, last.Reply != ""
}

func shorten(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if clipped := models.Clip(text, replyShown); clipped != text {
		return clipped + "…"
	}
	return text
}

func (o view) agentStatus(agent *models.LiveAgent) Reply {
	text := agent.Name + " (" + models.AIName(agent) + ") is " +
		strings.ToLower(models.StateLabels[agent.State]) + ": " + strings.TrimSuffix(agent.Task, ".") + ". " +
		models.ETALong(agent, o.now) + "."
	if last, ok := lastReply(agent); ok {
		text += " Its last reply: " + shorten(last.Reply)
	}
	return o.reply(text, "point", KindPlain)
}

func (o view) replies() Reply {
	type said struct {
		agent  *models.LiveAgent
		answer models.Instruction
	}
	var all []said
	for _, agent := range o.agents {
		for _, asked := range agent.Asked {
			if asked.Reply != "" {
				all = append(all, said{agent, asked})
			}
		}
	}
	if len(all) == 0 {
		return o.reply("No AI replies yet. Send a task and I'll pass on what Claude, Codex or any other AI says.",
			"shrug", KindPlain)
	}
	slices.SortStableFunc(all, func(a, b said) int { return cmp.Compare(b.answer.RepliedAt, a.answer.RepliedAt) })
	reply := o.reply("Here are the latest AI replies.", "point", KindReplies)
	for _, item := range all[:min(4, len(all))] {
		line := o.line(item.agent)
		line.AI, line.Reply = models.AIName(item.agent), shorten(item.answer.Reply)
		reply.Lines = append(reply.Lines, line)
	}
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
	if strings.EqualFold(match[1], "ask") {
		reply := o.reply("I asked "+agent.Name+". The answer comes from its log, so it won't be interrupted.",
			"nod", KindPlain)
		reply.Send = &Send{AgentID: agent.ID, Text: body, Mode: models.ModeQuery}
		return reply, true
	}
	// What Mabari says depends on how it went, so Passed fills in the text after sending.
	reply := o.reply("", "nod", KindPlain)
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

// WorkflowLabel is how Mabari's lines name a workflow sub-agent.
const WorkflowLabel = "workflow sub-agent"

func (o view) line(agent *models.LiveAgent) Line {
	label := ""
	if agent.Workflow {
		label = WorkflowLabel
	}
	return Line{
		AgentID: agent.ID, Name: agent.Name, Hue: agent.Hue, Label: label,
		State:    strings.ToLower(models.StateLabels[agent.State]),
		Task:     agent.Task,
		Estimate: estimate(agent, o.now),
	}
}

// Where is what became of an instruction Mabari passed on: the agent that holds it (a
// subagent's lead), its id, and whether it waits for the agent's next checkpoint. An empty id
// means the agent couldn't take it.
type Where struct {
	Holder        *models.LiveAgent
	InstructionID string
	Queued        bool
}

func relayFor(agent *models.LiveAgent, where Where) *Relay {
	holder := where.Holder
	if holder == nil {
		holder = agent
	}
	return &Relay{AgentID: holder.ID, InstructionID: where.InstructionID, Agent: agent.Name, AI: models.AIName(agent)}
}

func (o view) unreachable(agent *models.LiveAgent) Reply {
	return o.reply(agent.Name+" couldn't take that just now. Try again in a moment.", "shrug", KindPlain)
}

// Passed is what Mabari says after passing an instruction to the agent the user named.
func Passed(agent *models.LiveAgent, where Where, agents []*models.LiveAgent, now time.Time) Reply {
	office := look(agents, now)
	if where.InstructionID == "" {
		return office.unreachable(agent)
	}
	text := "Sent to " + agent.Name + ". I'll tell you what it says."
	if where.Queued {
		text = "Passed it to " + agent.Name + ". It's mid step, so it gets it at its next checkpoint. I'll tell you what it says."
	}
	reply := office.reply(text, "nod", KindPlain)
	reply.Relay = relayFor(agent, where)
	return reply
}

// Dispatched is what Mabari says the moment the dispatcher has picked an agent: who got it, which
// AI, and why. A nil agent means nobody could take it.
func Dispatched(agent *models.LiveAgent, reason string, where Where, agents []*models.LiveAgent, now time.Time) Reply {
	office := look(agents, now)
	if agent == nil {
		return office.reply("There's no agent free to take that yet. Start one first.", "shrug", KindPlain)
	}
	if where.InstructionID == "" {
		return office.unreachable(agent)
	}
	text := "On it, sent to " + agent.Name + " (" + models.AIName(agent) + ")"
	if reason = strings.TrimSuffix(strings.TrimSpace(reason), "."); reason != "" {
		text += ". " + strings.ToUpper(reason[:1]) + reason[1:]
	}
	reply := office.reply(text+". I'll read you the reply the moment it lands.", "nod", KindPlain)
	reply.Relay = relayFor(agent, where)
	return reply
}
