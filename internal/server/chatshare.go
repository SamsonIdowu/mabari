// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// What only Mabari can do with a reply: hand it to another agent, and ask everyone on a project at
// once. Both are ordinary messages. They go the way every instruction goes, so an agent's risky
// actions still need the person's click, and neither can approve anything.

const (
	// metaAsks holds the messages sent to everyone on a project, newest last, so the side by side
	// view of the replies is still there after a reload.
	metaAsks = "chat_asks"
	asksKept = 40
	// handQuestion is how much of the request a handed over reply was answering goes with it.
	handQuestion = 600
	handReplyMax = 8000
)

// AskedAgent is an agent a message for everyone went to.
type AskedAgent struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Ask is one message sent to everyone on a project.
type Ask struct {
	ID        string       `json:"id"`
	ProjectID string       `json:"projectId"`
	Text      string       `json:"text"`
	Time      int64        `json:"time"`
	Agents    []AskedAgent `json:"agents"`
}

// allAsks reads the stored asks, oldest first. Call inside Do.
func (a *api) allAsks() []Ask {
	raw, err := a.engine.Store().Meta(context.Background(), metaAsks)
	var asks []Ask
	if err != nil || raw == "" || json.Unmarshal([]byte(raw), &asks) != nil {
		return []Ask{}
	}
	return asks
}

// listAsks is GET /api/projects/{id}/asks.
func (a *api) listAsks(w http.ResponseWriter, r *http.Request) {
	asks := []Ask{}
	if err := a.engine.Do(func() {
		for _, ask := range a.allAsks() {
			if ask.ProjectID == r.PathValue("id") {
				asks = append(asks, ask)
			}
		}
	}); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, asks)
}

// askEveryone sends one message to every agent working on a project, and records it. A subagent
// hears through its lead, and an agent that has gone wrong or is leaving is left out.
func (a *api) askEveryone(w http.ResponseWriter, body chatBody) {
	var ask Ask
	var status int
	var problem string
	var queued int
	if err := a.engine.Do(func() {
		project := a.engine.Project(body.ProjectID)
		if project == nil {
			status, problem = http.StatusNotFound, "no such project"
			return
		}
		sent := a.compose(chatBody{
			Text: body.Text, Attachments: body.Attachments, Mentions: body.Mentions, Plan: body.Plan,
		}, "")
		if sent.problem != "" {
			status, problem = http.StatusBadRequest, sent.problem
			return
		}
		var agents []*models.LiveAgent
		for _, agent := range a.inScope(scope{Project: project.ID}) {
			if agent.Lead == nil && !agent.Leaving && agent.State != models.StateError {
				agents = append(agents, agent)
			}
		}
		if len(agents) == 0 {
			status, problem = http.StatusConflict, "Nobody works on "+project.Name+" right now to ask."
			return
		}
		raw := make([]byte, 6)
		_, _ = rand.Read(raw)
		ask = Ask{ID: hex.EncodeToString(raw), ProjectID: project.ID, Text: strings.TrimSpace(body.Text), Time: a.engine.Now().UnixMilli()}
		for _, agent := range agents {
			known := a.instructionIDs()
			if connector := a.engine.ConnectorFor(agent); connector != nil {
				connector.Instruct(agent, sent.text)
			}
			if a.whereIs(agent, known).Queued {
				queued++
			}
			ask.Agents = append(ask.Agents, AskedAgent{ID: agent.ID, Name: agent.Name})
		}
		asks := append(a.allAsks(), ask)
		if len(asks) > asksKept {
			asks = asks[len(asks)-asksKept:]
		}
		a.engine.SetMeta(metaAsks, mustJSON(asks))
		a.engine.Log("You", models.LogInstruction, "Asked everyone on "+project.Name+": "+ellipsize(ask.Text, 120),
			"Sent to "+pluralAgents(len(agents)), "")
	}); err != nil {
		internalError(w, err)
		return
	}
	if problem != "" {
		writeError(w, status, problem)
		return
	}
	notice := "Asked " + pluralAgents(len(ask.Agents)) + "."
	if queued > 0 {
		notice = "Asked " + pluralAgents(len(ask.Agents)) + ". " + strconv.Itoa(queued) + " will read it at the next checkpoint."
	}
	writeJSON(w, http.StatusOK, chatResult{Notice: notice, Ask: &ask})
}

func pluralAgents(count int) string {
	if count == 1 {
		return "1 agent"
	}
	return strconv.Itoa(count) + " agents"
}

// handReply is POST /api/agents/{id}/hand: one reply goes to another agent, with where it came from
// and what it was answering, and an optional note. The text is read from the stored conversation,
// so a page can only hand over what the agent really said.
func (a *api) handReply(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ItemID string `json:"itemId"`
		To     string `json:"to"`
		Note   string `json:"note"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	var result chatResult
	var status int
	var problem string
	if err := a.engine.Do(func() {
		from, to := a.engine.Agent(r.PathValue("id")), a.engine.Agent(body.To)
		switch {
		case from == nil:
			status, problem = http.StatusNotFound, "no such agent"
			return
		case to == nil:
			status, problem = http.StatusNotFound, "That agent has left, so nothing was sent."
			return
		case to.ID == from.ID:
			status, problem = http.StatusBadRequest, "Pick another agent to hand it to."
			return
		case to.Leaving:
			status, problem = http.StatusConflict, to.Name+" is leaving the office."
			return
		}
		item := a.engine.ConversationItem(from.ID, body.ItemID)
		if item == nil || item.Kind != models.ConversationAssistant || strings.TrimSpace(item.Text) == "" {
			status, problem = http.StatusNotFound, "That reply isn't there any more."
			return
		}
		text := a.handoverText(from, *item, strings.TrimSpace(body.Note))
		if problem = messageProblem(text); problem != "" {
			status = http.StatusBadRequest
			return
		}
		result, status, problem = a.sendTo(to, text, chatBody{})
		if problem != "" {
			return
		}
		a.engine.Converse(from.ID, models.ConversationItem{
			Kind: models.ConversationNotice, Text: "Handed this reply to " + to.Name + ".",
		})
		a.engine.Log(from.Name, models.LogInstruction, "Handed a reply to "+to.Name, "Sent", "")
	}); err != nil {
		internalError(w, err)
		return
	}
	if problem != "" {
		writeError(w, status, problem)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// handoverText is what the receiving agent reads: who it is from, what it was answering, the reply
// itself as a quotation, and the person's note. Call inside Do.
func (a *api) handoverText(from *models.LiveAgent, reply models.ConversationItem, note string) string {
	var b strings.Builder
	b.WriteString("Handed over from " + from.Name)
	if from.Project != nil {
		if project := a.engine.Project(*from.Project); project != nil {
			b.WriteString(" (" + project.Name + ")")
		}
	}
	b.WriteString(".\n")
	if asked := a.requestBefore(from.ID, reply.Seq); asked != "" {
		b.WriteString("\nIt was answering:\n" + quote(ellipsize(asked, handQuestion)) + "\n")
	}
	b.WriteString("\nIts reply:\n" + quote(ellipsize(reply.Text, handReplyMax)))
	if note != "" {
		b.WriteString("\n\n" + note)
	}
	return b.String()
}

// requestBefore is the last thing the person said to an agent before one of its replies.
func (a *api) requestBefore(agentID string, seq int64) string {
	items, _, err := a.engine.Store().Conversation(context.Background(), agentID, seq, 40)
	if err != nil {
		return ""
	}
	for index := len(items) - 1; index >= 0; index-- {
		if items[index].Kind == models.ConversationUser && items[index].Parent == "" {
			return items[index].Text
		}
	}
	return ""
}
