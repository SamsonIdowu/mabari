// SPDX-License-Identifier: Apache-2.0

package vee

// "Tell me when Ledger is done", "let me know when Checkout revamp finishes" and "when Ledger is
// done, tell Quill to review it": asking Mabari to watch an agent or a project. Mabari never sends
// such a phrase to an agent as an instruction, and "tell Ledger to …" is untouched, because a
// request to be told starts with "tell me", and one to chain starts with "when".

import (
	"regexp"
	"strings"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// WatchAsk is the watch a message asks for. The server sets it up, then says how it went with
// Watching.
type WatchAsk struct {
	Kind models.WatchKind
	// Target is the agent's or project's id, and Name what it is called.
	Target string
	Name   string
	// ThenAgent, ThenName and ThenText are an instruction for another agent, or empty.
	ThenAgent string
	ThenName  string
	ThenText  string
}

var (
	// toldWhen starts a request to be told: "tell me when …", "let me know once …".
	toldWhen = regexp.MustCompile(`(?is)^(?:please\s+)?(?:(?:can|could|would) you\s+)?` +
		`(?:tell me|let me know|notify me|ping me|alert me|message me|i(?:'d| would)? (?:like|want) to know|i want to know)` +
		`\s+(?:when|once|as soon as|after)\s+(.+)$`)
	// whenDone starts a chain: "when Ledger is done, tell Quill to …".
	whenDone = regexp.MustCompile(`(?is)^(?:please\s+)?(?:when|once|as soon as|after)\s+(.+)$`)
	// finishedAt splits "Ledger is done, then …" into the name, and what follows the finishing word.
	finishedAt = regexp.MustCompile(`(?is)^(.+?)(?:\s+(?:is|are|has|have|gets?|will be|will have|will|should be)|[’'](?:s|re))?` +
		`\s+(?:(?:now|all|completely|fully)\s+)*(?:done|finished|finishes|finish|completes?|completed|ready)\b\s*(.*)$`)
	// thenTell is what may follow: ", then tell Quill to review it".
	thenTell = regexp.MustCompile(`(?is)^[,;:.\-–—]*\s*(?:and\s+)?(?:then\s+)?(?:please\s+)?(?:tell|ask|have|get)\s+(.+)$`)
	// questionWord starts a question, so "when is Ledger done?" is a question about time and not a
	// request to watch something called "is Ledger".
	questionWord = regexp.MustCompile(`(?i)^(?:is|are|was|were|does|do|did|will|would|can|could|should|how|what|who|why|which|if)\b`)
	// notOne are the words that name no one thing: "tell me when it's done" doesn't say what. Mabari
	// asks, and never hands such a phrase to an agent.
	notOne = regexp.MustCompile(`(?i)^(?:it|that|this|they|them|you|there|everything|everyone|everybody|all|we|the office|the team)$`)
	// toMe is a "tell me" that comes after: "…, then tell me", which only repeats the request.
	toMe = regexp.MustCompile(`(?i)^me\b`)
	// politeness may follow a request to be told, and is no part of a chain.
	politeness = regexp.MustCompile(`(?i)^[\s,;:.!?\-–—]*(?:(?:please|thanks|thank you|thx|ok|okay)[\s,;:.!?\-–—]*)*$`)
	// thePrefix and kindSuffix dress a name: "the Ledger agent", "the Checkout revamp project".
	thePrefix  = regexp.MustCompile(`(?i)^(?:the\s+)?(?:(?:agent|project)\s+)?`)
	kindSuffix = regexp.MustCompile(`(?i)\s+(?:agent|project)$`)
)

// bareName is a name as a message gives it, without "the", "agent" or "project" around it.
func bareName(name string) string {
	name = strings.Trim(strings.TrimSpace(name), `.,;:!?"“”'‘’`)
	name = thePrefix.ReplaceAllString(name, "")
	return strings.TrimSpace(kindSuffix.ReplaceAllString(name, ""))
}

// watching works out whether the message asks Mabari to watch something, and if so what to say or
// ask the server to set up. It returns false for anything else, which then goes the usual way.
func (o view) watching(text string, in Office) (Reply, bool) {
	text = strings.TrimSpace(text)
	chained := false
	match := toldWhen.FindStringSubmatch(text)
	if match == nil {
		if match = whenDone.FindStringSubmatch(text); match == nil {
			return Reply{}, false
		}
		chained = true
	}
	done := finishedAt.FindStringSubmatch(match[1])
	if done == nil {
		return Reply{}, false
	}
	raw, rest := strings.TrimSpace(done[1]), strings.TrimSpace(done[2])
	subject := bareName(raw)
	if questionWord.MatchString(subject) {
		return Reply{}, false
	}
	var then []string
	if rest != "" {
		if then = thenTell.FindStringSubmatch(rest); then != nil && toMe.MatchString(then[1]) {
			then = nil
			rest = ""
		}
		switch {
		case rest == "" || then != nil:
		case chained:
			// "when Ledger is done run the tests" says nothing to tell anyone: not a chain.
			return Reply{}, false
		case !politeness.MatchString(rest):
			return o.reply("I didn't follow the part after “done”. Try: tell me when "+subject+
				" is done, then tell Quill to review it.", "shrug", KindPlain), true
		}
	} else if chained {
		return Reply{}, false
	}
	if subject == "" || notOne.MatchString(subject) {
		return o.reply("I can watch one agent or one project. Say which, like: tell me when Ledger is done.",
			"shrug", KindPlain), true
	}
	ask := WatchAsk{}
	var found bool
	if ask.Kind, ask.Target, ask.Name, found = o.subject(raw, in); !found {
		if ask.Kind, ask.Target, ask.Name, found = o.subject(subject, in); !found {
			return o.reply(o.nothingCalled("an agent or project", subject, in), "shrug", KindPlain), true
		}
	}
	if then != nil {
		// The space lets a name with nothing after it be found, so it can be asked what to tell it.
		agent, body := o.find(then[1] + " ")
		if agent == nil {
			name := then[1]
			if cut := strings.Index(strings.ToLower(name), " to "); cut > 0 {
				name = name[:cut]
			}
			return o.reply(o.nothingCalled("an agent", strings.TrimSpace(name), in), "shrug", KindPlain), true
		}
		if body == "" {
			return o.reply("What should I tell "+agent.Name+"? Try: tell me when "+ask.Name+" is done, then tell "+
				agent.Name+" to review it.", "shrug", KindPlain), true
		}
		ask.ThenAgent, ask.ThenName, ask.ThenText = agent.ID, agent.Name, body
	}
	reply := o.reply("", "nod", KindPlain)
	reply.Watch = &ask
	return reply, true
}

// subject finds the agent or project a name means: an agent by its whole name, else a project by
// its name or the start of it that no other project shares.
func (o view) subject(name string, in Office) (kind models.WatchKind, id, called string, found bool) {
	for _, agent := range o.agents {
		if strings.EqualFold(agent.Name, name) {
			return models.WatchAgent, agent.ID, agent.Name, true
		}
	}
	lower := strings.ToLower(strings.Join(strings.Fields(name), " "))
	for _, alias := range aliases(in.Projects) {
		if alias.text == lower {
			return models.WatchProject, alias.project.ID, alias.project.Name, true
		}
	}
	return "", "", "", false
}

// nothingCalled says there is no such agent or project, and offers some that exist.
func (o view) nothingCalled(what, name string, in Office) string {
	var names []string
	for _, agent := range o.agents[:min(4, len(o.agents))] {
		names = append(names, agent.Name)
	}
	if what != "an agent" {
		for _, project := range open(in.Projects)[:min(3, len(open(in.Projects)))] {
			names = append(names, project.Name)
		}
	}
	text := "I couldn't find " + what + " called " + name + "."
	if len(names) > 0 {
		text += " Try one of: " + strings.Join(names, ", ") + "."
	}
	return text
}

// WatchResult is how setting a watch went, in what Watching needs to say it.
type WatchResult struct {
	Kind models.WatchKind
	// Name and Task say what is watched, and Detail what went wrong if it ended in an error.
	Name, Task, Detail string
	// Already is how the work had ended before there was anything to wait for.
	Already models.WatchOutcome
	// Kept is true when it was already being watched.
	Kept bool
	// Then is the instruction the watch carries, or nil.
	Then *models.WatchThen
	// Problem is why no watch could be set, in a sentence, or empty.
	Problem string
}

func inQuotes(text string) string { return "“" + models.Clip(strings.TrimSpace(text), 80) + "”" }

// WatchSaid says what became of a request to watch, in Mabari's words. The page's own switch gets
// the same sentence, so both always tell the same story.
func WatchSaid(result WatchResult) string {
	if result.Problem != "" {
		return result.Problem
	}
	name := result.Name
	project := result.Kind == models.WatchProject
	then := ""
	if result.Then != nil {
		then = inQuotes(result.Then.Text)
	}
	switch {
	case result.Already == models.WatchDone && project:
		text := name + " is already done. There's nothing to wait for."
		if then != "" {
			text += " I haven't told " + result.Then.AgentName + " " + then + "."
		}
		return text
	case result.Already == models.WatchDone:
		text := name + " already finished"
		if task := strings.TrimSuffix(models.Clip(strings.TrimSpace(result.Task), 80), "."); task != "" {
			text += ": " + task
		}
		text += ". There's nothing to wait for."
		if then != "" {
			text += " I haven't told " + result.Then.AgentName + " " + then + "."
		}
		return text
	case result.Already == models.WatchFailed && project:
		text := name + " has already stopped."
		if result.Detail != "" {
			text += " " + result.Detail + " stopped with an error."
		}
		return text + " There's nothing to wait for."
	case result.Already == models.WatchFailed:
		text := name + " already stopped with an error"
		if detail := strings.TrimSuffix(models.Clip(strings.TrimSpace(result.Detail), 100), "."); detail != "" {
			text += ": " + detail
		}
		return text + ". There's nothing to wait for."
	case result.Kept && then == "":
		return "I'm already watching " + name + ". I'll tell you when it's done."
	}
	text := "Okay. I'll tell you when " + name + " is done"
	if project {
		text += ", which is when every agent on it has finished"
	}
	if then != "" {
		return text + ", then tell " + result.Then.AgentName + " " + then + ". If " + name +
			" hits an error I won't send it, and I'll say so."
	}
	return text + "."
}

// Watching is Mabari's reply once the server has tried to set up the watch a message asked for.
func Watching(result WatchResult, agents []*models.LiveAgent, now time.Time) Reply {
	gesture := "nod"
	if result.Problem != "" || result.Already != "" {
		gesture = "shrug"
	}
	return look(agents, now).reply(WatchSaid(result), gesture, KindPlain)
}
