// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/SamsonIdowu/mabari/internal/launch"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/redact"
)

// A session Mabari runs is `claude -p` as a child process, with stream-json in and out, kept alive
// between turns. Checked against Claude Code 2.1.318 and its docs; docs/INTEGRATIONS.md has the
// facts this relies on.
//
// Every risky action stops for a click, and with no answer it is denied:
//
//   - --permission-mode default and --permission-prompts none mean that anything Claude Code would
//     ask about is denied unless a PermissionRequest hook allows it. Mabari's hook is the only thing
//     passing an allow, and it only does so for a person's click or auto approve. So a hook that
//     fails, times out or can't reach Mabari denies the action. Waiting is safe.
//   - Allow rules skip that prompt, so Mabari's PreToolUse hook answers "ask" for what its own risk
//     rules call risky, and ask outranks allow. See Connector.gate.
//   - -p skips the trust dialog, so repository hooks would run unseen. See FolderConfig. Every
//     start checks what the folder brings against what the person agreed to.
//   - No flag here grants anything. --bare is never passed: it turns off the hooks passed with
//     --settings, and with them every approval.

// Permission modes a session may run in. Nothing else is ever passed, and a session that reports
// another is ended.
const (
	runModeDefault = "default"
	runModePlan    = "plan"
)

const (
	// endWait is how long a process has to end by itself before it is killed.
	endWait = 5 * time.Second
	// drainWait is how long the rest of the stream is read after the process has ended, in case
	// something it started still holds the pipe open.
	drainWait = 2 * time.Second
	// stderrKept is how much of the process's error output is kept, for saying why it died.
	stderrKept = 8 << 10
	// inboxSize is how many messages can wait to be written to the process.
	inboxSize = 64
)

// sessionProblem is an error worded for the person, shown as it is.
type sessionProblem string

func (p sessionProblem) Error() string { return string(p) }

// Reasons a session can't start.
const (
	ErrNoClaude   = sessionProblem("Claude Code isn't installed on this computer. Install it, then try again.")
	ErrOfficeFull = sessionProblem("The office is full. Stop an agent to free a desk.")
	ErrDeskTaken  = sessionProblem("That desk has just been taken. Pick another.")
)

// CapError says the most sessions allowed are all busy.
type CapError struct{ Limit int }

func (e CapError) Error() string {
	return fmt.Sprintf("Mabari is already running %d Claude Code session%s, the most Settings allows, and all of them are busy. "+
		"Wait for one to finish, stop one, or raise the limit in Settings.", e.Limit, plural(e.Limit))
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// SessionSpec is a Claude Code session to start from Mabari.
type SessionSpec struct {
	Name    string
	Folder  string
	Task    string
	Model   string
	Project string
	Desk    *int
	// Prompt is the first message. Empty uses Task.
	Prompt string
	// Plan starts in plan mode, until the person approves the plan.
	Plan bool
	// AgentFile is the agent it runs as, and DefID the definition that came from.
	AgentFile string
	DefID     string
	// Tools are the kinds of tool the person left ticked, from the New agent form. Unticked ones are
	// denied to the session. Empty leaves all of them, because nothing was asked.
	Tools []string
	// DailyCostCap stops a process at this estimated spend, or zero for none.
	DailyCostCap float64
}

// run is one live process. pending is only touched inside Do, and the live text, tools and denied
// maps only by the goroutine reading the stream.
type run struct {
	agentID string
	cmd     *exec.Cmd
	stderr  *tailBuffer

	inputMu sync.Mutex
	closed  bool
	inbox   chan []byte
	exited  chan struct{}
	// ended means Mabari ended it, so it isn't a crash.
	ended atomic.Bool

	// pending counts messages sent that have no result yet.
	pending int
	// interrupted is true from an interrupt until that turn's result, which reads as an error but
	// isn't one, and can arrive after the person has already said to continue.
	interrupted bool
	lastUsed    time.Time

	live   map[int]*liveText
	order  []*liveText
	tools  map[string]models.ConversationItem
	denied map[string]bool
}

// tailBuffer keeps the end of what is written to it.
type tailBuffer struct {
	mu   sync.Mutex
	data []byte
}

func (b *tailBuffer) Write(part []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.data = append(b.data, part...)
	if len(b.data) > stderrKept {
		b.data = slices.Clone(b.data[len(b.data)-stderrKept:])
	}
	return len(part), nil
}

func (b *tailBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.data)
}

func newSessionID() string {
	raw := make([]byte, 16)
	_, _ = rand.Read(raw) // crypto/rand never fails on supported platforms.
	raw[6] = raw[6]&0x0f | 0x40
	raw[8] = raw[8]&0x3f | 0x80
	text := hex.EncodeToString(raw)
	return text[:8] + "-" + text[8:12] + "-" + text[12:16] + "-" + text[16:20] + "-" + text[20:]
}

// CanRun reports whether Mabari is set up to run sessions here at all.
func (c *Connector) CanRun() bool { return c.Program != nil }

// Installed reports whether the claude program is on this computer.
func (c *Connector) Installed() bool { return c.program() != "" }

func (c *Connector) program() string {
	if c.Program == nil {
		return ""
	}
	return c.Program()
}

// safeValue is what may follow a flag. Names and models come from people, and a value starting
// with a dash could be read as a flag, so a value that doesn't fit is left out.
var safeValue = regexp.MustCompile(`^[\p{L}\p{N}][\p{L}\p{N} ._:/\[\]-]*$`)

// runLine is what goes on the command line.
type runLine struct {
	Session, Name, Model, Mode, AgentFile, Settings string
	Resume                                          bool
	Denied                                          []string
	Budget                                          float64
}

// runArgs is the command line of a session Mabari runs. Each argument is passed on its own, never
// through a shell. Tests check that this never contains a flag that grants anything.
func runArgs(line runLine) []string {
	mode := runModeDefault
	if line.Mode == runModePlan {
		mode = runModePlan
	}
	args := []string{
		"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
		"--include-partial-messages", "--permission-mode", mode, "--permission-prompts", "none",
		"--settings", line.Settings,
	}
	if line.Resume {
		args = append(args, "--resume", line.Session)
	} else {
		args = append(args, "--session-id", line.Session)
	}
	if safeValue.MatchString(line.Name) {
		args = append(args, "--name", line.Name)
	}
	if line.Model != "claude" && line.Model != "inherit" && safeValue.MatchString(line.Model) {
		args = append(args, "--model", line.Model)
	}
	if safeValue.MatchString(line.AgentFile) {
		args = append(args, "--agent", line.AgentFile)
	}
	if len(line.Denied) > 0 {
		args = append(args, "--disallowedTools", strings.Join(line.Denied, ","))
	}
	if line.Budget > 0 {
		args = append(args, "--max-budget-usd", strconv.FormatFloat(line.Budget, 'f', 2, 64))
	}
	return args
}

// toolKinds are the tools behind each kind the New agent form offers. Reading is always allowed.
var toolKinds = map[string][]string{
	"edit":  {"Edit", "Write", "MultiEdit", "NotebookEdit"},
	"shell": {"Bash", "PowerShell"},
	"web":   {"WebFetch", "WebSearch"},
}

// deniedTools are the tools of the kinds left unticked, in a stable order. It can only take tools
// away, which is why passing it can't widen what a session may do.
func deniedTools(ticked []string) []string {
	if len(ticked) == 0 {
		return nil
	}
	var denied []string
	for _, kind := range []string{"edit", "shell", "web"} {
		if !slices.Contains(ticked, kind) {
			denied = append(denied, toolKinds[kind]...)
		}
	}
	return denied
}

// workFolder is the folder the agent's session runs in, as a full path.
func workFolder(agent *models.LiveAgent) string { return expandHome(agent.Folder) }

// userLine is one message for the process's stdin, as the Agent SDK's streaming input writes it.
func userLine(text string) []byte {
	line, _ := json.Marshal(map[string]any{
		"type": "user", "message": map[string]any{"role": "user", "content": text},
		"parent_tool_use_id": nil,
	})
	return append(line, '\n')
}

// write hands a line to the process. It never blocks, so a stuck process can't hold up the office.
func (r *run) write(line []byte) bool {
	r.inputMu.Lock()
	defer r.inputMu.Unlock()
	if r.closed {
		return false
	}
	select {
	case r.inbox <- line:
		return true
	default:
		return false
	}
}

func (r *run) closeInput() {
	r.inputMu.Lock()
	defer r.inputMu.Unlock()
	if !r.closed {
		r.closed = true
		close(r.inbox)
	}
}

// stop ends the process. Input closes first, because Claude Code cancels a waiting prompt as soon
// as its input ends, then SIGTERM stops any command it is running, and whatever is left after
// wait is killed along with anything it started.
func (r *run) stop(wait time.Duration) {
	r.ended.Store(true)
	r.closeInput()
	_ = terminateProcess(r.cmd.Process)
	go func() {
		select {
		case <-r.exited:
		case <-time.After(wait):
			killGroup(r.cmd.Process)
		}
	}()
}

// spawn starts the process for an agent's session. Call inside Do.
func (c *Connector) spawn(agent *models.LiveAgent, resume bool) (*run, error) {
	program := c.program()
	if program == "" {
		return nil, ErrNoClaude
	}
	if err := c.folderProblem(agent); err != nil {
		return nil, err
	}
	settings, err := c.Hook.SessionSettings()
	if err != nil {
		return nil, err
	}
	session := *agent.Session
	budget := 0.0
	if agent.DailyCostCap != nil {
		budget = *agent.DailyCostCap
	}
	args := runArgs(runLine{
		Session: session.ID, Name: agent.Name, Model: agent.Model, Mode: session.Mode,
		AgentFile: session.AgentFile, Settings: settings, Resume: resume,
		Denied: deniedTools(agent.AllowedTools), Budget: budget,
	})
	cmd := exec.CommandContext(context.Background(), program, args...) // #nosec G204 -- the program is found by its fixed name, and the arguments never reach a shell
	cmd.Dir = workFolder(agent)
	cmd.WaitDelay = endWait
	ownGroup(cmd)
	r := &run{
		agentID: agent.ID, cmd: cmd, stderr: &tailBuffer{}, inbox: make(chan []byte, inboxSize),
		exited: make(chan struct{}), lastUsed: time.Now(), live: map[int]*liveText{},
		tools: map[string]models.ConversationItem{}, denied: map[string]bool{},
	}
	cmd.Stderr = r.stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	// A pipe of our own, because Wait closes the one StdoutPipe makes, and the process's last lines
	// may still be in it.
	stdout, output, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd.Stdout = output
	err = cmd.Start()
	_ = output.Close()
	if err != nil {
		_ = stdout.Close()
		return nil, err
	}
	go func() {
		for line := range r.inbox {
			if _, err := stdin.Write(line); err != nil {
				break
			}
		}
		_ = stdin.Close()
	}()
	go c.watch(r, stdout)
	c.mu.Lock()
	c.runs[agent.ID] = r
	c.sessions[session.ID] = agent.ID
	c.mu.Unlock()
	session.Status, session.PID = models.SessionRunning, cmd.Process.Pid
	session.Resume = launch.ContinueCommand(workFolder(agent), session.ID)
	agent.Session = &session
	c.engine.Touch(agent)
	return r, nil
}

// watch reads the process's output until it ends, and deals with the ending.
func (c *Connector) watch(r *run, stdout *os.File) {
	read := make(chan struct{})
	go func() {
		c.read(r, stdout)
		close(read)
	}()
	_ = r.cmd.Wait()
	select {
	case <-read:
	case <-time.After(drainWait):
		_ = stdout.Close()
		<-read
	}
	_ = stdout.Close()
	close(r.exited)
	c.exited(r)
}

// exited updates the office after a process has gone. Its agent keeps its place, and the session
// is resumable, whatever happened.
func (c *Connector) exited(r *run) {
	_ = c.engine.Do(func() {
		c.mu.Lock()
		current := c.runs[r.agentID] == r
		if current {
			delete(c.runs, r.agentID)
		}
		delete(c.leaving, r)
		c.mu.Unlock()
		// One retired by Mabari has been dealt with, and a newer process may have taken over.
		if !current {
			return
		}
		agent := c.engine.Agent(r.agentID)
		if agent == nil || agent.Session == nil {
			return
		}
		c.closeLive(r, agent)
		c.markResumable(agent)
		switch {
		case r.ended.Load():
			// Stopped by Mabari itself shutting down. Its turn can be picked up again.
			c.engine.CancelApproval(agent)
			if agent.State.Active() || agent.State == models.StateApproval {
				agent.State = models.StateIdle
				c.engine.Touch(agent)
			}
		case agent.State == models.StatePaused:
			// An interrupt can end the process as well as the turn. Continue resumes it.
		case r.pending > 0 || agent.State.Active() || agent.State == models.StateApproval:
			why := "Claude Code stopped unexpectedly."
			if said := strings.TrimSpace(r.stderr.String()); said != "" {
				why += " " + said
			}
			c.fail(agent, why)
		}
	})
}

// markResumable records that the session has no process. Call inside Do.
func (c *Connector) markResumable(agent *models.LiveAgent) {
	if agent.Session == nil {
		return
	}
	session := *agent.Session
	session.Status, session.PID = models.SessionResumable, 0
	agent.Session = &session
	c.engine.Touch(agent)
}

// runAgent is the agent a run reports for, or nil once the run no longer speaks for it: one Mabari
// ended, including by a wipe, adds nothing to a conversation that may have been deleted. Call
// inside Do.
func (c *Connector) runAgent(r *run) *models.LiveAgent {
	c.mu.Lock()
	current := c.runs[r.agentID] == r
	c.mu.Unlock()
	if !current {
		return nil
	}
	return c.engine.Agent(r.agentID)
}

// retire ends a process that no longer speaks for its agent. Call inside Do.
func (c *Connector) retire(r *run) {
	c.mu.Lock()
	if c.runs[r.agentID] == r {
		delete(c.runs, r.agentID)
	}
	c.leaving[r] = struct{}{}
	c.mu.Unlock()
	r.stop(c.endWait)
}

// roomForRun makes sure one more process stays within the cap. A session waiting for its next
// message gives up its place, the longest waiting first, because it resumes with nothing lost.
// With every session busy, it says so. Call inside Do.
func (c *Connector) roomForRun() error {
	limit := c.engine.Settings().MaxSessions
	if limit <= 0 {
		limit = models.DefaultSessions
	}
	for {
		c.mu.Lock()
		live := len(c.runs)
		runs := make([]*run, 0, live)
		for _, r := range c.runs {
			runs = append(runs, r)
		}
		c.mu.Unlock()
		if live < limit {
			return nil
		}
		var longest *run
		for _, r := range runs {
			agent := c.engine.Agent(r.agentID)
			idle := agent == nil || (!agent.State.Active() && agent.Approval == nil)
			if idle && (longest == nil || r.lastUsed.Before(longest.lastUsed)) {
				longest = r
			}
		}
		if longest == nil {
			return CapError{Limit: limit}
		}
		c.retire(longest)
		if agent := c.engine.Agent(longest.agentID); agent != nil {
			c.markResumable(agent)
		}
	}
}

// liveRun is the agent's process, started again if it has none. Call inside Do.
func (c *Connector) liveRun(agent *models.LiveAgent) (*run, error) {
	c.mu.Lock()
	r := c.runs[agent.ID]
	c.mu.Unlock()
	if r != nil {
		return r, nil
	}
	if err := c.roomForRun(); err != nil {
		return nil, err
	}
	if _, err := os.Stat(workFolder(agent)); err != nil {
		return nil, errors.New(agent.Name + "'s folder " + agent.Folder + " is gone, so its session can't carry on.")
	}
	return c.spawn(agent, agent.Session.Started)
}

// deliverNow writes a message to the session, starting its process if it needs one. Call inside Do.
func (c *Connector) deliverNow(agent *models.LiveAgent, text string) error {
	r, err := c.liveRun(agent)
	if err != nil {
		return err
	}
	if !r.write(userLine(text)) {
		return errors.New(agent.Name + "'s session isn't taking messages just now.")
	}
	r.pending++
	r.lastUsed = time.Now()
	c.engine.Delivered(agent, text)
	c.heard(agent, text)
	agent.State, agent.Task, agent.Progress, agent.Error = models.StateThinking, clip(redact.Text(text), 120), 0, ""
	agent.PausedFrom = ""
	c.engine.AddEvent(agent, "instruction", "Received: "+clip(redact.Text(text), 120), nil)
	c.mu.Lock()
	c.delivered[agent.ID] = time.Now()
	c.mu.Unlock()
	c.engine.Touch(agent)
	return nil
}

// heard adds what the person sent to the conversation. Call inside Do.
func (c *Connector) heard(agent *models.LiveAgent, text string) {
	c.engine.Converse(agent.ID, models.ConversationItem{
		Kind: models.ConversationUser, Text: text, From: models.SaidInMabari,
	})
}

// notice adds something that happened to the session to the conversation. Call inside Do.
func (c *Connector) notice(agent *models.LiveAgent, text string) {
	c.engine.Converse(agent.ID, models.ConversationItem{Kind: models.ConversationNotice, Text: text})
}

// fail shows a session's failure on its agent and in the conversation. Call inside Do.
func (c *Connector) fail(agent *models.LiveAgent, why string) {
	why = clip(redact.Text(why), 300)
	c.engine.CancelApproval(agent)
	agent.State, agent.Error = models.StateError, why
	c.notice(agent, why)
	c.engine.AddEvent(agent, "error", why, nil)
	c.engine.Log(agent.Name, models.LogSession, "Claude Code session", why, "red")
	c.engine.Touch(agent)
}

// turnFinished is the session having nothing left to do. full is its last reply, already masked.
// Call inside Do.
func (c *Connector) turnFinished(agent *models.LiveAgent, full string) {
	agent.State, agent.Progress = models.StateDone, 1
	if said := clip(full, 90); said != "" {
		c.engine.SetReply(agent, said, 8000)
	}
	c.engine.Answered(agent, full)
	c.engine.Touch(agent)
	switch {
	case len(agent.Queued) > 0:
		// It came in too late for the turn's last checkpoint.
		c.deliverQueued(agent)
	case agent.Session != nil && agent.Session.Mode == runModePlan:
		c.askAboutPlan(agent, full)
	}
}

// deliverQueued sends everything waiting as one message. Call inside Do.
func (c *Connector) deliverQueued(agent *models.LiveAgent) {
	r, err := c.liveRun(agent)
	if err != nil {
		c.engine.Toast(err.Error())
		return
	}
	var lines []string
	for {
		instruction, ok := c.engine.NextQueued(agent)
		if !ok {
			break
		}
		lines = append(lines, instruction.Text)
		c.heard(agent, instruction.Text)
	}
	if len(lines) == 0 || !r.write(userLine(strings.Join(lines, "\n\n"))) {
		return
	}
	r.pending++
	r.lastUsed = time.Now()
	agent.State, agent.Progress = models.StateThinking, 0
	c.engine.Touch(agent)
}

// planSteps caps how much of a plan the approval card shows.
const planSteps = 12

// askAboutPlan puts the plan to the person. Claude Code offers ExitPlanMode only to a run with a
// permission host, and Mabari runs with none, so a plan session stops at its plan and Mabari asks
// here. Approving starts the process again out of plan mode. Call inside Do.
func (c *Connector) askAboutPlan(agent *models.LiveAgent, plan string) {
	project := agent.Name
	if agent.Project != nil {
		if found := c.engine.Project(*agent.Project); found != nil {
			project = found.Name
		}
	}
	var steps []string
	for _, line := range strings.Split(plan, "\n") {
		if line = strings.TrimSpace(line); line != "" && len(steps) < planSteps {
			steps = append(steps, clip(line, 160))
		}
	}
	c.engine.RequestApproval(agent, models.Approval{
		Type: models.ApprovalPlan, Title: "Approve the plan",
		Detail:    models.ApprovalDetail{Project: project, Steps: steps},
		Risk:      "Once approved, " + agent.Name + " can start changing things. Each risky action still asks you.",
		RiskLevel: models.RiskHigh,
	})
}

// planApproved is what a session is told when its plan goes ahead.
const planApproved = "The plan is approved. Go ahead with it."

// planDecided carries on from the person's answer about a plan. Call inside Do.
func (c *Connector) planDecided(agent *models.LiveAgent, approval models.Approval) {
	if approval.Decision == nil || *approval.Decision != models.DecisionAllowed {
		agent.State = models.StateDone
		c.engine.Touch(agent)
		if approval.Decision != nil && *approval.Decision == models.DecisionDenied {
			c.engine.Toast("Tell " + agent.Name + " what to change. It stays in plan mode until you approve.")
		}
		return
	}
	session := *agent.Session
	session.Mode = runModeDefault
	agent.Session = &session
	agent.State = models.StateThinking
	c.engine.Touch(agent)
	c.mu.Lock()
	old := c.runs[agent.ID]
	c.mu.Unlock()
	if old == nil {
		c.afterPlan(agent)
		return
	}
	// The mode is set on the command line, so the session starts again in the new one, once the
	// old process has let go of it.
	c.retire(old)
	c.markResumable(agent)
	id := agent.ID
	go func() {
		<-old.exited
		_ = c.engine.Do(func() {
			if agent := c.engine.Agent(id); agent != nil {
				c.afterPlan(agent)
			}
		})
	}()
}

func (c *Connector) afterPlan(agent *models.LiveAgent) {
	if err := c.deliverNow(agent, planApproved); err != nil {
		c.engine.Queue(agent, planApproved)
		agent.State = models.StateIdle
		c.engine.Touch(agent)
		c.engine.Toast(err.Error())
	}
}

// seatFor is the desk a new session sits at. Call inside Do.
func (c *Connector) seatFor(spec SessionSpec) (int, error) {
	if spec.Desk == nil {
		desk := models.FreeDesk(c.engine.Agents(), -1)
		if desk < 0 {
			return 0, ErrOfficeFull
		}
		return desk, nil
	}
	for _, agent := range c.engine.Agents() {
		if agent.Desk == *spec.Desk {
			return 0, ErrDeskTaken
		}
	}
	return *spec.Desk, nil
}

// StartSession seats a new agent and starts its Claude Code session, with no terminal. Call inside
// Do. It waits only for the process to start, not for it to do anything.
func (c *Connector) StartSession(spec SessionSpec) (*models.LiveAgent, error) {
	if c.program() == "" {
		return nil, ErrNoClaude
	}
	desk, err := c.seatFor(spec)
	if err != nil {
		return nil, err
	}
	if err := c.roomForRun(); err != nil {
		return nil, err
	}
	count := len(c.engine.Agents())
	agent := &models.LiveAgent{}
	agent.Name, agent.Provider, agent.Account = spec.Name, models.ProviderClaude, models.AccountClaudeCode
	agent.Source, agent.Model, agent.SubModel = Source, modelName(spec.Model), "inherit"
	agent.Desk, agent.Folder, agent.DefID = desk, spec.Folder, spec.DefID
	agent.Hue = models.Hues[count%len(models.Hues)]
	agent.Skin = models.Skins[count%len(models.Skins)]
	agent.Hair = models.Hairs[(count*3)%len(models.Hairs)]
	agent.AllowedTools = spec.Tools
	if spec.DailyCostCap > 0 {
		agent.DailyCostCap = &spec.DailyCostCap
	}
	agent.State, agent.Task = models.StateThinking, clip(orDefault(spec.Task, "Starting"), 120)
	agent.Queued, agent.Files = []models.Instruction{}, []string{}
	if spec.Project != "" {
		agent.Project = &spec.Project
	}
	mode := runModeDefault
	if spec.Plan {
		mode = runModePlan
	}
	agent.Session = &models.AgentSession{
		ID: newSessionID(), Status: models.SessionResumable, Mode: mode, AgentFile: spec.AgentFile,
	}
	c.engine.AddAgent(agent)
	r, err := c.spawn(agent, false)
	if err != nil {
		c.engine.RemoveAgent(agent.ID)
		return nil, err
	}
	c.notice(agent, "Session started in "+spec.Folder+".")
	c.engine.Log(agent.Name, models.LogSession, "Claude Code session started in "+spec.Folder, "Runs in Mabari", "ok")
	c.engine.Toast(agent.Name + " is walking in")
	prompt := orDefault(spec.Prompt, spec.Task)
	if prompt == "" {
		return agent, nil
	}
	if !r.write(userLine(prompt)) {
		return agent, nil
	}
	r.pending++
	c.engine.Delivered(agent, prompt)
	c.heard(agent, prompt)
	c.mu.Lock()
	c.delivered[agent.ID] = time.Now()
	c.mu.Unlock()
	return agent, nil
}

// ResumeSession gives Mabari a session to run: one that is resumable, or, with the person's
// knowledge, one started elsewhere. Anything waiting for it is sent. Call inside Do.
func (c *Connector) ResumeSession(agent *models.LiveAgent) error {
	if agent.Session == nil || agent.Source != Source || agent.Lead != nil {
		return errors.New(agent.Name + " has no session to continue.")
	}
	if agent.Session.Status == models.SessionRunning {
		return nil
	}
	if agent.Session.Status == models.SessionElsewhere {
		if agent.State.Active() {
			return errors.New(agent.Name + " is working in its own window. Wait for it to stop first.")
		}
		c.mu.Lock()
		c.sessions[agent.Session.ID] = agent.ID
		delete(c.tails, agent.ID)
		c.mu.Unlock()
		session := *agent.Session
		session.Status, session.Mode, session.Started = models.SessionResumable, runModeDefault, true
		session.Resume = launch.ContinueCommand(workFolder(agent), session.ID)
		agent.Session = &session
		c.engine.Touch(agent)
		c.engine.Log(agent.Name, models.LogSession, "Continued from Mabari", "Runs in Mabari", "ok")
		c.notice(agent, "Mabari took this session over from where it was.")
	}
	if len(agent.Queued) == 0 {
		return nil
	}
	if _, err := c.liveRun(agent); err != nil {
		return err
	}
	c.deliverQueued(agent)
	return nil
}

// ReleaseSession lets a session go, so it can be opened in a terminal without two programs writing
// to it. It stays resumable. Call inside Do.
func (c *Connector) ReleaseSession(agent *models.LiveAgent) error {
	if !agent.RunsHere() {
		return errors.New(agent.Name + " doesn't run in Mabari.")
	}
	if agent.State.Active() || agent.State == models.StateApproval {
		return errors.New(agent.Name + " is working. Interrupt it first.")
	}
	c.mu.Lock()
	r := c.runs[agent.ID]
	c.mu.Unlock()
	if r != nil {
		c.retire(r)
	}
	c.markResumable(agent)
	return nil
}

// Resume brings the office back after a restart. Claude Code keeps each session's transcript, so
// a session Mabari ran is resumable, not lost. Nothing starts by itself: it would spend the
// person's account with nobody asking. An approval that was waiting is settled, because the process
// that asked has gone and has been told no by now. Call inside Do, before serving.
func (c *Connector) Resume() {
	for _, agent := range c.engine.Agents() {
		if agent.Source != Source || agent.Lead != nil {
			continue
		}
		if agent.Session == nil {
			agent.Session = &models.AgentSession{ID: strings.TrimPrefix(agent.ID, "cc-"), Status: models.SessionElsewhere}
			c.engine.Touch(agent)
			continue
		}
		if !agent.RunsHere() {
			continue
		}
		endLeftover(agent.Session.PID, agent.Session.ID)
		c.mu.Lock()
		c.sessions[agent.Session.ID] = agent.ID
		c.mu.Unlock()
		c.engine.CancelApproval(agent)
		c.markResumable(agent)
		if agent.State.Active() || agent.State == models.StateApproval {
			agent.State = models.StateIdle
			c.engine.Touch(agent)
		}
	}
}

// endAll retires every process. Call inside Do.
func (c *Connector) endAll(keep map[string]bool) {
	c.mu.Lock()
	var ending []*run
	for id, r := range c.runs {
		if !keep[id] {
			ending = append(ending, r)
		}
	}
	for session, id := range c.sessions {
		if !keep[id] {
			delete(c.sessions, session)
		}
	}
	for id := range c.tails {
		if !keep[id] {
			delete(c.tails, id)
		}
	}
	c.mu.Unlock()
	for _, r := range ending {
		c.retire(r)
	}
}

// OfficeCleared ends the sessions of agents that are leaving with the office, such as when the demo
// loads: they would carry on working unseen, with nobody to ask. Call inside Do.
func (c *Connector) OfficeCleared(keep []string) {
	stays := map[string]bool{}
	for _, id := range keep {
		stays[id] = true
	}
	c.endAll(stays)
}

// Shutdown ends every process and waits for them, so none outlives Mabari, and each session is
// saved as resumable. Call outside Do.
func (c *Connector) Shutdown(ctx context.Context) {
	c.mu.Lock()
	all := make([]*run, 0, len(c.runs)+len(c.leaving))
	for _, r := range c.runs {
		all = append(all, r)
	}
	for r := range c.leaving {
		all = append(all, r)
	}
	c.mu.Unlock()
	for _, r := range all {
		r.stop(c.endWait)
	}
	for _, r := range all {
		select {
		case <-r.exited:
		case <-ctx.Done():
			killGroup(r.cmd.Process)
		}
	}
}
