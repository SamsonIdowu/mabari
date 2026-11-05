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
	"github.com/SamsonIdowu/mabari/internal/launch"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/projectmap"
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
// instructions, the user's approval decisions and their answers to Claude's questions.
type Connector struct {
	engine *events.Engine
	// wait is how long a permission or question hook waits for the person.
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
	// refused are the subagents already told there was no desk for them, by id.
	refused map[string]bool
	// MapFile is where Mabari keeps its map of the projects, which a session running as Mabari
	// gets at its start. Empty leaves it out.
	MapFile string
	// ConfigDir is Claude Code's settings folder on this computer, checked before a question is
	// shown. Empty, as in Docker where the settings are on the host, skips the check.
	ConfigDir string
	// asking are the questions hooks are waiting on, by question id.
	asking map[string]*asked
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
		refused:   map[string]bool{},
		asking:    map[string]*asked{},
	}
}

// SetWait changes how long a permission or question hook waits, for tests.
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
	if in.Event == "PreToolUse" && in.ToolName == AskTool {
		return c.ask(ctx, in)
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
// A session started with `claude --agent <name>` runs that agent's definition and takes a desk.
// Any other session is a workflow sub-agent, a contractor that has a desk only while it works:
// Mabari can't tell whether it was opened in a terminal, an editor, on the web or in the Claude
// app, and doesn't need to. It returns nil only when the office is at its MaxDesks limit. Call inside Do.
func (c *Connector) agentFor(in input) *models.LiveAgent {
	id := agentID(in.SessionID)
	if agent := c.engine.Agent(id); agent != nil {
		if agent.Lead == nil && legacyNames[agent.Name] {
			agent.Name = c.nameFor(agent.Folder)
			c.engine.Touch(agent)
		}
		c.recognise(agent, in)
		return agent
	}
	project := c.projectFor(in.Cwd)
	// Inside a subagent agent_type is the subagent's, so only a session's own event names its
	// --agent definition.
	def, defined := models.AgentDef{}, false
	if in.AgentID == "" {
		def, defined = c.defFor(in.AgentType, project)
	}
	// A workflow sub-agent takes a desk only while it's on duty (see Engine.seatWorkflow), and a
	// new session starts idle, so it starts off the floor.
	desk := models.OffFloor
	if defined {
		desk = models.FreeDesk(c.engine.Agents(), -1)
		if desk < 0 {
			c.engine.Toast("The office is full, so a new Claude Code session isn't shown.")
			return nil
		}
	}
	agents := c.engine.Agents()
	agent := &models.LiveAgent{}
	if defined {
		agent.DefID = def.ID
	} else {
		agent.Workflow = true
	}
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
	if project != "" {
		agent.Project = &project
	}
	c.engine.AddAgent(agent)
	c.engine.Log(agent.Name, models.LogSession, "Claude Code session started in "+in.Cwd,
		seatText(agent), "ok")

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

// seatText is where the log says an agent sat down.
func seatText(agent *models.LiveAgent) string {
	if agent.Workflow {
		return "Takes a desk only while it works"
	}
	return "Took desk " + strconv.Itoa(agent.Desk+1)
}

// defFor finds the Claude Code agent definition with this name: the project's own first, as
// Claude Code prefers it, then the account's. Call inside Do.
func (c *Connector) defFor(name, project string) (models.AgentDef, bool) {
	if name == "" {
		return models.AgentDef{}, false
	}
	var account *models.AgentDef
	for _, def := range c.engine.Defs() {
		if (def.Kind != "" && def.Kind != models.DefClaude) || !strings.EqualFold(def.Name, name) {
			continue
		}
		if def.Scope == models.DefProject && project != "" && def.ProjectID == project {
			return def, true
		}
		if def.Scope == models.DefAccount && account == nil {
			account = &def
		}
	}
	if account != nil {
		return *account, true
	}
	return models.AgentDef{}, false
}

// TidyNames renames sessions an earlier version gave made up names, after their folder, so even
// ones that never report again stop looking like agents that came with the app. Sessions saved
// before workflow sub-agents were told apart become workflow sub-agents, with their subagents.
// Call inside Do.
func (c *Connector) TidyNames() {
	for _, agent := range c.engine.Agents() {
		if agent.Source != Source || agent.Lead != nil {
			continue
		}
		if legacyNames[agent.Name] {
			agent.Name = c.nameFor(agent.Folder)
			c.engine.Touch(agent)
		}
		if agent.DefID == "" && !agent.Workflow {
			// The engine gives it a desk again in the next flush, if it's on duty.
			agent.Workflow, agent.Desk = true, models.OffFloor
			c.engine.Touch(agent)
			c.tidyHelpers(agent)
		}
	}
}

// recognise catches up with what a session's later events say about it. The project it works in
// may have been given its folder after the session started. A session saved as a workflow
// sub-agent that reports the agent it runs (`claude --agent <name>`, or the agent setting) is
// that agent's after all: a permanent agent, it keeps its desk. Call inside Do.
func (c *Connector) recognise(agent *models.LiveAgent, in input) {
	if agent.Lead != nil {
		return
	}
	if agent.Project == nil {
		if project := c.projectFor(agent.Folder); project != "" {
			agent.Project = &project
			c.engine.Touch(agent)
		}
	}
	if !agent.Workflow || in.AgentID != "" || in.AgentType == "" {
		return
	}
	project := ""
	if agent.Project != nil {
		project = *agent.Project
	}
	def, found := c.defFor(in.AgentType, project)
	if !found {
		return
	}
	desk := agent.Desk
	if desk < 0 {
		if desk = models.FreeDesk(c.engine.Agents(), -1); desk < 0 {
			return
		}
	}
	agent.DefID, agent.Workflow, agent.Desk = def.ID, false, desk
	c.engine.Touch(agent)
	c.engine.Log(agent.Name, models.LogSession, "Running the "+def.Name+" agent", seatText(agent), "ok")
}

// numbered is the number Mabari adds to a second subagent of the same type, such as "Explore 2".
var numbered = regexp.MustCompile(` [0-9]+$`)

// tidyHelpers links a lead's subagents saved before workflow sub-agents were told apart to an
// agent file, by name, or makes them workflow sub-agents. Call inside Do.
func (c *Connector) tidyHelpers(lead *models.LiveAgent) {
	for _, helper := range c.engine.Agents() {
		if helper.Lead == nil || *helper.Lead != lead.ID || helper.DefID != "" || helper.Workflow {
			continue
		}
		project := ""
		if helper.Project != nil {
			project = *helper.Project
		}
		def, found := c.defFor(numbered.ReplaceAllString(helper.Name, ""), project)
		helper.DefID, helper.Workflow = def.ID, !found
		c.engine.Touch(helper)
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
	// The open project with the most specific folder wins, so a project in ~/code/shop beats one
	// in ~/code, and a completed project doesn't take new sessions.
	best, length := "", -1
	for _, project := range c.engine.Projects() {
		repo := project.Repository
		if project.Done != nil || repo == nil || repo.Path == "" {
			continue
		}
		if root := expandHome(repo.Path); within(folder, root) && len(root) > length {
			best, length = project.ID, len(root)
		}
	}
	// A session outside every project's folder belongs to none.
	return best
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
	case tool == AskTool:
		text = "Ask you: " + firstQuestion(raw)
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
	// Tool events from inside a subagent carry its agent_id and agent_type. Claude Code sends no
	// SubagentStart for some subagents, such as a skill with `context: fork`, so the first of
	// these seats it. They show what the subagent does, not its lead, which is waiting on it.
	if in.AgentID != "" && in.AgentType != "" && (in.Event == "PreToolUse" || in.Event == "PostToolUse") {
		helper := c.seatHelper(agent, in)
		// A pause asked for the session, or for this subagent, stops the subagent's next step,
		// and both show as paused.
		if in.Event == "PreToolUse" &&
			(c.takePause(in.SessionID) || c.takePause(strings.TrimPrefix(helperID(in), "cc-"))) {
			for _, paused := range []*models.LiveAgent{agent, helper} {
				if paused != nil && paused.State != models.StatePaused {
					paused.PausedFrom, paused.State = paused.State, models.StatePaused
					c.engine.AddEvent(paused, "interrupt", "Paused from Mabari", nil)
					c.engine.Touch(paused)
				}
			}
			return mustJSON(map[string]any{
				"continue":   false,
				"stopReason": "Paused from Mabari. Type in this session to carry on.",
			})
		}
		if agent.State == models.StateSpawning || agent.State == models.StateIdle || agent.State == models.StateDone {
			agent.State = models.StateThinking
		}
		if helper != nil {
			if in.Event == "PreToolUse" {
				helper.State = stateFor(in.ToolName)
				c.engine.AddEvent(helper, in.ToolName, summaryOf(in.ToolName, in.ToolInput), nil)
			} else {
				helper.State = models.StateThinking
			}
			c.engine.Touch(helper)
		}
		// A subagent's checkpoints are its lead's too: instructions sent to either, including
		// ones for this subagent ("For the Explore subagent: …"), go in here.
		if in.Event == "PostToolUse" {
			return c.deliver(agent, "PostToolUse")
		}
		return nil
	}
	switch in.Event {
	case "SessionStart":
		return c.startingAsMabari(agent)
	case "UserPromptSubmit":
		// A session Mabari opened for a prompt reports it as its first prompt. It counts as sent
		// to this session, and its reply is passed on like any other.
		if c.engine.TakeOpening(agent, in.Prompt) {
			c.mu.Lock()
			c.delivered[agent.ID] = time.Now()
			c.mu.Unlock()
		}
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
			// Subagents are ephemeral: off duty it leaves the floor at once, and is soon gone.
			c.engine.Dismiss(helper, 0)
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

// mapBrief is how much of the map a session gets at its start; the rest is in the map file.
const mapBrief = 8000

// startingAsMabari gives a session running as Mabari, the default agent, Mabari's map of the
// projects as it starts, so it knows every project, where it lives and what is being done there.
// Any other session gets nothing. Call inside Do.
func (c *Connector) startingAsMabari(agent *models.LiveAgent) []byte {
	if agent.DefID != models.MabariDef || c.MapFile == "" {
		return nil
	}
	return mustJSON(map[string]any{"hookSpecificOutput": map[string]any{
		"hookEventName":     "SessionStart",
		"additionalContext": projectmap.Of(c.engine).Brief(mapBrief, c.MapFile),
	}})
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
		lines = append(lines, asCommand(instruction.Text))
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

// asCommand rewords a slash command for a running session. A hook's text reaches Claude as
// context, not as typed input, so Claude Code won't run "/ux-audit x" itself; Claude can, though,
// run a skill or custom command with its Skill tool when asked to in words.
func asCommand(text string) string {
	name, args, ok := launch.SlashCommand(text)
	if !ok {
		return text
	}
	said := "run the /" + name + " command"
	if args != "" {
		said += " with: " + args
	}
	return said + " (a slash command; use the Skill tool for it)."
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
	// A question isn't a risk to approve: allowing it without answers would leave Claude with
	// none. Mabari asks it through PreToolUse, so here it is left to Claude Code's own prompt.
	if in.ToolName == AskTool {
		return nil
	}
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
	// A permission hook waiting on this session hears no at once, rather than holding Claude
	// Code until it gives up. A waiting question notices the agent has gone by itself.
	if waiter := c.waiting[agent.ID]; waiter != nil {
		decision := models.DecisionCancelled
		select {
		case waiter <- models.Approval{Decision: &decision}:
		default:
		}
	}
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

// seatHelper gives a Claude Code subagent the free desk nearest its lead, with the lead's handoff
// as its first message. Every subagent is shown, however many the lead starts. One whose type
// names a loaded Claude agent definition, the project's or the account's, is linked to it. Any
// other, such as general-purpose or Explore, is a workflow sub-agent. It returns the helper, or
// nil when the office has no free desk for an agent file's subagent. Call inside Do.
func (c *Connector) seatHelper(lead *models.LiveAgent, in input) *models.LiveAgent {
	if in.AgentID == "" {
		return nil
	}
	if helper := c.engine.Agent(helperID(in)); helper != nil {
		return helper
	}
	project := ""
	if lead.Project != nil {
		project = *lead.Project
	} else {
		project = c.projectFor(lead.Folder)
	}
	def, defined := c.defFor(in.AgentType, project)
	desk := models.FreeDesk(c.engine.Agents(), lead.Desk)
	if desk < 0 {
		if defined {
			// Said once per subagent, not on each of its tool calls.
			c.mu.Lock()
			told := c.refused[helperID(in)]
			c.refused[helperID(in)] = true
			c.mu.Unlock()
			if !told {
				c.engine.Toast("The office is full, so " + lead.Name + "'s new subagent isn't shown.")
			}
			return nil
		}
		// A workflow sub-agent waits off the floor and takes a desk when one is free.
		desk = models.OffFloor
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
	helper.DefID, helper.Workflow = def.ID, !defined
	count := len(c.engine.Agents())
	helper.Hue = models.Hues[count%len(models.Hues)]
	helper.Skin = models.Skins[count%len(models.Skins)]
	helper.Hair = models.Hairs[(count*3)%len(models.Hairs)]
	helper.CreatedAt = c.engine.Now().UnixMilli()
	helper.State, helper.Task = models.StateThinking, clip(task, 120)
	helper.Queued, helper.Files = []models.Instruction{}, []string{}
	c.engine.AddAgent(helper)
	c.engine.AddMessage(lead, helper, "Can you take this for me: "+models.LowerFirst(strings.TrimSuffix(helper.Task, "."))+"?", models.MessageHandoff, 0)
	return helper
}
