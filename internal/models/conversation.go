// SPDX-License-Identifier: Apache-2.0

package models

import "unicode/utf8"

// ConversationKind is what one entry of an agent's conversation is.
type ConversationKind string

// Conversation kinds.
const (
	// ConversationUser is what the person said to the agent.
	ConversationUser ConversationKind = "user"
	// ConversationAssistant is what the agent said back.
	ConversationAssistant ConversationKind = "assistant"
	// ConversationTool is a tool call and, once it has one, its result.
	ConversationTool ConversationKind = "tool"
	// ConversationNotice is something that happened to the session itself: it started, it was
	// resumed, it stopped with an error.
	ConversationNotice ConversationKind = "notice"
)

// ToolCallState is how far a tool call has got.
type ToolCallState string

// Tool call states.
const (
	ToolRunning ToolCallState = "running"
	ToolDone    ToolCallState = "done"
	// ToolFailed is a call that ran and failed.
	ToolFailed ToolCallState = "failed"
	// ToolDenied is a call that never ran, because a person or a rule said no.
	ToolDenied ToolCallState = "denied"
)

// Who said a user item.
const (
	// SaidInMabari is a message sent from Mabari.
	SaidInMabari = "mabari"
	// SaidInSession is a message typed in the session's own window, read from its transcript.
	SaidInSession = "session"
)

// ToolCall is what an agent asked a tool to do and what came back. Input and Output have secrets
// masked and are cut to ConversationToolLimit.
type ToolCall struct {
	Name string `json:"name"`
	// Summary is one calm line about the call, such as "Read src/app.ts".
	Summary string `json:"summary"`
	// Input is the call's arguments as JSON.
	Input  string        `json:"input"`
	Output string        `json:"output"`
	State  ToolCallState `json:"state"`
}

// ConversationItem is one entry of an agent's conversation. Items are ordered by Seq, which only
// goes up for an agent. An update to an item, such as a tool call getting its result, keeps its
// ID and Seq, so a client replaces what it holds.
type ConversationItem struct {
	ID    string           `json:"id"`
	Agent string           `json:"agentId"`
	Seq   int64            `json:"seq"`
	Time  int64            `json:"time"`
	Kind  ConversationKind `json:"kind"`
	// Text is what was said, for every kind but a tool call. Secrets are masked.
	Text string `json:"text"`
	// Streaming is true while Text is still arriving. It arrives in ConversationDelta messages,
	// and the finished item replaces what was built from them.
	Streaming bool      `json:"streaming"`
	Tool      *ToolCall `json:"tool"`
	// From says who said a user item: SaidInMabari or SaidInSession.
	From string `json:"from"`
	// Parent is the tool call that started the subagent this came from, or "" for the session's
	// own conversation.
	Parent string `json:"parent"`
	// Clipped is true when some of it was cut to fit the limits.
	Clipped bool `json:"clipped"`
}

// Limits on what a conversation keeps, so one chatty session can't fill the disk or the page. A
// longer text is cut and marked Clipped. An agent's oldest items go first once it passes
// ConversationKept.
const (
	ConversationTextLimit = 100_000
	ConversationToolLimit = 16_000
	ConversationKept      = 20_000
	// ConversationPage is how many items one read returns unless it asks for fewer.
	ConversationPage = 200
	// ConversationPageMax is the most one read may ask for.
	ConversationPageMax = 500
)

// Conversation is one page of an agent's conversation, oldest first. HasMore says there is older
// history: ask again with before set to the first item's Seq.
type Conversation struct {
	AgentID string             `json:"agentId"`
	Items   []ConversationItem `json:"items"`
	HasMore bool               `json:"hasMore"`
}

// clipText cuts text to at most limit characters, reporting whether it had to.
func clipText(text string, limit int) (string, bool) {
	if len(text) <= limit || utf8.RuneCountInString(text) <= limit {
		return text, false
	}
	return string([]rune(text)[:limit]), true
}

// WithinLimits is the item cut to the limits, marked Clipped if anything was lost.
func (item ConversationItem) WithinLimits() ConversationItem {
	var cut bool
	item.Text, cut = clipText(item.Text, ConversationTextLimit)
	item.Clipped = item.Clipped || cut
	if item.Tool != nil {
		tool := *item.Tool
		var cutInput, cutOutput bool
		tool.Input, cutInput = clipText(tool.Input, ConversationToolLimit)
		tool.Output, cutOutput = clipText(tool.Output, ConversationToolLimit)
		item.Tool = &tool
		item.Clipped = item.Clipped || cutInput || cutOutput
	}
	return item
}

// SessionStatus says who has an agent's Claude Code session now.
type SessionStatus string

// Session statuses.
const (
	// SessionRunning is a session Mabari runs as a child process that is alive, working or
	// waiting for its next message.
	SessionRunning SessionStatus = "running"
	// SessionResumable is a session Mabari ran whose process has ended. Its next message starts
	// the process again with --resume, so nothing is lost.
	SessionResumable SessionStatus = "resumable"
	// SessionElsewhere is a session started somewhere else, in a terminal or an editor. Mabari
	// follows it through its hooks and reads its transcript. It may still be open there.
	SessionElsewhere SessionStatus = "elsewhere"
)

// AgentSession is the Claude Code session behind an agent.
type AgentSession struct {
	// ID is Claude Code's own session id.
	ID     string        `json:"id"`
	Status SessionStatus `json:"status"`
	// Mode is the permission mode Mabari runs it in: "default", or "plan" until the plan is
	// approved.
	Mode string `json:"mode"`
	// AgentFile is the agent it runs as, passed to --agent, or "".
	AgentFile string `json:"agentFile"`
	// Started is true once Claude Code has reported the session. Before that it may have saved
	// nothing, and --resume would fail for ever, so it starts afresh under the same id.
	Started bool `json:"started"`
	// Resume is the exact command that continues the session in a terminal.
	Resume string `json:"resume"`
	// PID is the running process, or zero. It lets a restart after a crash end what was left.
	PID int `json:"pid"`
}

// RunsHere reports whether Mabari runs this agent's session, as opposed to following one started
// elsewhere.
func (a *LiveAgent) RunsHere() bool {
	return a.Session != nil && a.Session.Status != SessionElsewhere
}
