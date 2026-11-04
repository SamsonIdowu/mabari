// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"context"
	"encoding/json"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/redact"
	"github.com/SamsonIdowu/mabari/internal/risk"
)

// Source marks agents reported by Claude Code hooks.
const Source = "claude"

// StaleAfter is how long a session with work in progress may go without a hook event before the
// account shows "Hook not reporting".
const StaleAfter = 5 * time.Minute

// names are given to sessions in the order they arrive, skipping names already in the office.
var names = []string{
	"Juniper", "Pepper", "Hazel", "Wren", "Marlow", "Basil", "Clover", "Ember",
	"Iris", "Juno", "Lark", "Moss", "Olive", "Quinn", "Sorrel", "Tansy",
}

// input is what Claude Code sends a hook on stdin. Fields depend on the event.
type input struct {
	SessionID            string          `json:"session_id"`
	Cwd                  string          `json:"cwd"`
	Event                string          `json:"hook_event_name"`
	ToolName             string          `json:"tool_name"`
	ToolInput            json.RawMessage `json:"tool_input"`
	Prompt               string          `json:"prompt"`
	Source               string          `json:"source"`
	Model                string          `json:"model"`
	Reason               string          `json:"reason"`
	Message              string          `json:"message"`
	NotificationType     string          `json:"notification_type"`
	StopHookActive       bool            `json:"stop_hook_active"`
	LastAssistantMessage string          `json:"last_assistant_message"`
	AgentType            string          `json:"agent_type"`
}

// toolInput holds the tool arguments Mabari shows. Each tool uses some of them.
type toolInput struct {
	Command     string `json:"command"`
	FilePath    string `json:"file_path"`
	Path        string `json:"path"`
	Pattern     string `json:"pattern"`
	URL         string `json:"url"`
	Query       string `json:"query"`
	Description string `json:"description"`
	OldString   string `json:"old_string"`
	NewString   string `json:"new_string"`
	Content     string `json:"content"`
}

// Connector turns hook events into agents on the floor, and answers hooks with queued
// instructions and the user's approval decisions.
type Connector struct {
	engine *events.Engine
	// wait is how long a permission hook waits for a click.
	wait time.Duration

	mu        sync.Mutex
	waiting   map[string]chan models.Approval
	pause     map[string]bool
	stopped   map[string]bool
	lastEvent time.Time
}

// New returns a connector. Register it with engine.AddConnector(Source, connector).
func New(engine *events.Engine) *Connector {
	return &Connector{
		engine:  engine,
		wait:    PermissionWait * time.Second,
		waiting: map[string]chan models.Approval{},
		pause:   map[string]bool{},
		stopped: map[string]bool{},
	}
}

// SetWait changes how long a permission hook waits, for tests.
func (c *Connector) SetWait(wait time.Duration) { c.wait = wait }

var sessionChars = regexp.MustCompile(`[^A-Za-z0-9-]`)

func agentID(session string) string {
	return "cc-" + sessionChars.ReplaceAllString(session, "")
}

// Handle answers one hook call. The reply is what the hook prints: JSON for Claude Code, or
// nothing, which leaves Claude Code's normal behaviour in place.
func (c *Connector) Handle(ctx context.Context, body []byte) []byte {
	var in input
	if json.Unmarshal(body, &in) != nil || in.SessionID == "" {
		return nil
	}
	c.mu.Lock()
	c.lastEvent = time.Now()
	stopped := c.stopped[in.SessionID]
	c.mu.Unlock()
	if stopped {
		if in.Event == "SessionEnd" {
			c.mu.Lock()
			delete(c.stopped, in.SessionID)
			c.mu.Unlock()
		}
		return nil
	}
	if in.Event == "PermissionRequest" {
		return c.permission(ctx, in)
	}
	var reply []byte
	_ = c.engine.Do(func() { reply = c.observe(in) })
	return reply
}

// agentFor finds the session's agent, seating a new one if this is the first event from it.
// It returns nil when every desk is taken. Call inside Do.
func (c *Connector) agentFor(in input) *models.LiveAgent {
	id := agentID(in.SessionID)
	if agent := c.engine.Agent(id); agent != nil {
		return agent
	}
	desk := c.freeDesk()
	if desk < 0 {
		c.engine.Toast("Every desk is taken, so a new Claude Code session isn't shown.")
		return nil
	}
	agents := c.engine.Agents()
	agent := &models.LiveAgent{}
	agent.ID = id
	agent.Name = c.freshName()
	agent.Provider = models.ProviderClaude
	agent.Account = models.AccountClaudeCode
	agent.Source = Source
	agent.Model = modelName(in.Model)
	agent.SubModel = "inherit"
	agent.Desk = desk
	agent.Folder = in.Cwd
	agent.Hue = models.Hues[len(agents)%len(models.Hues)]
	agent.Skin = models.Skins[len(agents)%len(models.Skins)]
	agent.Hair = models.Hairs[(len(agents)*3)%len(models.Hairs)]
	agent.CreatedAt = c.engine.Now().UnixMilli()
	agent.State = models.StateIdle
	agent.Task = "Waiting for work"
	agent.Queued = []models.Instruction{}
	agent.Files = []string{}
	if project := c.projectFor(in.Cwd); project != "" {
		agent.Project = &project
	}
	c.engine.AddAgent(agent)
	c.engine.Log(agent.Name, models.LogSession, "Claude Code session started in "+in.Cwd,
		"Took desk "+strconv.Itoa(desk+1), "ok")
	c.connected()
	return agent
}

// connected marks the account as connected the first time a hook reports. Call inside Do.
func (c *Connector) connected() {
	for _, account := range c.engine.Accounts() {
		if account.Kind == models.AccountClaudeCode && account.Status != models.AccountConnected {
			account.Status = models.AccountConnected
			c.engine.SetAccount(account)
		}
	}
}

func (c *Connector) freeDesk() int {
	used := map[int]bool{}
	for _, agent := range c.engine.Agents() {
		used[agent.Desk] = true
	}
	for desk := range models.DeskCount {
		if !used[desk] {
			return desk
		}
	}
	return -1
}

func (c *Connector) freshName() string {
	for _, name := range names {
		if c.engine.AgentByName(name) == nil {
			return name
		}
	}
	return "Claude " + strconv.Itoa(len(c.engine.Agents())+1)
}

// projectFor picks the project whose repository folder holds the session, or the first project.
func (c *Connector) projectFor(folder string) string {
	projects := c.engine.Projects()
	for _, project := range projects {
		if repo := project.Repository; repo != nil && repo.Path != "" && within(folder, repo.Path) {
			return project.ID
		}
	}
	if len(projects) > 0 {
		return projects[0].ID
	}
	return ""
}

func within(path, folder string) bool {
	relative, err := filepath.Rel(folder, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

// modelName shortens Claude Code's model id, such as "claude-sonnet-4-5[1m]", for the name tag.
func modelName(model string) string {
	if model == "" {
		return "claude"
	}
	if cut := strings.IndexByte(model, '['); cut > 0 {
		model = model[:cut]
	}
	return model
}

// stateFor is what an agent looks like while it uses a tool.
func stateFor(tool string) models.AgentState {
	switch tool {
	case "Edit", "Write", "MultiEdit", "NotebookEdit":
		return models.StateEditing
	case "Bash", "BashOutput", "PowerShell":
		return models.StateRunning
	case "Read", "Grep", "Glob", "LS":
		return models.StateReading
	case "WebFetch", "WebSearch":
		return models.StateBrowsing
	case "Task", "Agent":
		return models.StateSpawning
	default:
		return models.StateThinking
	}
}

// summaryOf is one line about a tool call, with secrets masked.
func summaryOf(tool string, raw json.RawMessage) string {
	var args toolInput
	_ = json.Unmarshal(raw, &args)
	text := tool
	switch {
	case args.Command != "":
		text = args.Command
	case args.FilePath != "":
		text = verbFor(tool) + " " + args.FilePath
	case args.Pattern != "":
		text = "Search for " + args.Pattern
	case args.URL != "":
		text = "Open " + args.URL
	case args.Query != "":
		text = "Look up " + args.Query
	case args.Description != "":
		text = args.Description
	case args.Path != "":
		text = verbFor(tool) + " " + args.Path
	}
	return clip(redact.Text(text), 160)
}

func verbFor(tool string) string {
	switch tool {
	case "Read":
		return "Read"
	case "Write":
		return "Write"
	default:
		return "Edit"
	}
}

func clip(text string, limit int) string {
	text = strings.TrimSpace(strings.SplitN(text, "\n", 2)[0])
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit-1]) + "…"
}

// observe handles every event except permission requests. Call inside Do.
func (c *Connector) observe(in input) []byte {
	if in.Event == "SessionEnd" {
		if agent := c.engine.Agent(agentID(in.SessionID)); agent != nil {
			c.engine.Log(agent.Name, models.LogSession, "Claude Code session ended", "Left", "")
			c.engine.RemoveAgent(agent.ID)
		}
		return nil
	}
	agent := c.agentFor(in)
	if agent == nil {
		return nil
	}
	if in.Model != "" {
		agent.Model = modelName(in.Model)
	}
	c.engine.Touch(agent)
	switch in.Event {
	case "SessionStart":
		return nil
	case "UserPromptSubmit":
		agent.Task = clip(redact.Text(in.Prompt), 120)
		agent.Progress, agent.Error = 0, ""
		agent.State = models.StateThinking
		c.engine.AddEvent(agent, "prompt", "New request: "+agent.Task, nil)
		return c.deliver(agent, "UserPromptSubmit")
	case "PreToolUse":
		if c.takePause(in.SessionID) {
			agent.State = models.StatePaused
			c.engine.AddEvent(agent, "interrupt", "Paused from Mabari", nil)
			return mustJSON(map[string]any{
				"continue":   false,
				"stopReason": "Paused from Mabari. Type in this session to carry on.",
			})
		}
		agent.State = stateFor(in.ToolName)
		c.engine.AddEvent(agent, in.ToolName, summaryOf(in.ToolName, in.ToolInput), nil)
		return nil
	case "PostToolUse":
		agent.State = models.StateThinking
		return c.deliver(agent, "PostToolUse")
	case "SubagentStart":
		agent.State = models.StateSpawning
		c.engine.AddEvent(agent, "spawn", "Started a "+orDefault(in.AgentType, "helper")+" subagent", nil)
		return nil
	case "SubagentStop":
		c.engine.AddEvent(agent, "report", "A subagent finished", nil)
		return nil
	case "Notification":
		if in.NotificationType == "idle_prompt" {
			agent.State = models.StateIdle
		}
		return nil
	case "Stop":
		if reply := c.deliverAtStop(agent); reply != nil {
			return reply
		}
		agent.State = models.StateDone
		agent.Progress = 1
		if said := clip(redact.Text(in.LastAssistantMessage), 90); said != "" {
			c.engine.SetReply(agent, said, 8000)
		}
		c.engine.AddEvent(agent, "done", "Finished: "+agent.Task, nil)
		return nil
	}
	return nil
}

// deliver hands every waiting instruction to Claude as context at a checkpoint. The text reads as
// plain facts, as Claude Code's docs advise. Call inside Do.
func (c *Connector) deliver(agent *models.LiveAgent, event string) []byte {
	text := c.takeQueued(agent)
	if text == "" {
		return nil
	}
	return mustJSON(map[string]any{"hookSpecificOutput": map[string]any{
		"hookEventName": event, "additionalContext": text,
	}})
}

// deliverAtStop keeps Claude going when instructions are waiting, so they are not left until the
// user types again. Call inside Do.
func (c *Connector) deliverAtStop(agent *models.LiveAgent) []byte {
	text := c.takeQueued(agent)
	if text == "" {
		return nil
	}
	agent.State = models.StateThinking
	return mustJSON(map[string]any{"decision": "block", "reason": text})
}

func (c *Connector) takeQueued(agent *models.LiveAgent) string {
	var lines []string
	for {
		instruction, ok := c.engine.NextQueued(agent)
		if !ok {
			break
		}
		lines = append(lines, instruction.Text)
		c.engine.AddEvent(agent, "instruction", "Received: "+clip(instruction.Text, 120), nil)
	}
	if len(lines) == 0 {
		return ""
	}
	return "The user sent this from Mabari while you were working: " + strings.Join(lines, " Also: ")
}

func (c *Connector) takePause(session string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	paused := c.pause[session]
	delete(c.pause, session)
	return paused
}

// approvalFor describes a permission request for the approval card, with its risk. Risk follows
// the tool's name, never the shape of its arguments, so an unknown tool with a "command" field
// can't pass as a shell command (an MCP tool, for one). Only known tools get a low risk rule.
func approvalFor(in input) models.Approval {
	var args toolInput
	_ = json.Unmarshal(in.ToolInput, &args)
	switch in.ToolName {
	case "Bash", "PowerShell":
		verdict := risk.Classify(risk.Action{Kind: risk.KindCommand, Command: args.Command, Folder: in.Cwd})
		return models.Approval{
			Type: models.ApprovalCommand, Title: "Run a command",
			Detail: models.ApprovalDetail{Cmd: redact.Text(args.Command)},
			Risk:   verdict.Reason, RiskLevel: verdict.Level,
		}
	case "Edit", "Write", "MultiEdit", "NotebookEdit":
		path := args.FilePath
		verdict := risk.Classify(risk.Action{Kind: risk.KindEdit, Path: path, Folder: in.Cwd})
		return models.Approval{
			Type: models.ApprovalFile, Title: "Change a file",
			Detail: models.ApprovalDetail{Path: path, Lines: diffOf(args)},
			Risk:   verdict.Reason, RiskLevel: verdict.Level,
		}
	case "Read":
		verdict := risk.Classify(risk.Action{Kind: risk.KindRead, Path: args.FilePath, Folder: in.Cwd})
		return models.Approval{
			Type: models.ApprovalFile, Title: "Read a file",
			Detail: models.ApprovalDetail{Path: args.FilePath},
			Risk:   verdict.Reason, RiskLevel: verdict.Level,
		}
	default:
		return models.Approval{
			Type: models.ApprovalCommand, Title: "Use " + in.ToolName,
			Detail: models.ApprovalDetail{Cmd: summaryOf(in.ToolName, in.ToolInput)},
			Risk:   "Mabari has no rule for this tool, so it always asks.", RiskLevel: models.RiskHigh,
		}
	}
}

// maxDiffLines keeps an approval card readable.
const maxDiffLines = 40

func diffOf(args toolInput) []models.DiffLine {
	var lines []models.DiffLine
	add := func(kind, text string) {
		for _, line := range strings.Split(redact.Text(text), "\n") {
			if len(lines) < maxDiffLines {
				lines = append(lines, models.DiffLine{Kind: kind, Text: line})
			}
		}
	}
	if args.OldString != "" {
		add("del", args.OldString)
	}
	if args.NewString != "" {
		add("add", args.NewString)
	}
	if args.Content != "" {
		add("add", args.Content)
	}
	return lines
}

// permission asks the user in Mabari. It answers nothing, so Claude Code shows its own prompt,
// when nobody has Mabari open, when nobody clicks in time, or when the hook gives up.
func (c *Connector) permission(ctx context.Context, in input) []byte {
	decided := make(chan models.Approval, 1)
	id := agentID(in.SessionID)
	var (
		agent  *models.LiveAgent
		asked  bool
		answer *models.Approval
	)
	c.mu.Lock()
	c.waiting[id] = decided
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		if c.waiting[id] == decided {
			delete(c.waiting, id)
		}
		c.mu.Unlock()
	}()
	_ = c.engine.Do(func() {
		agent = c.agentFor(in)
		if agent == nil {
			return
		}
		approval := approvalFor(in)
		auto := c.engine.Settings().AutoApprove
		covered := auto.On && (auto.Scope == "all" || approval.RiskLevel == models.RiskLow)
		if !covered && !c.engine.HasViewers() {
			return
		}
		asked = true
		c.engine.RequestApproval(agent, approval)
	})
	if !asked {
		return nil
	}
	timer := time.NewTimer(c.wait)
	defer timer.Stop()
	select {
	case approval := <-decided:
		answer = &approval
	case <-timer.C:
	case <-ctx.Done():
	}
	if answer == nil {
		_ = c.engine.Do(func() {
			if agent := c.engine.Agent(id); agent != nil {
				c.engine.CancelApproval(agent)
				agent.State = models.StateThinking
				c.engine.AddEvent(agent, "approval", "Left to Claude Code's own prompt", nil)
			}
		})
		return nil
	}
	decision := map[string]any{"behavior": "allow"}
	if answer.Decision == nil || *answer.Decision != models.DecisionAllowed {
		decision = map[string]any{
			"behavior": "deny", "message": "The user denied this in Mabari.", "interrupt": false,
		}
	}
	return mustJSON(map[string]any{"hookSpecificOutput": map[string]any{
		"hookEventName": "PermissionRequest", "decision": decision,
	}})
}

// Start does nothing: hooks arrive by themselves once attached.
func (c *Connector) Start() {}

// Stop does nothing. Waiting permission hooks fall back to Claude Code's prompt on their own.
func (c *Connector) Stop() {}

// Instruct queues the message. Claude Code reads it at the next checkpoint, which is the next
// tool call, prompt or stop. A session that is waiting for its user gets it when it next runs.
func (c *Connector) Instruct(agent *models.LiveAgent, text string) {
	c.engine.Queue(agent, text)
	if !agent.State.Active() {
		c.engine.Toast(agent.Name + " gets this when its session next runs a step.")
	}
}

// Decide wakes the permission hook waiting on this agent. Call inside Do.
func (c *Connector) Decide(agent *models.LiveAgent, approval models.Approval) {
	if approval.Decision != nil && *approval.Decision == models.DecisionAllowed {
		agent.State = models.StateThinking
	}
	c.mu.Lock()
	waiter := c.waiting[agent.ID]
	c.mu.Unlock()
	if waiter != nil {
		select {
		case waiter <- approval:
		default:
		}
	}
}

// Interrupt stops Claude at its next tool call. Typing in the session carries on.
func (c *Connector) Interrupt(agent *models.LiveAgent) {
	c.mu.Lock()
	c.pause[strings.TrimPrefix(agent.ID, "cc-")] = true
	c.mu.Unlock()
	c.engine.Toast(agent.Name + " pauses at its next step.")
}

// StopAgent stops following a session. Its terminal keeps running, so Mabari says so.
func (c *Connector) StopAgent(agent *models.LiveAgent) {
	session := strings.TrimPrefix(agent.ID, "cc-")
	c.mu.Lock()
	c.stopped[session] = true
	c.pause[session] = true
	c.mu.Unlock()
	c.engine.CancelApproval(agent)
	c.engine.Log(agent.Name, models.LogInstruction, "Stop session", "Stopped", "")
	c.engine.RemoveAgent(agent.ID)
	c.engine.Toast(agent.Name + " left the office. Its terminal is still open; close it there.")
}

// Retry can't restart a Claude Code session from here.
func (c *Connector) Retry(agent *models.LiveAgent) {
	c.engine.Toast("Run the request again in " + agent.Name + "'s terminal.")
}

// AddSubagent isn't possible: Claude Code starts its own subagents.
func (c *Connector) AddSubagent(*models.LiveAgent, string, string, string) *models.LiveAgent {
	return nil
}

// Models lists the models a Claude plan offers.
func (c *Connector) Models() []string { return models.Models[models.AccountClaudeCode] }

// CheckStale marks the account "Hook not reporting" when sessions are working but no hook has
// reported for StaleAfter, and back to connected when hooks report again. Call inside Do.
func (c *Connector) CheckStale(now time.Time) {
	c.mu.Lock()
	last := c.lastEvent
	c.mu.Unlock()
	working := false
	for _, agent := range c.engine.Agents() {
		if agent.Source == Source && agent.State.Active() {
			working = true
		}
	}
	for _, account := range c.engine.Accounts() {
		if account.Kind != models.AccountClaudeCode || account.Status == models.AccountOff {
			continue
		}
		stale := working && !last.IsZero() && now.Sub(last) > StaleAfter
		switch {
		case stale && account.Status != models.AccountStale:
			account.Status = models.AccountStale
			c.engine.SetAccount(account)
		case !stale && account.Status == models.AccountStale:
			account.Status = models.AccountConnected
			c.engine.SetAccount(account)
		}
	}
}

func orDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
