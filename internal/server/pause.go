// SPDX-License-Identifier: Apache-2.0

package server

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/connectors/claudecode"
	"github.com/SamsonIdowu/mabari/internal/connectors/codex"
	"github.com/SamsonIdowu/mabari/internal/connectors/hub"
	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
)

// Pause everyone and Continue everyone. The page names the agents, from the view it is showing, and
// the server decides for each one whether it can be paused or continued, doing it through the
// connector's own Interrupt and Continue. Nothing here can settle an approval: an agent waiting on
// one, or on an answer, is never asked to pause, so its card stays exactly as it was.

// maxGroup is the most agents one request may name.
const maxGroup = 500

// What happened to one agent.
const (
	// outcomePaused: it stopped, and is shown as interrupted.
	outcomePaused = "paused"
	// outcomeResumed: it carries on.
	outcomeResumed = "resumed"
	// outcomeAsked: Mabari could only ask. Claude Code stops at its next step, Codex ends its
	// turn, and a hub app is sent "Please pause." and decides for itself.
	outcomeAsked = "asked"
	// outcomeWaiting: continued, but its session can't be restarted from here and now waits for
	// the person to type in it. Claude Code ends its turn when it pauses.
	outcomeWaiting = "waiting"
	// outcomeSkipped: left alone, and Why says why.
	outcomeSkipped = "skipped"
)

type groupBody struct {
	IDs []string `json:"ids"`
}

// groupResult is what happened to one agent. Why reads after the agent's name, such as "is waiting
// for your approval", and is empty when the agent simply paused or carried on.
type groupResult struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Outcome string `json:"outcome"`
	Why     string `json:"why"`
}

// groupReply says what was done, in the order the page named the agents. The counts and the
// summary are the server's, and the summary is also what the page shows as a toast.
type groupReply struct {
	Results []groupResult `json:"results"`
	Paused  int           `json:"paused"`
	Resumed int           `json:"resumed"`
	Asked   int           `json:"asked"`
	Waiting int           `json:"waiting"`
	Skipped int           `json:"skipped"`
	Summary string        `json:"summary"`
}

// groupVerb is one of the two actions: its name in the activity log, the colour of that row when
// something was done, what it does to one agent, and the sentence it ends with.
type groupVerb struct {
	title     string
	chip      string
	one       func(*models.LiveAgent) groupResult
	summarise func(groupReply) string
}

func (a *api) interruptGroup(w http.ResponseWriter, r *http.Request) {
	a.group(w, r, groupVerb{"Pause everyone", "amber", a.pauseOne, pauseSummary})
}

func (a *api) continueGroup(w http.ResponseWriter, r *http.Request) {
	a.group(w, r, groupVerb{"Continue everyone", "ok", a.continueOne, continueSummary})
}

// cleanIDs drops blanks and repeats, keeping the order the page sent.
func cleanIDs(ids []string) []string {
	seen := map[string]bool{}
	clean := make([]string, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		clean = append(clean, id)
	}
	return clean
}

// group runs one action on every agent the body names, writes one row to the activity log for the
// whole group, and tells the person once.
func (a *api) group(w http.ResponseWriter, r *http.Request, verb groupVerb) {
	var body groupBody
	if !readJSON(w, r, &body) {
		return
	}
	ids := cleanIDs(body.IDs)
	switch {
	case len(ids) == 0:
		writeError(w, http.StatusBadRequest, "ids must name at least one agent")
		return
	case len(ids) > maxGroup:
		writeError(w, http.StatusBadRequest, fmt.Sprintf("ids can name at most %d agents", maxGroup))
		return
	}
	var reply groupReply
	err := a.engine.Do(func() {
		var seen []*models.LiveAgent
		a.engine.Quietly(func() {
			for _, id := range ids {
				agent := a.engine.Agent(id)
				if agent == nil {
					reply.Results = append(reply.Results,
						groupResult{ID: id, Outcome: outcomeSkipped, Why: "has left the office"})
					continue
				}
				seen = append(seen, agent)
				reply.Results = append(reply.Results, verb.one(agent))
			}
		})
		reply.count()
		reply.Summary = verb.summarise(reply)
		chip := verb.chip
		if reply.Paused+reply.Resumed+reply.Asked+reply.Waiting == 0 {
			chip = ""
		}
		a.engine.Log("Everyone", models.LogInstruction, verb.title+a.inProject(seen), reply.outcome(), chip)
		a.engine.Toast(reply.Summary)
	})
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, reply)
}

// count fills in the totals from the results.
func (g *groupReply) count() {
	for _, result := range g.Results {
		switch result.Outcome {
		case outcomePaused:
			g.Paused++
		case outcomeResumed:
			g.Resumed++
		case outcomeAsked:
			g.Asked++
		case outcomeWaiting:
			g.Waiting++
		default:
			g.Skipped++
		}
	}
}

// outcome is the short line in the activity log's Outcome column.
func (g groupReply) outcome() string {
	var parts []string
	for _, part := range []struct {
		n    int
		said string
	}{
		{g.Paused, "paused"}, {g.Resumed, "resumed"}, {g.Asked, "asked"},
		{g.Waiting, "waiting for you"}, {g.Skipped, "left alone"},
	} {
		if part.n > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", part.n, part.said))
		}
	}
	if len(parts) == 0 {
		return "Nothing to do"
	}
	text := strings.Join(parts, ", ")
	return strings.ToUpper(text[:1]) + text[1:]
}

// inProject names the project when every agent in the group works in the same one: " in Checkout
// revamp". Otherwise it says nothing, as the group is the whole office or a mixed view.
func (a *api) inProject(agents []*models.LiveAgent) string {
	var shared string
	for _, agent := range agents {
		if agent.Project == nil || (shared != "" && *agent.Project != shared) {
			return ""
		}
		shared = *agent.Project
	}
	if project := a.engine.Project(shared); project != nil {
		return " in " + project.Name
	}
	return ""
}

// cannotPause says why an agent isn't asked to pause, as a clause after its name, or "" when it
// can be. Only an agent that is working is paused. One waiting on an approval or an answer is left
// exactly as it is.
func cannotPause(agent *models.LiveAgent) string {
	switch {
	case agent.Leaving:
		return "is leaving the office"
	case agent.State == models.StateApproval || agent.Approval != nil:
		return "is waiting for your approval"
	case agent.Asking():
		return "is waiting for your answer"
	case agent.State == models.StatePaused:
		return "is already paused"
	case agent.State == models.StateError:
		return "stopped with an error"
	case !agent.State.Active():
		return "has nothing running"
	}
	return ""
}

// askedHow says what asking an agent to pause does, for the connector that runs it, as a clause
// after its name. Their Interrupts differ: only the demo stops at once.
func askedHow(agent *models.LiveAgent) string {
	switch agent.Source {
	case claudecode.Source:
		return "stops at its next step"
	case codex.Source:
		return "is ending its turn"
	case hub.Source:
		return "was asked, and its app decides"
	}
	return "was asked to pause"
}

// pauseOne asks one agent to pause, through its connector's Interrupt, if it can be paused.
func (a *api) pauseOne(agent *models.LiveAgent) groupResult {
	result := groupResult{ID: agent.ID, Name: agent.Name}
	connector := a.engine.ConnectorFor(agent)
	switch why := cannotPause(agent); {
	case why != "":
		result.Outcome, result.Why = outcomeSkipped, why
	case connector == nil:
		result.Outcome, result.Why = outcomeSkipped, "isn't connected to Mabari"
	default:
		connector.Interrupt(agent)
		if agent.State == models.StatePaused {
			result.Outcome = outcomePaused
		} else {
			result.Outcome, result.Why = outcomeAsked, askedHow(agent)
		}
	}
	return result
}

// continueOne carries on one agent this pause stopped. An agent that isn't paused any more, such
// as one the person continued by hand, is left alone. A Claude Code agent still working may have
// been asked to pause without reaching its next step yet, and its Continue lifts that.
func (a *api) continueOne(agent *models.LiveAgent) groupResult {
	result := groupResult{ID: agent.ID, Name: agent.Name}
	connector := a.engine.ConnectorFor(agent)
	skip := func(why string) groupResult {
		result.Outcome, result.Why = outcomeSkipped, why
		return result
	}
	switch {
	case connector == nil:
		return skip("isn't connected to Mabari")
	case agent.State == models.StateApproval || agent.Approval != nil:
		return skip("is waiting for your approval")
	case agent.Asking():
		return skip("is waiting for your answer")
	case agent.State == models.StatePaused:
		a.carryOn(connector, agent)
		switch {
		case agent.State.Active():
			result.Outcome = outcomeResumed
		case agent.State == models.StatePaused:
			result.Outcome, result.Why = outcomeAsked, "was asked to carry on, and its app decides"
		default:
			result.Outcome = outcomeWaiting
			result.Why = "ended its turn, so type in its session to carry on"
		}
		return result
	case agent.Source == claudecode.Source && agent.State.Active():
		connector.Continue(agent)
		result.Outcome, result.Why = outcomeResumed, "had not reached its pause, which is lifted"
		return result
	}
	return skip("isn't paused any more")
}

// carryOn continues a paused agent and notes it in its steps, as Continue on its own does.
func (a *api) carryOn(connector events.Connector, agent *models.LiveAgent) {
	connector.Continue(agent)
	a.engine.AddEvent(agent, "start", "Continued by you, with everyone, from where it stopped", nil)
}

// names lists up to three of them, "Atlas, Mori and Quill", and counts the rest.
func names(listed []string) string {
	const shown = 3
	if len(listed) > shown {
		return fmt.Sprintf("%s and %d more", strings.Join(listed[:shown], ", "), len(listed)-shown)
	}
	if len(listed) < 2 {
		return strings.Join(listed, "")
	}
	return strings.Join(listed[:len(listed)-1], ", ") + " and " + listed[len(listed)-1]
}

// agentCount is "1 agent" or "3 agents".
func agentCount(n int) string {
	if n == 1 {
		return "1 agent"
	}
	return fmt.Sprintf("%d agents", n)
}

// said lists what happened to the agents with one outcome, each with its reason: "Quill stops at
// its next step and Bolt was asked, and its app decides".
func (g groupReply) said(outcome string) string {
	var parts []string
	for _, result := range g.Results {
		if result.Outcome != outcome || result.Name == "" {
			continue
		}
		parts = append(parts, strings.TrimSpace(result.Name+" "+result.Why))
	}
	return names(parts)
}

// left counts the agents named that had already gone.
func (g groupReply) left() int {
	n := 0
	for _, result := range g.Results {
		if result.Outcome == outcomeSkipped && result.Name == "" {
			n++
		}
	}
	return n
}

// summary is the sentence for the toast and the reply, the same for both.
func (g groupReply) summary(did, nobody string) string {
	var sentences []string
	if g.Paused+g.Resumed > 0 {
		sentences = append(sentences, did+" "+agentCount(g.Paused+g.Resumed)+".")
	} else {
		sentences = append(sentences, nobody)
	}
	if said := g.said(outcomeAsked); said != "" {
		sentences = append(sentences, "Only asked: "+said+".")
	}
	if said := g.said(outcomeWaiting); said != "" {
		sentences = append(sentences, said+".")
	}
	if said := g.said(outcomeSkipped); said != "" {
		sentences = append(sentences, "Left alone: "+said+".")
	}
	if gone := g.left(); gone > 0 {
		sentences = append(sentences, fmt.Sprintf("%s had left the office.", agentCount(gone)))
	}
	return strings.Join(sentences, " ")
}

func pauseSummary(g groupReply) string {
	return g.summary("Paused", "Nobody was paused.")
}

func continueSummary(g groupReply) string {
	return g.summary("Resumed", "Nobody was resumed.")
}
