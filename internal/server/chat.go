// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/SamsonIdowu/mabari/internal/connectors/claudecode"
	"github.com/SamsonIdowu/mabari/internal/connectors/simulator"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/workspace"
)

// The message box on the Chats screen. One route sends for it, whether the message is for an agent
// or for a project, so what it can ask for (a plan first, another model, files, another agent's
// last reply) is worked out in one place, on the server. Nothing in a message can settle an
// approval: it is text, and it goes the way every instruction goes.

func (a *api) chatRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/chat/send", a.chatSend)
	mux.HandleFunc("GET /api/chat/files", a.chatFiles)
	mux.HandleFunc("GET /api/chat/commands", a.chatCommands)
	mux.HandleFunc("POST /api/attachments", a.saveAttachment)
	mux.HandleFunc("GET /api/saved-instructions", a.listSaved)
	mux.HandleFunc("POST /api/saved-instructions", a.createSaved)
	mux.HandleFunc("DELETE /api/saved-instructions/{id}", a.deleteSaved)
	mux.HandleFunc("POST /api/agents/{id}/hand", a.handReply)
	mux.HandleFunc("GET /api/projects/{id}/asks", a.listAsks)
}

// planFirst is what a message says when the session can't be put in plan mode, which only a session
// Mabari runs can be. It asks for a plan in words, and is only as strong as the agent's obedience.
const planFirst = "Plan first. Write out your plan and wait for my go-ahead before you change anything.\n\n"

// mentionKept is how much of another agent's reply goes into a message that mentions it.
const mentionKept = 6000

type chatBody struct {
	AgentID   string `json:"agentId"`
	ProjectID string `json:"projectId"`
	Text      string `json:"text"`
	// Plan asks the agent to plan before it acts.
	Plan bool `json:"plan"`
	// Model switches the session's model with this message, where the session allows it.
	Model string `json:"model"`
	// Now interrupts a working session Mabari runs and sends this straight after.
	Now bool `json:"now"`
	// Everyone sends a project's message to every agent there, and records it for the side by side
	// view of their replies.
	Everyone    bool     `json:"everyone"`
	Attachments []string `json:"attachments"`
	// Mentions are agents whose latest reply goes in as context.
	Mentions []string `json:"mentions"`
}

// chatResult is the reply to POST /api/chat/send.
type chatResult struct {
	Notice string `json:"notice"`
	// AgentID took the message, or is empty when it went to several or Claude Code is opening.
	AgentID       string `json:"agentId"`
	InstructionID string `json:"instructionId"`
	Queued        bool   `json:"queued"`
	Opened        bool   `json:"opened"`
	// Ask is set for a message sent to everyone on a project.
	Ask *Ask `json:"ask"`
}

// composed is a message with everything the box added to it, ready to send.
type composed struct {
	text string
	// files are the attached files named in text.
	files []string
	// problem is why it can't go, worded for the person.
	problem string
}

// compose adds the attachments and mentioned replies to what was typed. Call inside Do, because it
// reads the conversations.
func (a *api) compose(body chatBody, self string) composed {
	text := strings.TrimSpace(body.Text)
	if problem := messageProblem(text); problem != "" {
		return composed{problem: problem}
	}
	var blocks []string
	seen := map[string]bool{}
	for _, id := range body.Mentions {
		agent := a.engine.Agent(id)
		if agent == nil || id == self || seen[id] || len(seen) >= 5 {
			continue
		}
		seen[id] = true
		reply := a.latestReply(id)
		if reply == "" {
			blocks = append(blocks, agent.Name+" hasn't replied yet.")
			continue
		}
		blocks = append(blocks, "Context, "+agent.Name+"'s latest reply:\n"+quote(ellipsize(reply, mentionKept)))
	}
	files := a.attachmentPaths(body.Attachments)
	if len(files) > 0 {
		blocks = append(blocks, "Attached files, read them by path:\n- "+strings.Join(files, "\n- "))
	}
	if len(blocks) > 0 {
		text += "\n\n" + strings.Join(blocks, "\n\n")
	}
	if body.Plan {
		text = planFirst + text
	}
	if len(text) > maxPrompt*2 {
		return composed{problem: "That's too long to send with what is attached. Cut it down."}
	}
	return composed{text: text, files: files}
}

// allowAttached lets this agent's session read the files sent to it with no click, before it hears
// of them. Other sessions, and everything else, still ask. Call inside Do.
func (a *api) allowAttached(agent *models.LiveAgent, files []string) {
	if a.claude != nil && len(files) > 0 && agent.Source == claudecode.Source {
		a.claude.Connector.AllowAttached(agent.ID, files)
	}
}

// quote marks each line as quoted, so an agent reads it as someone else's words, and an @ in them
// can't work as a file mention in the prompt they land in.
func quote(text string) string {
	lines := strings.Split(strings.TrimSpace(models.InertMentions(text)), "\n")
	for index, line := range lines {
		lines[index] = "> " + line
	}
	return strings.Join(lines, "\n")
}

func ellipsize(text string, limit int) string {
	if utf8.RuneCountInString(text) <= limit {
		return text
	}
	return string([]rune(text)[:limit]) + "…"
}

// latestReply is the last thing an agent said, from its stored conversation. Call inside Do.
func (a *api) latestReply(agentID string) string {
	items, _, err := a.engine.Store().Conversation(context.Background(), agentID, 0, 60)
	if err != nil {
		return ""
	}
	for index := len(items) - 1; index >= 0; index-- {
		item := items[index]
		if item.Kind == models.ConversationAssistant && item.Parent == "" && strings.TrimSpace(item.Text) != "" {
			return item.Text
		}
	}
	return ""
}

// chatSend is POST /api/chat/send.
func (a *api) chatSend(w http.ResponseWriter, r *http.Request) {
	var body chatBody
	if !readJSON(w, r, &body) {
		return
	}
	if (body.AgentID == "") == (body.ProjectID == "") {
		writeError(w, http.StatusBadRequest, "say whether the message is for an agent or a project")
		return
	}
	if body.AgentID != "" {
		a.chatToAgent(w, body)
		return
	}
	a.chatToProject(w, body)
}

func (a *api) chatToAgent(w http.ResponseWriter, body chatBody) {
	var result chatResult
	var status int
	var problem string
	var trust *folderTrust
	if err := a.engine.Do(func() {
		agent := a.engine.Agent(body.AgentID)
		switch {
		case agent == nil:
			status, problem = http.StatusNotFound, "no such agent"
			return
		case agent.Leaving:
			status, problem = http.StatusConflict, agent.Name+" is leaving the office."
			return
		}
		// A session that needs a new process can't have one in a folder that brings more than the
		// person agreed to, so they are asked now, while the message can simply be sent again.
		if a.claude != nil && agent.Source == claudecode.Source {
			var changed claudecode.FolderChanged
			if errors.As(a.claude.Connector.CanCarryOn(agent), &changed) {
				trust = &folderTrust{Folder: changed.Folder, Found: changed.Found}
				return
			}
		}
		sent := a.compose(chatBody{
			Text: body.Text, Attachments: body.Attachments, Mentions: body.Mentions,
		}, agent.ID)
		if sent.problem != "" {
			status, problem = http.StatusBadRequest, sent.problem
			return
		}
		a.allowAttached(agent, sent.files)
		result, status, problem = a.sendTo(agent, sent.text, body)
	}); err != nil {
		internalError(w, err)
		return
	}
	if trust != nil {
		writeTrustNeeded(w, trust)
		return
	}
	if problem != "" {
		writeError(w, status, problem)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// sendTo delivers a composed message to one agent, applying the plan, model and now choices. Call
// inside Do.
func (a *api) sendTo(agent *models.LiveAgent, text string, body chatBody) (chatResult, int, string) {
	known := a.instructionIDs()
	runs := a.claude != nil && agent.Source == claudecode.Source && agent.RunsHere() && agent.Lead == nil
	// Claude Code holds a session to plan mode, so that is asked for there when it can be. Anywhere
	// else, and in the middle of a turn, the plan is only asked for in words.
	inMode := runs && body.Plan && claudecode.CanPlan(agent)
	if body.Plan && !inMode {
		text = planFirst + text
	}
	switch {
	case runs:
		if err := a.claude.Connector.InstructWith(agent, text, claudecode.SendOptions{
			Plan: inMode, Model: body.Model, Now: body.Now,
		}); err != nil {
			var unknown claudecode.UnknownModel
			if errors.As(err, &unknown) {
				return chatResult{}, http.StatusBadRequest, err.Error()
			}
			return chatResult{}, http.StatusConflict, err.Error()
		}
	default:
		if body.Model != "" && body.Model != agent.Model {
			if problem := a.switchModel(agent, body.Model); problem != "" {
				return chatResult{}, http.StatusConflict, problem
			}
		}
		if connector := a.engine.ConnectorFor(agent); connector != nil {
			connector.Instruct(agent, text)
		}
	}
	where := a.whereIs(agent, known)
	result := chatResult{AgentID: agent.ID, InstructionID: where.InstructionID, Queued: where.Queued}
	if where.Queued {
		result.Notice = "Queued for " + agent.Name + ". It gets it at its next checkpoint."
	} else {
		result.Notice = "Sent to " + agent.Name + "."
	}
	return result, http.StatusOK, ""
}

// switchModel changes the model of an agent whose session isn't one Mabari runs, where that is true
// to say: only the demo's agents, which have no real session. Everyone else's model is fixed when
// its session starts. It returns why not, or "". Call inside Do.
func (a *api) switchModel(agent *models.LiveAgent, model string) string {
	if agent.Source != simulator.Source {
		return agent.Name + "'s model is fixed when its session starts. Only a session Mabari runs can switch."
	}
	if !modelOffered(agent, model) {
		return model + " isn't one of the models for " + agent.Name + "'s account."
	}
	agent.Model = model
	a.engine.AddEvent(agent, "instruction", "Model changed to "+model, nil)
	a.engine.Log(agent.Name, models.LogInstruction, "Switch model to "+model, "Applied", "ok")
	a.engine.Touch(agent)
	return ""
}

func modelOffered(agent *models.LiveAgent, model string) bool {
	for _, offered := range models.Models[agent.Account] {
		if offered == model {
			return true
		}
	}
	return false
}

func (a *api) chatToProject(w http.ResponseWriter, body chatBody) {
	if body.Everyone {
		a.askEveryone(w, body)
		return
	}
	var sent composed
	var found bool
	if err := a.engine.Do(func() {
		found = a.engine.Project(body.ProjectID) != nil
		if found {
			sent = a.compose(chatBody{
				Text: body.Text, Attachments: body.Attachments, Mentions: body.Mentions, Plan: body.Plan,
			}, "")
		}
	}); err != nil {
		internalError(w, err)
		return
	}
	switch {
	case !found:
		writeError(w, http.StatusNotFound, "no such project")
	case sent.problem != "":
		writeError(w, http.StatusBadRequest, sent.problem)
	default:
		a.sendProject(w, body.ProjectID, sent.text, sent.files)
	}
}

// folderOf is the folder an agent or a project works in, as a full path that exists, or "". It is
// found from the id, never from a path the page sends. Call inside Do.
func (a *api) folderOf(agentID, projectID string) string {
	folder := ""
	switch {
	case agentID != "":
		if agent := a.engine.Agent(agentID); agent != nil {
			folder = agent.Folder
		}
	case projectID != "":
		if project := a.engine.Project(projectID); project != nil && project.Repository != nil {
			folder = project.Repository.Path
		}
	}
	if folder == "" {
		return ""
	}
	path, err := workspace.Expand(folder)
	if err != nil {
		return ""
	}
	// The folder is the one Mabari already has for the agent or project, not one the page names.
	if info, err := os.Stat(path); err != nil || !info.IsDir() { // #nosec G703 -- see above
		return ""
	}
	return path
}

// configDir is Claude Code's settings folder, for the account's commands and skills.
func (a *api) configDir() string {
	switch {
	case a.claude != nil && a.claude.ConfigDir != "":
		return a.claude.ConfigDir
	case a.claude != nil:
		dir, _ := claudecode.ConfigDir(os.Getenv)
		return dir
	}
	return ""
}

// dataPath is a path inside Mabari's data folder, or "" when the server has none.
func (a *api) dataPath(parts ...string) string {
	if a.dataDir == "" {
		return ""
	}
	return filepath.Join(append([]string{a.dataDir}, parts...)...)
}
