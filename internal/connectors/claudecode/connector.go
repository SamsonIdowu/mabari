// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
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
// legacyNames are the made up names earlier versions gave sessions. A session still carrying one
// is renamed after its folder, so nothing looks like an agent that came with the app.
var legacyNames = map[string]bool{
	"Juniper": true, "Pepper": true, "Hazel": true, "Wren": true, "Marlow": true, "Basil": true,
	"Clover": true, "Ember": true, "Iris": true, "Juno": true, "Lark": true, "Moss": true,
	"Olive": true, "Quinn": true, "Sorrel": true, "Tansy": true,
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
	AgentID              string          `json:"agent_id"`
	// MessageDisplay sends an assistant message in batches of lines as it streams.
	MessageID string `json:"message_id"`
	Final     bool   `json:"final"`
	Delta     string `json:"delta"`
}

// streamed is an assistant message arriving in batches, with when its first batch came.
type streamed struct {
	text    strings.Builder
	started time.Time
}

// streamsKept caps the messages being put together at once, in case final batches go missing.
const streamsKept = 32

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

	mu      sync.Mutex
	waiting map[string]chan models.Approval
	pause   map[string]bool
	stopped map[string]bool
	// handing is what the lead last asked a subagent to do, by session, from its Task call.
	handing   map[string]string
	lastEvent time.Time
	// streams are assistant messages arriving through MessageDisplay, by message id.
	streams map[string]*streamed
	// delivered is when each session last had instructions handed to it from Mabari.
	delivered map[string]time.Time
}

// New returns a connector. Register it with engine.AddConnector(Source, connector).
func New(engine *events.Engine) *Connector {
	return &Connector{
		engine:  engine,
		wait:    PermissionWait * time.Second,
		waiting: map[string]chan models.Approval{},
		pause:   map[string]bool{},
		stopped: map[string]bool{},
		handing: map[string]string{},
		streams: map[string]*streamed{},

		delivered: map[string]time.Time{},
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
	if in.Event == "MessageDisplay" {
		c.display(in)
		return nil
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
		if agent.Lead == nil && legacyNames[agent.Name] {
			agent.Name = c.nameFor(agent.Folder)
			c.engine.Touch(agent)
		}
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
	agent.Name = c.nameFor(in.Cwd)
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
	for _, account := range c.engine.StoredAccounts() {
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

// TidyNames renames sessions an earlier version gave made up names, after their folder, so even
// ones that never report again stop looking like agents that came with the app. Call inside Do.
func (c *Connector) TidyNames() {
	for _, agent := range c.engine.Agents() {
		if agent.Source == Source && agent.Lead == nil && legacyNames[agent.Name] {
			agent.Name = c.nameFor(agent.Folder)
			c.engine.Touch(agent)
		}
	}
}

var notWord = regexp.MustCompile(`[^A-Za-z0-9]+`)

// nameFor names a session after the folder it works in, such as "Shop" for ~/code/shop, so it is
// clear where it came from. A second session in the same folder, or one in a folder called
// mabari, gets a number, since Mabari is the office manager's name.
func (c *Connector) nameFor(folder string) string {
	var words []string
	for _, word := range notWord.Split(filepath.Base(filepath.Clean(folder)), -1) {
		if word != "" {
			words = append(words, strings.ToUpper(word[:1])+word[1:])
		}
	}
	base := clip(strings.Join(words, " "), 20)
	if base == "" || base == "." || base == "/" {
		base = "Claude"
	}
	name := base
	for number := 2; c.engine.AgentByName(name) != nil || strings.EqualFold(name, "Mabari"); number++ {
		name = base + " " + strconv.Itoa(number)
	}
	return name
}

// projectFor picks the project whose repository folder holds the session, or none.
func (c *Connector) projectFor(folder string) string {
	projects := c.engine.Projects()
	for _, project := range projects {
		if repo := project.Repository; repo != nil && repo.Path != "" && within(folder, expandHome(repo.Path)) {
			return project.ID
		}
	}
	// A session outside every project's folder belongs to none.
	return ""
}

// expandHome turns a leading ~ into the home folder, as projects keep paths the way people type
// them.
func expandHome(path string) string {
	if path != "~" && !strings.HasPrefix(path, "~/") {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	return filepath.Join(home, strings.TrimPrefix(path, "~"))
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
		c.mu.Lock()
		delete(c.delivered, agentID(in.SessionID))
		c.mu.Unlock()
		if agent := c.engine.Agent(agentID(in.SessionID)); agent != nil {
			c.engine.Log(agent.Name, models.LogSession, "Claude Code session ended", "Left", "")
			for _, helper := range slices.Clone(c.engine.Agents()) {
				if helper.Lead != nil && *helper.Lead == agent.ID {
					c.engine.RemoveAgent(helper.ID)
				}
			}
			c.engine.RemoveAgent(agent.ID)
		}
		return nil
	}
	agent := c.agentFor(in)
	if agent == nil {
		return nil
	}
	// Any hook that reports means Claude Code is connected, whatever the account said before.
	c.connected()
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
			agent.PausedFrom, agent.State = agent.State, models.StatePaused
			c.engine.AddEvent(agent, "interrupt", "Paused from Mabari", nil)
			return mustJSON(map[string]any{
				"continue":   false,
				"stopReason": "Paused from Mabari. Type in this session to carry on.",
			})
		}
		agent.State = stateFor(in.ToolName)
		c.engine.AddEvent(agent, in.ToolName, summaryOf(in.ToolName, in.ToolInput), nil)
		if in.ToolName == "Task" || in.ToolName == "Agent" {
			c.mu.Lock()
			c.handing[in.SessionID] = summaryOf(in.ToolName, in.ToolInput)
			c.mu.Unlock()
		}
		return nil
	case "PostToolUse":
		agent.State = models.StateThinking
		return c.deliver(agent, "PostToolUse")
	case "SubagentStart":
		agent.State = models.StateSpawning
		c.engine.AddEvent(agent, "spawn", "Started a "+orDefault(in.AgentType, "helper")+" subagent", nil)
		c.seatHelper(agent, in)
		return nil
	case "SubagentStop":
		c.engine.AddEvent(agent, "report", "A subagent finished", nil)
		if helper := c.engine.Agent(helperID(in)); helper != nil {
			report := clip(redact.Text(in.LastAssistantMessage), 160)
			if report == "" {
				report = "Done."
			}
			helper.State, helper.Progress = models.StateDone, 1
			c.engine.Touch(helper)
			c.engine.AddMessage(helper, agent, report, models.MessageReport, 0)
			c.engine.SetReply(helper, clip(report, 90), 8000)
		}
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
		full := redact.Text(in.LastAssistantMessage)
		if said := clip(full, 90); said != "" {
			c.engine.SetReply(agent, said, 8000)
		}
		// Claude's whole answer goes with whatever was sent from Mabari, so it can be read there.
		c.engine.Answered(agent, full)
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

// display puts together an assistant message as it streams. When it is complete, and it began
// after Mabari handed the session an instruction, it is the agent's first reply to it, so it is
// relayed at once instead of waiting for the turn to stop. Printing nothing leaves Claude Code's
// display as it is.
func (c *Connector) display(in input) {
	// A subagent's messages are its own, not its lead's answer.
	if in.MessageID == "" || in.AgentID != "" {
		return
	}
	c.mu.Lock()
	message := c.streams[in.MessageID]
	if message == nil {
		if len(c.streams) >= streamsKept {
			clear(c.streams)
		}
		message = &streamed{started: time.Now()}
		c.streams[in.MessageID] = message
	}
	if message.text.Len() < models.ReplyLimit*4 {
		message.text.WriteString(in.Delta)
	}
	if !in.Final {
		c.mu.Unlock()
		return
	}
	delete(c.streams, in.MessageID)
	handed, ok := c.delivered[agentID(in.SessionID)]
	c.mu.Unlock()
	text := redact.Text(strings.TrimSpace(message.text.String()))
	if !ok || message.started.Before(handed) || text == "" {
		return
	}
	_ = c.engine.Do(func() {
		agent := c.engine.Agent(agentID(in.SessionID))
		if agent == nil {
			return
		}
		if c.engine.Answered(agent, text) {
			c.engine.SetReply(agent, clip(text, 90), 8000)
		}
	})
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
	c.mu.Lock()
	c.delivered[agent.ID] = time.Now()
	c.mu.Unlock()
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
// The folder is the agent's own, from its first event, so a session that moved elsewhere is
// judged against where it started.
func approvalFor(in input, folder string) models.Approval {
	approval := classify(in, folder)
	if approval.RiskLevel == models.RiskLow && !risk.SameFolder(in.Cwd, folder) {
		approval.RiskLevel = models.RiskHigh
		approval.Risk = "The session moved to " + in.Cwd + ", away from the agent's folder."
	}
	return approval
}

func classify(in input, folder string) models.Approval {
	var args toolInput
	_ = json.Unmarshal(in.ToolInput, &args)
	switch in.ToolName {
	case "Bash":
		verdict := risk.Classify(risk.Action{Kind: risk.KindCommand, Command: args.Command, Folder: folder})
		return models.Approval{
			Type: models.ApprovalCommand, Title: "Run a command",
			Detail: models.ApprovalDetail{Cmd: redact.Text(args.Command)},
			Risk:   verdict.Reason, RiskLevel: verdict.Level,
		}
	case "Edit", "Write", "MultiEdit", "NotebookEdit":
		path := args.FilePath
		verdict := risk.Classify(risk.Action{Kind: risk.KindEdit, Path: path, Folder: folder})
		return models.Approval{
			Type: models.ApprovalFile, Title: "Change a file",
			Detail: models.ApprovalDetail{Path: path, Lines: diffOf(args)},
			Risk:   verdict.Reason, RiskLevel: verdict.Level,
		}
	case "Read":
		verdict := risk.Classify(risk.Action{Kind: risk.KindRead, Path: args.FilePath, Folder: folder})
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
		approval := approvalFor(in, agent.Folder)
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
	// A subagent has no hooks of its own, so its lead passes the message on.
	if agent.Lead != nil {
		if lead := c.engine.Agent(*agent.Lead); lead != nil {
			c.engine.Queue(lead, "For the "+agent.Name+" subagent: "+text)
			return
		}
	}
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

// Continue lifts a pause that hasn't happened yet. Once Claude Code has paused, its session waits
// for the person, so the next step needs them to type in it; Mabari says so. Call inside Do.
func (c *Connector) Continue(agent *models.LiveAgent) {
	session := strings.TrimPrefix(agent.ID, "cc-")
	c.mu.Lock()
	pending := c.pause[session]
	delete(c.pause, session)
	c.mu.Unlock()
	if pending {
		return
	}
	if agent.State == models.StatePaused {
		// Claude Code ended the turn, so the session is waiting for its person, not working.
		agent.State, agent.PausedFrom = models.StateIdle, ""
		c.engine.Touch(agent)
		c.engine.Toast("Claude Code stopped " + agent.Name + "'s turn. Type in its session to carry on.")
	}
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
	for _, account := range c.engine.StoredAccounts() {
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

func helperID(in input) string {
	return agentID(in.SessionID) + "-" + sessionChars.ReplaceAllString(in.AgentID, "")
}

// seatHelper gives a Claude Code subagent a desk in its lead's office, with the lead's handoff
// as its first message. A lead has three helpers at most on the floor. Call inside Do.
func (c *Connector) seatHelper(lead *models.LiveAgent, in input) {
	if in.AgentID == "" || c.engine.Agent(helperID(in)) != nil {
		return
	}
	helpers := 0
	for _, agent := range c.engine.Agents() {
		if agent.Lead != nil && *agent.Lead == lead.ID && agent.State != models.StateDone {
			helpers++
		}
	}
	desk := c.nearDesk(lead.Desk)
	if helpers >= models.MaxSubagents || desk < 0 {
		return
	}
	c.mu.Lock()
	task := c.handing[in.SessionID]
	delete(c.handing, in.SessionID)
	c.mu.Unlock()
	if task == "" {
		task = "Help " + lead.Name
	}
	// A subagent keeps its agent's exact name, such as code-reviewer from ~/.claude/agents.
	base := clip(orDefault(in.AgentType, "helper"), 40)
	name := base
	for number := 2; c.engine.AgentByName(name) != nil; number++ {
		name = base + " " + strconv.Itoa(number)
	}
	helper := &models.LiveAgent{}
	helper.ID, helper.Name = helperID(in), name
	helper.Provider, helper.Account, helper.Source = models.ProviderClaude, models.AccountClaudeCode, Source
	helper.Model, helper.SubModel, helper.Desk, helper.Folder = lead.Model, "inherit", desk, lead.Folder
	helper.Lead, helper.Project = &lead.ID, lead.Project
	count := len(c.engine.Agents())
	helper.Hue = models.Hues[count%len(models.Hues)]
	helper.Skin = models.Skins[count%len(models.Skins)]
	helper.Hair = models.Hairs[(count*3)%len(models.Hairs)]
	helper.CreatedAt = c.engine.Now().UnixMilli()
	helper.State, helper.Task = models.StateThinking, clip(task, 120)
	helper.Queued, helper.Files = []models.Instruction{}, []string{}
	c.engine.AddAgent(helper)
	c.engine.AddMessage(lead, helper, "Can you take this for me: "+models.LowerFirst(strings.TrimSuffix(helper.Task, "."))+"?", models.MessageHandoff, 0)
}

// nearDesk is the free desk closest to the lead's, on the office's real desk grid.
func (c *Connector) nearDesk(near int) int {
	used := map[int]bool{}
	for _, agent := range c.engine.Agents() {
		used[agent.Desk] = true
	}
	position := func(index int) (float64, float64) { return float64(8 + index%4*5), float64(4 + index/4*4) }
	nx, ny := position(near)
	best, bestDistance := -1, 0.0
	for desk := range models.DeskCount {
		if used[desk] {
			continue
		}
		x, y := position(desk)
		distance := (x-nx)*(x-nx) + (y-ny)*(y-ny)
		if best < 0 || distance < bestDistance {
			best, bestDistance = desk, distance
		}
	}
	return best
}
