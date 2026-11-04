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
}

// SessionState is what an agent is doing and how far along it is.
type SessionState struct {
	State AgentState `json:"state"`
	Task  string     `json:"task"`
	// Progress runs from 0 to 1.
	Progress float64 `json:"progress"`
	// Rate is progress per office second, which drives the estimate.
	Rate float64 `json:"rate"`
	// Estimate is null unless the agent is working. See EstimateFor.
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
}

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
)

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
	DecidedByUser   = "user"
	DecidedByAuto   = "auto"
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
	QueryModel    string            `json:"queryModel"`
	VoiceEngine   string            `json:"voiceEngine"`
	SpokenReplies bool              `json:"spokenReplies"`
	RetentionDays int               `json:"retentionDays"`
	LANAccess     bool              `json:"lanAccess"`
	Defaults      map[string]string `json:"defaults"`
	AutoApprove   AutoApprove       `json:"autoApprove"`
}

// Snapshot is the whole office at one moment. Apply ServerMessages with a higher Seq on top.
type Snapshot struct {
	BootID   string      `json:"bootId"`
	Seq      uint64      `json:"seq"`
	FirstRun bool        `json:"firstRun"`
	Projects []Project   `json:"projects"`
	Accounts []Account   `json:"accounts"`
	Agents   []LiveAgent `json:"agents"`
	Messages []Message   `json:"messages"`
	Log      []LogEntry  `json:"log"`
	Settings Settings    `json:"settings"`
}

// Message types sent over the WebSocket.
const (
	MsgHello    = "hello"  // First message: BootID and the current Seq.
	MsgResync   = "resync" // This client fell behind: reload the snapshot.
	MsgAgent    = "agent"  // Agent changed; it has no Feed.
	MsgRemove   = "agent.remove"
	MsgEvent    = "event"
	MsgMessage  = "message"
	MsgLog      = "log"
	MsgProject  = "project"
	MsgAccount  = "account"
	MsgSettings = "settings"
	MsgToast    = "toast"
	MsgReset    = "reset" // Too much changed to patch: reload the snapshot.
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
	Text     string     `json:"text,omitempty"`
}
