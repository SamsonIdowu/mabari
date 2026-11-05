// SPDX-License-Identifier: Apache-2.0

// Package models holds the data model. These structs are the source of truth: tygo generates
// web/src/gen/models.ts from them, so run `make gen` after changing this package.
package models

// Provider is who made an agent's model. It decides the agent's colour.
type Provider string

// Providers.
const (
	ProviderClaude Provider = "claude"
	ProviderOpenAI Provider = "openai"
	ProviderCustom Provider = "custom"
)

// AgentState is what an agent is doing right now.
type AgentState string

// Agent states.
const (
	StateThinking AgentState = "thinking"
	StateReading  AgentState = "reading"
	StateEditing  AgentState = "editing"
	StateRunning  AgentState = "running"
	StateBrowsing AgentState = "browsing"
	StateApproval AgentState = "approval"
	StateSpawning AgentState = "spawning"
	StateIdle     AgentState = "idle"
	StateDone     AgentState = "done"
	StateError    AgentState = "error"
	StatePaused   AgentState = "paused"
)

// Active reports whether the agent is working, as opposed to waiting or finished.
func (s AgentState) Active() bool {
	switch s {
	case StateThinking, StateReading, StateEditing, StateRunning, StateBrowsing, StateSpawning:
		return true
	default:
		return false
	}
}

// AccountKind is a way of connecting agents.
type AccountKind string

// Account kinds.
const (
	AccountCodex        AccountKind = "codex"
	AccountClaudeCode   AccountKind = "claude_code"
	AccountAnthropicKey AccountKind = "anthropic_key"
	AccountOpenAIKey    AccountKind = "openai_key"
	AccountHub          AccountKind = "hub"
)

// AccountStatus is the state of an account connection.
type AccountStatus string

// Account statuses.
const (
	AccountOff        AccountStatus = "off"
	AccountConnecting AccountStatus = "connecting"
	AccountConnected  AccountStatus = "connected"
	AccountExpired    AccountStatus = "expired"
	AccountStale      AccountStatus = "stale"
)

// Repository is the code a project works on.
type Repository struct {
	Path   string  `json:"path"`
	URL    *string `json:"url"`
	Branch *string `json:"branch"`
}

// Project groups agents around a piece of work.
type Project struct {
	ID           string      `json:"id"`
	Name         string      `json:"name"`
	Color        string      `json:"color"`
	Instructions string      `json:"instructions"`
	Files        []string    `json:"files"`
	Repository   *Repository `json:"repository"`
	CreatedAt    int64       `json:"createdAt"`
	// Done is the completion summary, or null while the project is open.
	Done *ProjectDone `json:"done"`
	// Status, Progress and Estimate are computed by the server from the project's agents.
	Status   ProjectStatus `json:"status"`
	Progress float64       `json:"progress"`
	// Estimate is when the project's working agents should finish, or null if none are working.
	Estimate *Estimate `json:"estimate"`
	// Opening are prompts waiting for a Claude Code session Mabari opened in the project's folder.
	// The first session to start there takes the oldest, as if it had been sent to it.
	Opening []Instruction `json:"opening"`
}

// ProjectStatus says where a project stands.
type ProjectStatus string

// Project statuses.
const (
	ProjectNew       ProjectStatus = "new"
	ProjectActive    ProjectStatus = "active"
	ProjectNeeds     ProjectStatus = "needs"
	ProjectIdle      ProjectStatus = "idle"
	ProjectReady     ProjectStatus = "ready"
	ProjectCompleted ProjectStatus = "done"
)

// ProjectDone summarises a completed project.
type ProjectDone struct {
	At     int64    `json:"at"`
	Agents int      `json:"agents"`
	Mins   int      `json:"mins"`
	Cost   float64  `json:"cost"`
	Tasks  []string `json:"tasks"`
}

// Account is a connection that agents come from.
type Account struct {
	ID          string        `json:"id"`
	Kind        AccountKind   `json:"kind"`
	Status      AccountStatus `json:"status"`
	Email       *string       `json:"email"`
	Models      []string      `json:"models"`
	LastEventAt *int64        `json:"lastEventAt"`
}

// Agent is an agent's identity and settings.
type Agent struct {
	ID       string      `json:"id"`
	Project  *string     `json:"projectId"`
	Name     string      `json:"name"`
	Provider Provider    `json:"provider"`
	Model    string      `json:"model"`
	Account  AccountKind `json:"account"`
	// Source is the connector that reports this agent, such as "sim".
	Source string `json:"source"`
	// Lead is the agent whose office this subagent works in, or null for a lead.
	Lead *string `json:"leadId"`
	// SubModel is the model this agent's subagents use, or "inherit" for its own.
	SubModel     string   `json:"subModel"`
	Desk         int      `json:"desk"`
	Folder       string   `json:"folder"`
	AllowedTools []string `json:"allowedTools"`
	DailyCostCap *float64 `json:"dailyCostCap"`
	Hue          string   `json:"hue"`
	Skin         string   `json:"skin"`
	Hair         string   `json:"hair"`
	CreatedAt    int64    `json:"createdAt"`
	// DefID is the agent definition it was started from, or empty.
	DefID string `json:"defId"`
	// Workflow marks a workflow sub-agent: one not started from an agent definition file, such
	// as a Claude Code session opened in a terminal, an editor, on the web or in the Claude app,
	// or a subagent whose type matches no loaded definition.
	Workflow bool `json:"workflow"`
	// Bench seats the agent in the workflow sub-agents' area, where Desk counts bench seats. A
	// workflow lead sits there, and its subagents sit with it.
	Bench bool `json:"bench"`
}

// SessionState is what an agent is doing and how far along it is.
type SessionState struct {
	State AgentState `json:"state"`
	Task  string     `json:"task"`
	// Progress runs from 0 to 1.
	Progress float64 `json:"progress"`
	// Rate is progress per office second, which drives the estimate.
	Rate float64 `json:"rate"`
	// Working is true while the agent is at work, as opposed to waiting or finished. It counts
	// agents that report no progress rate, such as Claude Code sessions.
	Working bool `json:"working"`
	// Estimate is null unless the agent is working and reports a rate. See EstimateFor.
	Estimate *Estimate `json:"estimate"`
	// TeamEstimate is when a lead and its subagents should all be done, or null if it has none.
	TeamEstimate *Estimate `json:"teamEstimate"`
	Elapsed      int64     `json:"elapsed"`
	TokensIn     int64     `json:"tokensIn"`
	TokensOut    int64     `json:"tokensOut"`
	Cost         float64   `json:"cost"`
	Error        string    `json:"error"`
	// Files are what the agent is working on, used by tool feeds and the dispatcher.
	Files []string `json:"files"`
	// Bubble is what the speech bubble says now, and BubbleKind is "", "reply" or "talk".
	Bubble     string `json:"bubble"`
	BubbleKind string `json:"bubbleKind"`
	Reply      string `json:"reply"`
	ReplyUntil int64  `json:"replyUntil"`
	Talk       string `json:"talk"`
	TalkUntil  int64  `json:"talkUntil"`
	TalkColor  string `json:"talkColor"`
	Leaving    bool   `json:"leaving"`
	// PausedFrom is the state an interrupted agent was in, so Continue can return to it.
	PausedFrom AgentState `json:"pausedFrom"`
	// Asked are the latest instructions sent from Mabari that reached the agent, oldest first,
	// each with the agent's reply once it gives one. At most AskedKept.
	Asked []Instruction `json:"asked"`
}

// AskedKept is how many instructions and replies an agent keeps for its panel.
const AskedKept = 10

// ReplyLimit caps a stored reply. A longer one is cut and says so.
const ReplyLimit = 20000

// LiveAgent is an agent as the UI sees it: identity, session, and what is waiting on it.
type LiveAgent struct {
	Agent        `tstype:",extends"`
	SessionState `tstype:",extends"`
	// Feed is the newest events first. Live updates leave it out and send events separately.
	Feed     []Event       `json:"feed"`
	Queued   []Instruction `json:"queued"`
	Approval *Approval     `json:"approval"`
}

// Event is one thing an agent did, such as a tool call.
type Event struct {
	ID      string `json:"id"`
	Agent   string `json:"agentId"`
	Time    int64  `json:"time"`
	Tool    string `json:"tool"`
	Summary string `json:"summary"`
	Raw     any    `json:"raw" tstype:"unknown"`
}

// MessageKind is the kind of message agents send each other.
type MessageKind string

// Message kinds.
const (
	MessageHandoff   MessageKind = "handoff"
	MessageQuestion  MessageKind = "question"
	MessageAnswer    MessageKind = "answer"
	MessageReport    MessageKind = "report"
	MessageReview    MessageKind = "review"
	MessageBroadcast MessageKind = "broadcast"
)

// Message is something one agent said to others.
type Message struct {
	ID       string      `json:"id"`
	From     string      `json:"fromAgent"`
	To       []string    `json:"toAgents"`
	FromName string      `json:"fromName"`
	ToName   string      `json:"toName"`
	Project  *string     `json:"projectId"`
	Kind     MessageKind `json:"kind"`
	Text     string      `json:"text"`
	Time     int64       `json:"time"`
}

// InstructionMode says whether a message should act or only ask.
type InstructionMode string

// Instruction modes.
const (
	ModeInstruct InstructionMode = "instruct"
	ModeQuery    InstructionMode = "query"
)

// InstructionStatus is how far an instruction has got.
type InstructionStatus string

// Instruction statuses.
const (
	InstructionDelivered InstructionStatus = "delivered"
	InstructionWaiting   InstructionStatus = "waiting_for_checkpoint"
	InstructionAnswered  InstructionStatus = "answered"
	// InstructionRemoved is an instruction the user took back before it was delivered.
	InstructionRemoved InstructionStatus = "removed"
)

// OpeningKept is how long a prompt waits for the Claude Code session Mabari opened for it, in
// milliseconds. A session that never reports, say because its window was closed, doesn't keep
// the prompt for ever.
const OpeningKept = 15 * 60 * 1000

// Instruction is a message from the user.
type Instruction struct {
	ID string `json:"id"`
	// Agent is null when the dispatcher chooses the agent.
	Agent  *string           `json:"agentId"`
	Text   string            `json:"text"`
	Mode   InstructionMode   `json:"mode"`
	Status InstructionStatus `json:"status"`
	Time   int64             `json:"time"`
	// LogID is the activity log row this instruction updates.
	LogID string `json:"logId"`
	// Reply is what the agent said back once it had the instruction, in full, with anything that
	// looks like a secret masked. Empty until it replies.
	Reply     string `json:"reply"`
	RepliedAt int64  `json:"repliedAt"`
}

// ApprovalType is what an agent is asking permission for.
type ApprovalType string

// Approval types.
const (
	ApprovalCommand ApprovalType = "command"
	ApprovalFile    ApprovalType = "file"
	ApprovalPlan    ApprovalType = "plan"
)

// RiskLevel says whether an action can pass low risk auto approve.
type RiskLevel string

// Risk levels.
const (
	RiskLow  RiskLevel = "low"
	RiskHigh RiskLevel = "high"
)

// Decisions on an approval, and who made them.
const (
	DecisionAllowed = "allowed"
	DecisionDenied  = "denied"
	// DecisionCancelled settles an approval nobody decided, because the agent stopped or asked
	// for something else first. It is never sent to the agent.
	DecisionCancelled = "cancelled"
	DecidedByUser     = "user"
	DecidedByAuto     = "auto"
)

// Approval is a risky action waiting for a decision.
type Approval struct {
	ID     string         `json:"id"`
	Agent  string         `json:"agentId"`
	Type   ApprovalType   `json:"type"`
	Title  string         `json:"title"`
	Detail ApprovalDetail `json:"detail"`
	// Risk explains the risk in plain words on the approval card.
	Risk      string    `json:"risk"`
	RiskLevel RiskLevel `json:"riskLevel"`
	Time      int64     `json:"time"`
	// Decision is null until someone decides: "allowed" or "denied".
	Decision *string `json:"decision"`
	// DecidedBy is "user" or "auto".
	DecidedBy *string `json:"decidedBy"`
}

// DiffLine is one line of a file change. Kind is "ctx", "add" or "del".
type DiffLine struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
}

// ApprovalDetail is what the approval card shows, depending on its type.
type ApprovalDetail struct {
	Cmd     string     `json:"cmd,omitempty"`
	Path    string     `json:"path,omitempty"`
	Lines   []DiffLine `json:"lines,omitempty"`
	Project string     `json:"project,omitempty"`
	Steps   []string   `json:"steps,omitempty"`
}

// LogType is the kind of activity log row.
type LogType string

// Log types.
const (
	LogInstruction LogType = "Instruction"
	LogQuery       LogType = "Query"
	LogApproval    LogType = "Approval"
	LogSession     LogType = "Session"
)

// LogEntry is one row of the activity log. Chip is "", "ok", "amber" or "red".
type LogEntry struct {
	ID      string  `json:"id"`
	Time    int64   `json:"time"`
	Agent   string  `json:"agent"`
	Type    LogType `json:"type"`
	Message string  `json:"message"`
	Outcome string  `json:"outcome"`
	Chip    string  `json:"chip"`
}

// AutoApprove says which approvals pass without a click.
type AutoApprove struct {
	On bool `json:"on"`
	// Scope is "safe" for low risk actions or "all" for everything.
	Scope string `json:"scope"`
}

// Settings are the user's preferences.
type Settings struct {
	QueryModel    string `json:"queryModel"`
	VoiceEngine   string `json:"voiceEngine"`
	SpokenReplies bool   `json:"spokenReplies"`
	// ApprovalSound plays a short ding when an approval needs the person. Not when a task
	// finishes, and not when auto approve settles it.
	ApprovalSound bool `json:"approvalSound"`
	RetentionDays int  `json:"retentionDays"`
	LANAccess     bool `json:"lanAccess"`
	// RequireLogin asks for the access key on this computer too, for a computer shared with others.
	RequireLogin bool              `json:"requireLogin"`
	Defaults     map[string]string `json:"defaults"`
	AutoApprove  AutoApprove       `json:"autoApprove"`
}

// Snapshot is the whole office at one moment. Apply ServerMessages with a higher Seq on top.
type Snapshot struct {
	BootID   string `json:"bootId"`
	Seq      uint64 `json:"seq"`
	FirstRun bool   `json:"firstRun"`
	// Demo is true while the demo office runs. Only then are agents simulated.
	Demo bool `json:"demo"`
	// DemoEndsAt is when the demo turns itself off, in milliseconds, or zero.
	DemoEndsAt int64       `json:"demoEndsAt"`
	Projects   []Project   `json:"projects"`
	Accounts   []Account   `json:"accounts"`
	Agents     []LiveAgent `json:"agents"`
	Messages   []Message   `json:"messages"`
	Log        []LogEntry  `json:"log"`
	Settings   Settings    `json:"settings"`
	// Defs are the agent definitions found in the agent folders on this computer.
	Defs []AgentDef `json:"defs"`
}

// DefScope says where an agent definition's file lives.
type DefScope string

// Definition scopes.
const (
	// DefAccount is ~/.claude/agents, for every project.
	DefAccount DefScope = "account"
	// DefProject is <project folder>/.claude/agents.
	DefProject DefScope = "project"
)

// DefKind is which AI's format an agent file is in.
type DefKind string

// Agent file kinds.
const (
	// DefClaude is a Claude Code subagent: Markdown with front matter, in .claude/agents.
	DefClaude DefKind = "claude"
	// DefCodex is a Codex custom agent: TOML, in .codex/agents.
	DefCodex DefKind = "codex"
)

// AgentDef is a reusable agent, read from a Claude Code Markdown file or a Codex TOML file. The
// file is the source of truth and lives on this computer: in the Claude or Codex folder for the
// whole account, or in a project's folder. Runs and Enabled come from Mabari's own state file.
type AgentDef struct {
	// ID is stable across restarts: the kind, the scope, the project for a project agent, and the
	// name.
	ID string `json:"id"`
	// Kind is the AI whose format the file is in. Empty means Claude.
	Kind        DefKind  `json:"kind"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Scope       DefScope `json:"scope"`
	// ProjectID is set for a project agent.
	ProjectID    string   `json:"projectId"`
	Model        string   `json:"model"`
	Tools        []string `json:"tools"`
	Skills       []string `json:"skills"`
	Instructions string   `json:"instructions"`
	Color        string   `json:"color"`
	Enabled      bool     `json:"enabled"`
	Runs         int      `json:"runs"`
	// Updated is when the file last changed, in milliseconds.
	Updated int64 `json:"updated"`
	// Path is the file, with the home folder written as ~.
	Path string `json:"path"`
	// System is true for Mabari, which can't be deleted or turned off.
	System bool `json:"system"`
}

// Message types sent over the WebSocket.
const (
	MsgHello    = "hello"  // First message: BootID and the current Seq.
	MsgResync   = "resync" // Reload the snapshot and keep the view: the client fell behind, or retention ran.
	MsgAgent    = "agent"  // Agent changed; it has no Feed.
	MsgRemove   = "agent.remove"
	MsgEvent    = "event"
	MsgMessage  = "message"
	MsgLog      = "log"
	MsgProject  = "project"
	MsgAccount  = "account"
	MsgSettings = "settings"
	MsgToast    = "toast"
	MsgDefs     = "defs"  // The agent definitions changed; Defs is the whole list.
	MsgReset    = "reset" // The office was replaced by a wipe or the demo: reload and clear the view.
)

// ServerMessage is one WebSocket message. Type says which of the other fields is set.
type ServerMessage struct {
	Seq      uint64     `json:"seq"`
	Type     string     `json:"type"`
	BootID   string     `json:"bootId,omitempty"`
	ID       string     `json:"id,omitempty"`
	Agent    *LiveAgent `json:"agent,omitempty"`
	Event    *Event     `json:"event,omitempty"`
	Message  *Message   `json:"message,omitempty"`
	Log      *LogEntry  `json:"log,omitempty"`
	Project  *Project   `json:"project,omitempty"`
	Account  *Account   `json:"account,omitempty"`
	Settings *Settings  `json:"settings,omitempty"`
	Defs     []AgentDef `json:"defs,omitempty"`
	Text     string     `json:"text,omitempty"`
}

// WhisperStatus is what Settings shows about Local Whisper.
type WhisperStatus struct {
	// Installed is true when whisper.cpp's whisper-cli was found.
	Installed bool `json:"installed"`
	// Ready is true when the model is downloaded and checked.
	Ready       bool   `json:"ready"`
	Downloading bool   `json:"downloading"`
	Done        int64  `json:"done"`
	Total       int64  `json:"total"`
	Error       string `json:"error"`
}
