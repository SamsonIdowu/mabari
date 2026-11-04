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
	// Estimate is when the project's working agents should finish, or null if none are working.
	Estimate *Estimate `json:"estimate"`
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
	// Lead is the agent whose office this subagent works in, or null for a lead.
	Lead *string `json:"leadId"`
	// SubModel is the model this agent's subagents use, or "inherit" for its own.
	SubModel     string   `json:"subModel"`
	Desk         int      `json:"desk"`
	Folder       string   `json:"folder"`
	AllowedTools []string `json:"allowedTools"`
	DailyCostCap *float64 `json:"dailyCostCap"`
	Hue          string   `json:"hue"`
}

// SessionState is what an agent is doing and how far along it is.
type SessionState struct {
	AgentID string     `json:"agentId"`
	State   AgentState `json:"state"`
	Task    string     `json:"task"`
	// Progress runs from 0 to 1.
	Progress float64 `json:"progress"`
	// Estimate is null unless the agent is working. See EstimateFor.
	Estimate  *Estimate `json:"estimate"`
	TokensIn  int64     `json:"tokensIn"`
	TokensOut int64     `json:"tokensOut"`
	Cost      float64   `json:"cost"`
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
	ID   string      `json:"id"`
	From string      `json:"fromAgent"`
	To   []string    `json:"toAgents"`
	Kind MessageKind `json:"kind"`
	Text string      `json:"text"`
	Time int64       `json:"time"`
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

// Approval is a risky action waiting for a decision.
type Approval struct {
	ID        string       `json:"id"`
	Agent     string       `json:"agentId"`
	Type      ApprovalType `json:"type"`
	Detail    string       `json:"detail"`
	RiskLevel RiskLevel    `json:"riskLevel"`
	// Decision is null until someone decides: "allowed" or "denied".
	Decision *string `json:"decision"`
	// DecidedBy is "user" or "auto".
	DecidedBy *string `json:"decidedBy"`
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
