// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"bytes"
	"context"
	"encoding/json"
	"maps"
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
	TranscriptPath       string          `json:"transcript_path"`
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
	// Edits is MultiEdit's list of changes, all to FilePath.
	Edits []struct {
		OldString string `json:"old_string"`
		NewString string `json:"new_string"`
	} `json:"edits"`
	// NotebookEdit's notebook, the cell it targets, what it does there, and the cell's new text.
	NotebookPath string `json:"notebook_path"`
	CellID       string `json:"cell_id"`
	EditMode     string `json:"edit_mode"`
	NewSource    string `json:"new_source"`
}

// Connector turns hook events into agents on the floor, and answers hooks with queued
// instructions, the user's approval decisions and their answers to Claude's questions.
type Connector struct {
	engine *events.Engine
	// wait is how long a permission or question hook waits for the person.
	wait time.Duration

	mu sync.Mutex
	// waiting are the hook calls waiting for a person, by approval id, and lines the same calls by
	// agent, oldest first. See approvals.go.
	waiting map[string]*approvalCall
	lines   map[string][]*approvalCall
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
	// HookBinary is the program Mabari writes into those settings as its hook, so hooks from a
	// binary with any name are known as Mabari's. Empty leaves only names starting with mabari.
	HookBinary string
	// asking are the questions hooks are waiting on, by question id.
	asking map[string]*asked
	// Program finds the claude program, or gives "" when this computer has none. Nil means Mabari
	// doesn't run sessions here at all. Only the server's own start-up sets it, so no test can reach
	// the real program by accident.
	Program func() string
	// Hook is how a session Mabari runs reports back.
	Hook Hook
	// runWait is how long a session Mabari runs waits for a click, and endWait how long a process
	// has to end when asked.
	runWait time.Duration
	endWait time.Duration
	// runs are the processes Mabari runs, by agent, and leaving those told to end, until they have.
	runs    map[string]*run
	leaving map[*run]struct{}
	// sessions are the sessions Mabari runs or has run, as session id to agent id.
	sessions map[string]string
	// tails are how far each followed session's transcript has been read, by agent.
	tails map[string]*tail
}

// New returns a connector. Register it with engine.AddConnector(Source, connector).
func New(engine *events.Engine) *Connector {
	return &Connector{
		engine:  engine,
		wait:    PermissionWait * time.Second,
		waiting: map[string]*approvalCall{},
		lines:   map[string][]*approvalCall{},
		pause:   map[string]bool{},
		stopped: map[string]bool{},
		handing: map[string]string{},
		streams: map[string]*streamed{},

		delivered: map[string]time.Time{},
		refused:   map[string]bool{},
		asking:    map[string]*asked{},

		runWait:  SessionPermissionWait * time.Second,
		endWait:  endWait,
		runs:     map[string]*run{},
		leaving:  map[*run]struct{}{},
		sessions: map[string]string{},
		tails:    map[string]*tail{},
	}
}

// SetWait changes how long a permission or question hook waits, for tests.
func (c *Connector) SetWait(wait time.Duration) { c.wait = wait }

// SetRunWait changes how long a session Mabari runs waits for a click, for tests.
func (c *Connector) SetRunWait(wait time.Duration) { c.runWait = wait }

var sessionChars = regexp.MustCompile(`[^A-Za-z0-9-]`)

func agentID(session string) string {
	return "cc-" + sessionChars.ReplaceAllString(session, "")
}

// idOf is the agent a session belongs to. A session started elsewhere names its agent. One Mabari
// runs belongs to the agent it was started for.
func (c *Connector) idOf(session string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if id, ok := c.sessions[session]; ok {
		return id
	}
	return agentID(session)
}

// Handle answers one hook call from a session's settings files. The reply is what the hook prints:
// JSON for Claude Code, or nothing, which leaves Claude Code's normal behaviour in place.
func (c *Connector) Handle(ctx context.Context, body []byte) []byte {
	return c.handle(ctx, body, false)
}

// HandleRun answers one hook call from the hooks Mabari passed to a session it runs. In such a
// session, printing nothing at PermissionRequest denies what was asked, but printing nothing at
// PreToolUse lets an allow rule through, so a call Mabari won't speak for is refused out loud.
func (c *Connector) HandleRun(ctx context.Context, body []byte) []byte {
	return c.handle(ctx, body, true)
}

func (c *Connector) handle(ctx context.Context, body []byte, fromRun bool) []byte {
	var in input
	if json.Unmarshal(body, &in) != nil {
		return nil
	}
	// The id becomes an agent's and ends up on a command line, so nothing else gets that far.
	if !launch.ValidSession(in.SessionID) {
		if fromRun {
			return refused(in, "Mabari doesn't recognise this session.")
		}
		return nil
	}
	c.mu.Lock()
	c.lastEvent = time.Now()
	stopped := c.stopped[in.SessionID]
	_, live := c.runs[c.sessions[in.SessionID]]
	c.mu.Unlock()
	// With Claude Code attached, a session Mabari runs fires settings.json's hooks as well as its
	// own, so that copy is ignored: both firing would ask the person twice.
	if !fromRun && live {
		return nil
	}
	// A process Mabari no longer speaks for has nobody to ask.
	if fromRun && !live {
		return refused(in, "This session no longer runs in Mabari.")
	}
	if stopped {
		if in.Event == "SessionEnd" {
			c.mu.Lock()
			delete(c.stopped, in.SessionID)
			c.mu.Unlock()
		}
		if fromRun {
			return refused(in, "This session was stopped in Mabari.")
		}
		return nil
	}
	if in.Event == "PermissionRequest" {
		return c.permission(ctx, in, fromRun)
	}
	if in.Event == "PreToolUse" && in.ToolName == AskTool {
		return c.ask(ctx, in)
	}
	if in.Event == "MessageDisplay" {
		c.display(in)
		return nil
	}
	var reply []byte
	_ = c.engine.Do(func() {
		reply = c.observe(in)
		if reply == nil && fromRun && in.Event == "PreToolUse" {
			reply = c.gate(in)
		}
	})
	if !fromRun {
		c.follow(c.idOf(in.SessionID), in.TranscriptPath)
	}
	return reply
}

// refused answers a hook call from a session Mabari won't speak for: no to anything that decides
// whether an action goes ahead, and nothing to the rest.
func refused(in input, why string) []byte {
	switch in.Event {
	case "PreToolUse":
		return denyTool(why)
	case "PermissionRequest":
		return denyReply(why)
	}
	return nil
}

// denyTool stops a tool call at PreToolUse, whatever a rule or another hook says.
func denyTool(why string) []byte {
	return mustJSON(map[string]any{"hookSpecificOutput": map[string]any{
		"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": why,
	}})
}

// gated reports whether a tool can change something or reach beyond this computer. Everything else
// is left to Claude Code, which asks about it, and so denies it here, unless a rule allows it. Tools
// like TodoWrite would otherwise need a click every time.
func gated(tool string) bool {
	switch tool {
	case "Bash", "PowerShell", "Edit", "Write", "MultiEdit", "NotebookEdit", "Read", "WebFetch":
		return true
	}
	return strings.HasPrefix(tool, "mcp__")
}

// gate makes sure a risky action reaches the approval flow even when a rule would let it through.
// PermissionRequest only fires when Claude Code would ask, and an allow rule means it wouldn't, so
// here Mabari's own risk rules decide. "ask" outranks any other hook's allow, and sends the call to
// PermissionRequest. What the rules call low risk goes on as normal, and Claude Code can still ask
// about it. Call inside Do.
func (c *Connector) gate(in input) []byte {
	if !gated(in.ToolName) {
		return nil
	}
	agent := c.engine.Agent(c.idOf(in.SessionID))
	if agent == nil {
		return denyTool("This agent has left Mabari.")
	}
	if approvalFor(in, workFolder(agent)).RiskLevel == models.RiskLow {
		return nil
	}
	return mustJSON(map[string]any{"hookSpecificOutput": map[string]any{
		"hookEventName": "PreToolUse", "permissionDecision": "ask",
		"permissionDecisionReason": "Mabari asks the person before this runs.",
	}})
}

// agentFor finds the session's agent, seating a new one if this is the first event from it.
// A session started with `claude --agent <name>` runs that agent's definition and takes a desk.
// Any other session is a workflow sub-agent, a contractor that has a desk only while it works:
// Mabari can't tell whether it was opened in a terminal, an editor, on the web or in the Claude
// app, and doesn't need to. It returns nil only when the office is at its MaxDesks limit. Call inside Do.
func (c *Connector) agentFor(in input) *models.LiveAgent {
	id := c.idOf(in.SessionID)
	if agent := c.engine.Agent(id); agent != nil {
		// A name someone chose for a session Mabari runs is theirs, whatever it is.
		if agent.Lead == nil && legacyNames[agent.Name] && !agent.RunsHere() {
			agent.Name = c.nameFor(agent.Folder)
			c.engine.Touch(agent)
		}
		c.reported(agent, in)
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
	agent.Session = &models.AgentSession{ID: in.SessionID, Status: models.SessionElsewhere}
	c.engine.AddAgent(agent)
	c.engine.Log(agent.Name, models.LogSession, "Claude Code session started in "+in.Cwd,
		seatText(agent), "ok")

	c.connected()
	return agent
}

// reported notes who has a session now. One saved by an earlier version gets its session recorded.
// A session Mabari ran that reports with no process behind it has been opened somewhere else, by
// the person carrying it on in a terminal, so Mabari only follows it from now on. Call inside Do.
func (c *Connector) reported(agent *models.LiveAgent, in input) {
	if agent.Lead != nil {
		return
	}
	if agent.Session == nil {
		agent.Session = &models.AgentSession{ID: in.SessionID, Status: models.SessionElsewhere}
		c.engine.Touch(agent)
		return
	}
	c.mu.Lock()
	_, live := c.runs[agent.ID]
	c.mu.Unlock()
	if agent.RunsHere() && !live {
		session := *agent.Session
		session.Status, session.PID = models.SessionElsewhere, 0
		agent.Session = &session
		c.engine.Touch(agent)
		c.engine.Log(agent.Name, models.LogSession, "Carried on outside Mabari", "Followed from here", "")
	}
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
		// A session Mabari started was never one of those: its name is the person's, and it is an
		// agent of the office, not a workflow sub-agent.
		if agent.Source != Source || agent.Lead != nil || agent.RunsHere() {
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
		id := c.idOf(in.SessionID)
		c.mu.Lock()
		delete(c.delivered, id)
		delete(c.tails, id)
		c.mu.Unlock()
		if agent := c.engine.Agent(id); agent != nil {
			// A process Mabari runs ending isn't the session ending: it stays, and resumes.
			if agent.RunsHere() {
				return nil
			}
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
	id := in.SessionID
	if known, found := c.sessions[id]; found {
		id = known
	} else {
		id = agentID(id)
	}
	handed, ok := c.delivered[id]
	c.mu.Unlock()
	text := redact.Text(strings.TrimSpace(message.text.String()))
	if !ok || message.started.Before(handed) || text == "" {
		return
	}
	_ = c.engine.Do(func() {
		agent := c.engine.Agent(id)
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
		c.heard(agent, instruction.Text)
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
		if in.ToolName == "NotebookEdit" {
			path = args.NotebookPath
		}
		verdict := risk.Classify(risk.Action{Kind: risk.KindEdit, Path: path, Folder: folder})
		// A notebook's cells can run when it is opened, so it never passes as a routine edit.
		if in.ToolName == "NotebookEdit" && verdict.Level == models.RiskLow {
			verdict = risk.Verdict{Level: models.RiskHigh, Reason: "Notebook cells can run code, so this needs a check."}
		}
		title, lines := "Change a file", diffOf(args)
		if in.ToolName == "NotebookEdit" {
			title, lines = notebookCard(args)
		}
		// A card with nothing on it would ask for a click on something unseen.
		if len(lines) == 0 {
			for line := range strings.SplitSeq(rawInput(in.ToolName, in.ToolInput), "\n") {
				lines = append(lines, models.DiffLine{Kind: "ctx", Text: line})
			}
		}
		return models.Approval{
			Type: models.ApprovalFile, Title: title,
			Detail: models.ApprovalDetail{Path: path, Lines: lines},
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
			Detail: models.ApprovalDetail{Cmd: rawInput(in.ToolName, in.ToolInput)},
			Risk:   "Mabari has no rule for this tool, so it always asks.", RiskLevel: models.RiskHigh,
		}
	}
}

// What an approval card holds. A tool's input is shown argument by argument, so no argument can push
// another off the card, and whatever is cut says so.
const (
	maxDiffLines = 40
	// maxRawInput is about how much of a tool's input a card shows, and maxRawArguments how many
	// arguments. Values share maxRawInput, between minRawValue and maxRawValue each.
	maxRawInput     = 6000
	maxRawArguments = 100
	maxRawValue     = 400
	minRawValue     = 60
	maxRawKey       = 80
)

// cut clips text to limit characters and says how much it left out.
func cut(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "… [" + strconv.Itoa(len(runes)-limit) + " more characters not shown]"
}

// encoded is a value as JSON on one line, which is how it reads on a card.
func encoded(value any) string {
	var text bytes.Buffer
	encoder := json.NewEncoder(&text)
	encoder.SetEscapeHTML(false) // Shown as text, so < stays <.
	if encoder.Encode(value) != nil {
		return "(can't be shown)"
	}
	return strings.TrimSpace(text.String())
}

// rawInput is a tool's input as the person should see it, because Mabari can't tell which of an
// unknown tool's arguments matter: one line for every argument, sorted so the caller's order counts
// for nothing, with secrets masked field by field before anything is encoded, and each value
// clipped on its own. The text patterns are never run over encoded JSON, where one can run from one
// field into the next.
func rawInput(tool string, raw json.RawMessage) string {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		// Not JSON, so it has no fields to keep apart.
		if text := strings.Join(strings.Fields(string(raw)), " "); text != "" {
			return cut(redact.Text(text), maxRawInput)
		}
		return tool
	}
	shown, isObject := redact.Shape(value).(map[string]any)
	if !isObject {
		if value == nil {
			return tool
		}
		return cut(encoded(redact.Shape(value)), maxRawInput)
	}
	if len(shown) == 0 {
		return tool
	}
	limit := max(minRawValue, min(maxRawValue, maxRawInput/len(shown)))
	lines := make([]string, 0, min(len(shown), maxRawArguments)+1)
	for _, key := range slices.Sorted(maps.Keys(shown)) {
		if len(lines) == maxRawArguments {
			lines = append(lines, "… "+strconv.Itoa(len(shown)-maxRawArguments)+
				" more arguments not shown. This card doesn't show all of the call.")
			break
		}
		lines = append(lines, cut(encoded(key), maxRawKey)+": "+cut(encoded(shown[key]), limit))
	}
	return strings.Join(lines, "\n")
}

// notebookCard describes a NotebookEdit by what it does to the cell, which its mode decides: only
// replace, the default, and insert put new text in. Its title, mode and cell are always on the card.
func notebookCard(args toolInput) (string, []models.DiffLine) {
	mode, cell := args.EditMode, args.CellID
	if mode == "" {
		mode = "replace"
	}
	if cell == "" {
		cell = "(none)"
	}
	title := "Change a notebook cell"
	switch mode {
	case "insert":
		title = "Add a notebook cell"
	case "delete":
		title = "Delete a notebook cell"
	}
	lines := []models.DiffLine{{
		Kind: "ctx", Text: "edit_mode: " + cut(redact.Text(clip(mode, maxRawKey)), maxRawKey) +
			", cell_id: " + cut(redact.Text(clip(cell, maxRawKey)), maxRawKey),
	}}
	if mode == "replace" || mode == "insert" {
		return title, append(lines, diffOf(toolInput{NewString: args.NewSource})...)
	}
	// Anything else adds no text, whatever came with it, so none of it reads as an addition.
	for _, line := range diffOf(toolInput{NewString: args.NewSource}) {
		lines = append(lines, models.DiffLine{Kind: "ctx", Text: "new_source, not added: " + line.Text})
	}
	return title, lines
}

func diffOf(args toolInput) []models.DiffLine {
	var lines []models.DiffLine
	hidden := 0
	add := func(kind, text string) {
		if text == "" {
			return
		}
		for _, line := range strings.Split(redact.Text(text), "\n") {
			if len(lines) < maxDiffLines {
				lines = append(lines, models.DiffLine{Kind: kind, Text: line})
			} else {
				hidden++
			}
		}
	}
	add("del", args.OldString)
	add("add", args.NewString)
	add("add", args.Content)
	for _, edit := range args.Edits {
		add("del", edit.OldString)
		add("add", edit.NewString)
	}
	if hidden > 0 {
		lines = append(lines, models.DiffLine{Kind: "ctx", Text: "… and " + strconv.Itoa(hidden) + " more lines not shown"})
	}
	return lines
}

// denyReply answers a permission request with no. message is what Claude is told.
func denyReply(message string) []byte {
	return mustJSON(map[string]any{"hookSpecificOutput": map[string]any{
		"hookEventName": "PermissionRequest",
		"decision":      map[string]any{"behavior": "deny", "message": message, "interrupt": false},
	}})
}

// permission asks the user in Mabari. For a session started elsewhere it answers nothing, so Claude
// Code shows its own prompt, when nobody has Mabari open, when nobody clicks in time, or when the
// hook gives up. A session Mabari runs has no prompt to fall back on, so it always waits for a
// click, for longer, whether or not a page is open now, and the only way to an allow is below.
func (c *Connector) permission(ctx context.Context, in input, fromRun bool) []byte {
	// A question isn't a risk to approve: allowing it without answers would leave Claude with
	// none. Mabari asks it through PreToolUse, so here it is left to Claude Code's own prompt.
	if in.ToolName == AskTool {
		return nil
	}
	id := c.idOf(in.SessionID)
	var call *approvalCall
	_ = c.engine.Do(func() {
		agent := c.agentFor(in)
		if agent == nil {
			return
		}
		folder := agent.Folder
		if fromRun {
			folder = workFolder(agent)
		}
		approval := approvalFor(in, folder)
		auto := c.engine.Settings().AutoApprove
		covered := auto.On && (auto.Scope == "all" || approval.RiskLevel == models.RiskLow)
		if !covered && !c.engine.HasViewers() && !fromRun {
			return
		}
		call = c.joinLine(agent.ID, approval)
		c.showNext(agent)
	})
	if call == nil {
		return nil
	}
	wait := c.wait
	if fromRun {
		wait = c.runWait
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	var answer *models.Approval
	select {
	case approval := <-call.decided:
		answer = &approval
	case <-timer.C:
	case <-ctx.Done():
	}
	if answer == nil {
		answer = c.giveUp(call, id, fromRun)
	}
	switch {
	case answer == nil && fromRun:
		return denyReply("Nobody answered in Mabari in time, so this was denied. Ask the person before trying it another way.")
	case answer == nil:
		return nil
	case answer.Decision != nil && *answer.Decision == models.DecisionAllowed:
		return mustJSON(map[string]any{"hookSpecificOutput": map[string]any{
			"hookEventName": "PermissionRequest", "decision": map[string]any{"behavior": "allow"},
		}})
	case answer.Decision != nil && *answer.Decision == models.DecisionDenied:
		return denyReply("The user denied this in Mabari.")
	}
	// Nobody said no, so Claude isn't told they did.
	return denyReply(withdrawnReply)
}

// Start does nothing: hooks arrive by themselves once attached.
func (c *Connector) Start() {}

// Stop ends the sessions Mabari runs, because the office they belong to is going. Waiting
// permission hooks of other sessions fall back to Claude Code's prompt on their own. Call inside Do.
func (c *Connector) Stop() { c.endAll(nil) }

// Instruct passes a message on. A session Mabari runs that isn't working gets it at once, starting
// its process again if it needs one. Otherwise it is queued, and Claude Code reads it at the next
// checkpoint, which is the next tool call, prompt or stop. A session started elsewhere that is
// waiting for its user gets it when it next runs, or when the person lets Mabari continue it.
func (c *Connector) Instruct(agent *models.LiveAgent, text string) {
	// A subagent has no hooks of its own, so its lead passes the message on.
	if agent.Lead != nil {
		if lead := c.engine.Agent(*agent.Lead); lead != nil {
			c.engine.Queue(lead, "For the "+agent.Name+" subagent: "+text)
			return
		}
	}
	if agent.RunsHere() {
		c.instructRun(agent, text)
		return
	}
	c.engine.Queue(agent, text)
	if !agent.State.Active() {
		c.engine.Toast(agent.Name + " gets this when its session next runs a step.")
	}
}

// instructRun delivers to a session Mabari runs, or queues while it is busy or waiting on the
// person. When it can't get a process, the message waits rather than being lost. Call inside Do.
func (c *Connector) instructRun(agent *models.LiveAgent, text string) {
	if agent.State.Active() || agent.Approval != nil || agent.Asking() {
		c.engine.Queue(agent, text)
		return
	}
	if err := c.deliverNow(agent, text); err != nil {
		c.engine.Queue(agent, text)
		c.engine.Toast(err.Error())
	}
}

// Decide wakes the permission hook that asked for this approval, and no other, and shows the next
// card in the agent's line. Whichever way it went, the agent is no longer waiting on the person.
// Call inside Do.
func (c *Connector) Decide(agent *models.LiveAgent, approval models.Approval) {
	if approval.Type == models.ApprovalPlan && agent.RunsHere() {
		c.planDecided(agent, approval)
		c.showNext(agent)
		return
	}
	agent.State = models.StateThinking
	if call := c.takeCall(approval.ID); call != nil {
		call.decided <- approval
	}
	c.showNext(agent)
}

// Interrupt stops Claude at its next tool call. Typing in the session carries on. A session Mabari
// runs stops at once, unless it is waiting on an approval: that stays waiting, and it pauses at its
// next step after it, so no interrupt ever settles an approval.
func (c *Connector) Interrupt(agent *models.LiveAgent) {
	if agent.RunsHere() {
		c.interruptRun(agent)
		return
	}
	c.mu.Lock()
	c.pause[strings.TrimPrefix(agent.ID, "cc-")] = true
	c.mu.Unlock()
	c.engine.Toast(agent.Name + " pauses at its next step.")
}

// interruptRun ends the turn in progress. Call inside Do.
func (c *Connector) interruptRun(agent *models.LiveAgent) {
	c.mu.Lock()
	r := c.runs[agent.ID]
	c.mu.Unlock()
	switch {
	case agent.State == models.StatePaused:
	case agent.Approval != nil || agent.Asking():
		c.mu.Lock()
		c.pause[agent.Session.ID] = true
		c.mu.Unlock()
		c.engine.Toast(agent.Name + " pauses at its next step.")
	case r == nil || !agent.State.Active():
		c.engine.Toast(agent.Name + " isn't working, so there is nothing to interrupt.")
	default:
		if err := interruptProcess(r.cmd.Process); err != nil {
			c.engine.Toast("Couldn't interrupt " + agent.Name + ": " + err.Error())
			return
		}
		r.interrupted = true
		agent.PausedFrom, agent.State = agent.State, models.StatePaused
		c.engine.AddEvent(agent, "interrupt", "Paused from Mabari", nil)
		c.engine.Log(agent.Name, models.LogInstruction, "Interrupt", "Paused", "amber")
		c.engine.Touch(agent)
	}
}

// Continue lifts a pause that hasn't happened yet. Once Claude Code has paused, its session waits
// for the person, so the next step needs them to type in it; Mabari says so. A session Mabari runs
// is simply told to carry on. Call inside Do.
func (c *Connector) Continue(agent *models.LiveAgent) {
	if agent.RunsHere() {
		c.mu.Lock()
		delete(c.pause, agent.Session.ID)
		c.mu.Unlock()
		if agent.State == models.StatePaused {
			if err := c.deliverNow(agent, "Carry on from where you stopped."); err != nil {
				c.engine.Toast(err.Error())
			}
		}
		return
	}
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

// stopRun ends a session Mabari runs and takes its agent out of the office. Claude Code keeps the
// transcript, so the session itself isn't lost, and Mabari keeps the conversation. Call inside Do.
func (c *Connector) stopRun(agent *models.LiveAgent) {
	c.mu.Lock()
	r := c.runs[agent.ID]
	delete(c.sessions, agent.Session.ID)
	delete(c.pause, agent.Session.ID)
	c.mu.Unlock()
	c.withdrawCalls(agent.ID)
	if r != nil {
		c.retire(r)
	}
	c.engine.CancelApproval(agent)
	c.engine.Log(agent.Name, models.LogInstruction, "Stop session", "Stopped", "")
	for _, helper := range slices.Clone(c.engine.Agents()) {
		if helper.Lead != nil && *helper.Lead == agent.ID {
			c.engine.RemoveAgent(helper.ID)
		}
	}
	resume, name := agent.Session.Resume, agent.Name
	c.engine.RemoveAgent(agent.ID)
	c.engine.Toast(name + " stopped. Its session is saved. To pick it up in a terminal: " + resume)
}

// StopAgent stops following a session. Its terminal keeps running, so Mabari says so. A session
// Mabari runs has no terminal, so it is ended.
func (c *Connector) StopAgent(agent *models.LiveAgent) {
	if agent.RunsHere() {
		c.stopRun(agent)
		return
	}
	session := strings.TrimPrefix(agent.ID, "cc-")
	c.mu.Lock()
	c.stopped[session] = true
	c.pause[session] = true
	c.mu.Unlock()
	// A permission hook waiting on this session hears no at once, rather than holding Claude
	// Code until it gives up. A waiting question notices the agent has gone by itself.
	c.withdrawCalls(agent.ID)
	c.engine.CancelApproval(agent)
	c.engine.Log(agent.Name, models.LogInstruction, "Stop session", "Stopped", "")
	c.engine.RemoveAgent(agent.ID)
	c.engine.Toast(agent.Name + " left the office. Its terminal is still open; close it there.")
}

// Retry can't restart a Claude Code session started elsewhere from here. One Mabari runs is sent
// its last message again.
func (c *Connector) Retry(agent *models.LiveAgent) {
	if !agent.RunsHere() {
		c.engine.Toast("Run the request again in " + agent.Name + "'s terminal.")
		return
	}
	text := "Please try that again."
	if count := len(agent.Asked); count > 0 {
		text = agent.Asked[count-1].Text
	}
	if err := c.deliverNow(agent, text); err != nil {
		c.engine.Toast(err.Error())
	}
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
