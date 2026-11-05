// SPDX-License-Identifier: Apache-2.0

package codex

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/redact"
	"github.com/SamsonIdowu/mabari/internal/risk"
)

// Source marks agents that run in Codex threads.
const Source = "codex"

// ErrNotInstalled means there is no codex command on this computer.
var ErrNotInstalled = errors.New("the Codex CLI isn't installed: install it, then restart Mabari")

// callWait is how long one request to the app server may take.
const callWait = 30 * time.Second

type thread struct {
	agentID  string
	threadID string
	turnID   string
}

// Connector runs agents as Codex threads and shows them in the office.
type Connector struct {
	engine  *events.Engine
	version string

	mu      sync.Mutex
	client  *Client
	threads map[string]*thread // by thread id
	byAgent map[string]*thread
	replies map[string]func(any) // approval replies, by agent id
	changes map[string][]change  // proposed file changes, by item id
	loginID string
	// missing is set when Launch found no codex command, and cleared if one starts later.
	missing bool
}

type change struct {
	Path string `json:"path"`
	Kind any    `json:"kind"`
	Diff string `json:"diff"`
}

// New returns a connector. Register it with engine.AddConnector(Source, connector), then call
// Launch or Attach.
func New(engine *events.Engine, version string) *Connector {
	return &Connector{
		engine: engine, version: version,
		threads: map[string]*thread{}, byAgent: map[string]*thread{},
		replies: map[string]func(any){}, changes: map[string][]change{},
	}
}

// Missing reports whether Launch found no codex command on this computer. Accounts shows it on the
// ChatGPT card, with the install step, instead of leaving it to a message that fades. It takes
// only the connector's own lock, so the office can ask while it describes the accounts.
func (c *Connector) Missing() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.missing
}

// Launch starts `codex app-server` as a child process, if Codex is installed.
func (c *Connector) Launch(ctx context.Context) error {
	path, err := exec.LookPath("codex")
	c.mu.Lock()
	c.missing = err != nil
	c.mu.Unlock()
	if err != nil {
		// Show it on the account now, so a page already open learns what is missing.
		_ = c.engine.Do(c.touchAccount)
		return ErrNotInstalled
	}
	cmd := exec.CommandContext(ctx, path, "app-server") // #nosec G204 -- the user's own codex
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return c.Attach(ctx, stdin, stdout)
}

// Attach speaks to an app server over the given pipes: initialize, then read the account and
// models. Tests attach a fake server this way.
func (c *Connector) Attach(ctx context.Context, in io.Writer, out io.Reader) error {
	client := NewClient(in, out, c)
	c.mu.Lock()
	c.client = client
	c.mu.Unlock()
	call, cancel := context.WithTimeout(ctx, callWait)
	defer cancel()
	err := client.Call(call, "initialize", map[string]any{"clientInfo": map[string]string{
		"name": "mabari", "title": "Mabari", "version": c.version,
	}}, nil)
	if err != nil {
		return err
	}
	if err := client.Notify("initialized", map[string]any{}); err != nil {
		return err
	}
	return c.refreshAccount(ctx)
}

func (c *Connector) rpc() (*Client, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.client == nil {
		return nil, ErrNotInstalled
	}
	return c.client, nil
}

func (c *Connector) call(method string, params, out any) error {
	client, err := c.rpc()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), callWait)
	defer cancel()
	return client.Call(ctx, method, params, out)
}

// refreshAccount reads who is signed in and which models they get.
func (c *Connector) refreshAccount(ctx context.Context) error {
	client, err := c.rpc()
	if err != nil {
		return err
	}
	call, cancel := context.WithTimeout(ctx, callWait)
	defer cancel()
	var account struct {
		Account *struct {
			Type  string `json:"type"`
			Email string `json:"email"`
		} `json:"account"`
	}
	if err := client.Call(call, "account/read", map[string]any{}, &account); err != nil {
		return err
	}
	var list struct {
		Data []struct {
			ID     string `json:"id"`
			Hidden bool   `json:"hidden"`
		} `json:"data"`
	}
	names := []string{}
	if account.Account != nil {
		if err := client.Call(call, "model/list", map[string]any{}, &list); err == nil {
			for _, model := range list.Data {
				if !model.Hidden {
					names = append(names, model.ID)
				}
			}
		}
	}
	return c.engine.Do(func() {
		for _, existing := range c.engine.StoredAccounts() {
			if existing.Kind != models.AccountCodex {
				continue
			}
			existing.Status, existing.Email = models.AccountOff, nil
			if account.Account != nil {
				existing.Status = models.AccountConnected
				if account.Account.Email != "" {
					email := account.Account.Email
					existing.Email = &email
				}
			}
			if len(names) > 0 {
				existing.Models = names
			}
			c.engine.SetAccount(existing)
		}
		// The models Codex really offers decide which default is valid.
		c.engine.CorrectModels()
	})
}

// Login starts Codex's own ChatGPT sign in and returns the page to open. The account turns
// connected when Codex reports the sign in finished.
func (c *Connector) Login() (string, error) {
	var started struct {
		LoginID string `json:"loginId"`
		AuthURL string `json:"authUrl"`
	}
	if err := c.call("account/login/start", map[string]any{"type": "chatgpt"}, &started); err != nil {
		return "", err
	}
	if !strings.HasPrefix(started.AuthURL, "https://") {
		return "", errors.New("codex returned a sign-in page that isn't https")
	}
	c.mu.Lock()
	c.loginID = started.LoginID
	c.mu.Unlock()
	_ = c.engine.Do(func() { c.setStatus(models.AccountConnecting) })
	return started.AuthURL, nil
}

// Logout signs Codex out.
func (c *Connector) Logout() error {
	if err := c.call("account/logout", map[string]any{}, nil); err != nil {
		return err
	}
	return c.refreshAccount(context.Background())
}

// touchAccount tells every page the Codex account again, as it now reads. Call inside Do.
func (c *Connector) touchAccount() {
	for _, account := range c.engine.StoredAccounts() {
		if account.Kind == models.AccountCodex {
			c.engine.SetAccount(account)
		}
	}
}

// setStatus changes the Codex account's status. Call inside Do.
func (c *Connector) setStatus(status models.AccountStatus) {
	for _, account := range c.engine.StoredAccounts() {
		if account.Kind == models.AccountCodex {
			account.Status = status
			c.engine.SetAccount(account)
		}
	}
}

// StartAgent seats a new agent and starts its Codex thread and first turn in the background.
// Call inside Do.
func (c *Connector) StartAgent(agent *models.LiveAgent) {
	agent.Source = Source
	agent.State = models.StateThinking
	c.engine.Touch(agent)
	task, model, folder, id := agent.Task, agent.Model, agent.Folder, agent.ID
	go func() {
		var started struct {
			Thread struct {
				ID string `json:"id"`
			} `json:"thread"`
		}
		params := map[string]any{
			"model": model, "approvalPolicy": "on-request", "sandbox": "workspace-write",
		}
		if folder != "" {
			params["cwd"] = folder
		}
		if err := c.call("thread/start", params, &started); err != nil {
			c.fail(id, err)
			return
		}
		t := &thread{agentID: id, threadID: started.Thread.ID}
		c.mu.Lock()
		c.threads[t.threadID] = t
		c.byAgent[id] = t
		c.mu.Unlock()
		c.startTurn(t, task)
	}()
}

func textInput(text string) []map[string]string {
	return []map[string]string{{"type": "text", "text": text}}
}

func (c *Connector) startTurn(t *thread, text string) {
	var started struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if err := c.call("turn/start", map[string]any{"threadId": t.threadID, "input": textInput(text)}, &started); err != nil {
		c.fail(t.agentID, err)
		return
	}
	c.mu.Lock()
	t.turnID = started.Turn.ID
	c.mu.Unlock()
}

func (c *Connector) fail(agentID string, err error) {
	slog.Warn("codex request failed", "error", err)
	_ = c.engine.Do(func() {
		if agent := c.engine.Agent(agentID); agent != nil {
			agent.State = models.StateError
			agent.Error = clip(err.Error(), 160)
			c.engine.Touch(agent)
		}
	})
}

func clip(text string, limit int) string {
	text = strings.TrimSpace(strings.SplitN(redact.Text(text), "\n", 2)[0])
	if runes := []rune(text); len(runes) > limit {
		return string(runes[:limit-1]) + "…"
	}
	return text
}

// params common to Codex notifications and requests.
type event struct {
	ThreadID string `json:"threadId"`
	TurnID   string `json:"turnId"`
	ItemID   string `json:"itemId"`
	Reason   string `json:"reason"`
	Command  any    `json:"command"`
	Cwd      string `json:"cwd"`
	LoginID  string `json:"loginId"`
	Success  bool   `json:"success"`
	Turn     *struct {
		ID     string `json:"id"`
		Status string `json:"status"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	} `json:"turn"`
	Item *struct {
		ID      string   `json:"id"`
		Type    string   `json:"type"`
		Command any      `json:"command"`
		Text    string   `json:"text"`
		Query   string   `json:"query"`
		Tool    string   `json:"tool"`
		Server  string   `json:"server"`
		Changes []change `json:"changes"`
	} `json:"item"`
}

// commandText joins a command that may come as a string or as a list of words.
func commandText(command any) string {
	switch value := command.(type) {
	case string:
		return value
	case []any:
		words := make([]string, 0, len(value))
		for _, word := range value {
			if text, ok := word.(string); ok {
				words = append(words, text)
			}
		}
		return strings.Join(words, " ")
	}
	return ""
}

// agentFor finds the agent working in a thread. Call inside Do.
func (c *Connector) agentFor(threadID string) (*models.LiveAgent, *thread) {
	c.mu.Lock()
	t := c.threads[threadID]
	c.mu.Unlock()
	if t == nil {
		return nil, nil
	}
	return c.engine.Agent(t.agentID), t
}

// Notify handles what Codex reports as a thread runs.
func (c *Connector) Notify(method string, params json.RawMessage) {
	var e event
	_ = json.Unmarshal(params, &e)
	switch method {
	// These run on their own goroutine: this one reads the replies they wait for.
	case "account/login/completed":
		if e.Success {
			go func() { _ = c.refreshAccount(context.Background()) }()
		} else {
			go func() { _ = c.engine.Do(func() { c.setStatus(models.AccountOff) }) }()
		}
		return
	case "account/updated":
		go func() { _ = c.refreshAccount(context.Background()) }()
		return
	}
	_ = c.engine.Do(func() {
		agent, t := c.agentFor(e.ThreadID)
		if agent == nil {
			return
		}
		switch method {
		case "turn/started":
			if e.Turn != nil {
				c.mu.Lock()
				t.turnID = e.Turn.ID
				c.mu.Unlock()
			}
			agent.State, agent.Error = models.StateThinking, ""
		case "item/started":
			c.itemStarted(agent, e)
		case "item/completed":
			if e.Item != nil && e.Item.Type == "agentMessage" && e.Item.Text != "" {
				full := redact.Text(e.Item.Text)
				c.engine.SetReply(agent, clip(full, 90), 8000)
				c.engine.Answered(agent, full)
			}
		case "turn/completed":
			c.mu.Lock()
			t.turnID = ""
			c.mu.Unlock()
			status := ""
			if e.Turn != nil {
				status = e.Turn.Status
			}
			switch status {
			case "interrupted":
				agent.State = models.StatePaused
			case "failed":
				agent.State = models.StateError
				if e.Turn.Error != nil {
					agent.Error = clip(e.Turn.Error.Message, 160)
				}
			default:
				agent.State, agent.Progress = models.StateDone, 1
				c.engine.AddEvent(agent, "done", "Finished: "+agent.Task, nil)
			}
			// Whatever waited for a checkpoint gets it now, however the turn ended: this is the
			// last one it will see, so it must not be left queued.
			c.deliverQueued(agent)
		}
		c.engine.Touch(agent)
	})
}

// itemStarted shows a step as it begins. Call inside Do.
func (c *Connector) itemStarted(agent *models.LiveAgent, e event) {
	if e.Item == nil {
		return
	}
	item := e.Item
	switch item.Type {
	case "commandExecution":
		agent.State = models.StateRunning
		c.engine.AddEvent(agent, "shell", clip(commandText(item.Command), 160), nil)
	case "fileChange":
		agent.State = models.StateEditing
		c.mu.Lock()
		c.changes[item.ID] = item.Changes
		c.mu.Unlock()
		for _, changed := range item.Changes {
			c.engine.AddEvent(agent, "edit", clip("Edit "+changed.Path, 160), nil)
		}
	case "reasoning":
		agent.State = models.StateThinking
	case "webSearch":
		agent.State = models.StateBrowsing
		c.engine.AddEvent(agent, "search", clip("Look up "+item.Query, 160), nil)
	case "mcpToolCall":
		agent.State = models.StateRunning
		c.engine.AddEvent(agent, "tool", clip(item.Server+" "+item.Tool, 160), nil)
	}
}

// shellSpecial marks words that only mean something once a shell reads them.
const shellSpecial = " \t\n'\"`$\\|&;<>(){}*?[]#~"

// commandWords turns a command into one string for the risk rules. A list of words is joined
// only when no word needs quoting; otherwise the join could read differently to a shell, so the
// command counts as risky.
func commandWords(command any) (string, bool) {
	words, isList := command.([]any)
	if !isList {
		text, _ := command.(string)
		return text, true
	}
	parts := make([]string, 0, len(words))
	for _, word := range words {
		text, ok := word.(string)
		if !ok || text == "" || strings.ContainsAny(text, shellSpecial) {
			return commandText(command), false
		}
		parts = append(parts, text)
	}
	return strings.Join(parts, " "), true
}

// risky is the verdict for anything Mabari can't judge.
func risky(reason string) risk.Verdict { return risk.Verdict{Level: models.RiskHigh, Reason: reason} }

// approvalFor describes an approval request against the agent's own folder, never the folder
// Codex names, so a request can't move the goalposts. It returns false when the request can't be
// shown truthfully, and is then declined.
func (c *Connector) approvalFor(method string, e event, folder string) (models.Approval, bool) {
	switch method {
	case "item/commandExecution/requestApproval":
		command, plain := commandWords(e.Command)
		verdict := risk.Classify(risk.Action{Kind: risk.KindCommand, Command: command, Folder: folder})
		switch {
		case !plain:
			verdict = risky("The command has quoted or special words, so Mabari can't judge it.")
		case !risk.SameFolder(e.Cwd, folder):
			verdict = risky("It runs in " + e.Cwd + ", not the agent's folder.")
		}
		return models.Approval{
			Type: models.ApprovalCommand, Title: "Run a command",
			Detail: models.ApprovalDetail{Cmd: redact.Text(commandText(e.Command))},
			Risk:   verdict.Reason, RiskLevel: verdict.Level,
		}, true
	case "item/fileChange/requestApproval":
		c.mu.Lock()
		changes := c.changes[e.ItemID]
		c.mu.Unlock()
		if len(changes) == 0 {
			return models.Approval{}, false
		}
		paths := make([]string, 0, len(changes))
		verdict := risk.Verdict{Level: models.RiskLow}
		for _, changed := range changes {
			paths = append(paths, changed.Path)
			one := risk.Classify(risk.Action{Kind: risk.KindEdit, Path: changed.Path, Folder: folder})
			switch {
			case !filepath.IsAbs(changed.Path):
				one = risky("A changed path isn't a full path, so Mabari can't tell where it is.")
			case !risk.SameFolder(e.Cwd, folder):
				one = risky("Codex is working in " + e.Cwd + ", not the agent's folder.")
			}
			if one.Level != models.RiskLow || verdict.Reason == "" {
				verdict = one
			}
			if one.Level != models.RiskLow {
				break
			}
		}
		lines, cut := diffLines(changes)
		if cut {
			verdict = risky("The change is longer than the card can show.")
		}
		if len(changes) > 1 && verdict.Level == models.RiskLow {
			verdict.Reason = "Changes " + strconv.Itoa(len(changes)) + " files in the working folder."
		}
		return models.Approval{
			Type: models.ApprovalFile, Title: "Change " + strconv.Itoa(len(changes)) + " file" + plural(len(changes)),
			Detail: models.ApprovalDetail{Path: strings.Join(paths, ", "), Lines: lines},
			Risk:   verdict.Reason, RiskLevel: verdict.Level,
		}, true
	}
	return models.Approval{}, false
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// Request handles approvals Codex asks for. Anything Mabari can't show truthfully is declined,
// so Codex never waits on something nobody can judge.
func (c *Connector) Request(method string, params json.RawMessage, reply func(any)) {
	var e event
	_ = json.Unmarshal(params, &e)
	_ = c.engine.Do(func() {
		agent, _ := c.agentFor(e.ThreadID)
		if agent == nil {
			reply(map[string]string{"decision": "decline"})
			return
		}
		approval, ok := c.approvalFor(method, e, agent.Folder)
		if !ok {
			reply(map[string]string{"decision": "decline"})
			return
		}
		if e.Reason != "" {
			approval.Risk = clip(e.Reason, 160) + " " + approval.Risk
		}
		c.mu.Lock()
		c.replies[agent.ID] = reply
		c.mu.Unlock()
		c.engine.RequestApproval(agent, approval)
	})
}

// maxDiffLines keeps an approval card readable.
const maxDiffLines = 40

// diffLines shows the changes, and reports whether they were cut short.
func diffLines(changes []change) ([]models.DiffLine, bool) {
	var lines []models.DiffLine
	for _, changed := range changes {
		for _, line := range strings.Split(redact.Text(changed.Diff), "\n") {
			if len(lines) >= maxDiffLines {
				return lines, true
			}
			kind := "ctx"
			switch {
			case strings.HasPrefix(line, "+++"), strings.HasPrefix(line, "---"), strings.HasPrefix(line, "@@"):
				continue
			case strings.HasPrefix(line, "+"):
				kind, line = "add", line[1:]
			case strings.HasPrefix(line, "-"):
				kind, line = "del", line[1:]
			case strings.HasPrefix(line, " "):
				line = line[1:]
			}
			lines = append(lines, models.DiffLine{Kind: kind, Text: line})
		}
	}
	return lines, false
}

func (c *Connector) takeReply(agentID string) func(any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	reply := c.replies[agentID]
	delete(c.replies, agentID)
	return reply
}

// Start does nothing: Launch starts the app server.
func (c *Connector) Start() {}

// Stop does nothing; the app server stops with Mabari.
func (c *Connector) Stop() {}

// Decide answers Codex's approval request. Call inside Do.
func (c *Connector) Decide(agent *models.LiveAgent, approval models.Approval) {
	if reply := c.takeReply(agent.ID); reply != nil {
		decision := "decline"
		if approval.Decision != nil && *approval.Decision == models.DecisionAllowed {
			decision = "accept"
		}
		go reply(map[string]string{"decision": decision})
	}
	// Codex carries on with its turn whichever way it went: a decline tells it the step was
	// refused, and it chooses what to do next. So the agent is no longer waiting on you, and no
	// longer counts as needing you, after a Deny as after an Allow (REV-1).
	if agent.State == models.StateApproval {
		agent.State = models.StateThinking
	}
	// What was sent while the turn waited on this decision reaches it now.
	c.deliverQueued(agent)
}

// deliverQueued passes on, oldest first, the messages that waited for the agent to carry on. A
// thread that has gone keeps them waiting. While a turn runs they all steer it. With no turn
// running the first starts the next turn, and the rest wait for that one to end, so only one turn
// is ever started. Call inside Do.
func (c *Connector) deliverQueued(agent *models.LiveAgent) {
	c.mu.Lock()
	t := c.byAgent[agent.ID]
	c.mu.Unlock()
	for t != nil {
		c.mu.Lock()
		idle := t.turnID == ""
		c.mu.Unlock()
		instruction, ok := c.engine.NextQueued(agent)
		if !ok {
			return
		}
		c.pass(agent, instruction.Text)
		if idle {
			return
		}
	}
}

// Instruct steers the running turn, or starts a new turn if the thread is idle. A turn waiting on
// your approval can't read anything until you decide, so a message to it waits for the decision,
// and isn't reported as delivered before then. Whether it waits is decided by the approval card
// being open, not by the agent's state: after a decision there is no card, and nothing more to
// wait for.
func (c *Connector) Instruct(agent *models.LiveAgent, text string) {
	c.mu.Lock()
	running := c.byAgent[agent.ID] != nil
	c.mu.Unlock()
	if !running {
		c.engine.Toast(agent.Name + " isn't running in Codex yet. Try again in a moment.")
		return
	}
	if agent.Approval != nil {
		c.engine.Queue(agent, text)
		return
	}
	c.engine.Delivered(agent, text)
	c.pass(agent, text)
}

// pass gives text to the agent's thread, steering the turn it is on or starting a new one. Call
// inside Do.
func (c *Connector) pass(agent *models.LiveAgent, text string) {
	c.mu.Lock()
	t := c.byAgent[agent.ID]
	turn := ""
	if t != nil {
		turn = t.turnID
	}
	c.mu.Unlock()
	if t == nil {
		return
	}
	c.engine.AddEvent(agent, "instruction", "Received: "+clip(text, 120), nil)
	if turn == "" {
		agent.Task, agent.Progress, agent.State = clip(models.WithoutName(text), 120), 0, models.StateThinking
		c.engine.Touch(agent)
		go c.startTurn(t, text)
		return
	}
	go func() {
		err := c.call("turn/steer", map[string]any{
			"threadId": t.threadID, "input": textInput(text), "expectedTurnId": turn,
		}, nil)
		if err != nil {
			// The turn ended in between, so the message starts the next one.
			c.startTurn(t, text)
		}
	}()
}

// Interrupt ends the running turn. The thread stays, so a new instruction carries on.
func (c *Connector) Interrupt(agent *models.LiveAgent) {
	c.mu.Lock()
	t := c.byAgent[agent.ID]
	c.mu.Unlock()
	if t == nil || t.turnID == "" {
		return
	}
	thread, turn := t.threadID, t.turnID
	go func() { _ = c.call("turn/interrupt", map[string]any{"threadId": thread, "turnId": turn}, nil) }()
}

// Continue starts a new turn that picks up where the interrupted one stopped. Call inside Do.
func (c *Connector) Continue(agent *models.LiveAgent) {
	c.Instruct(agent, "Continue where you stopped.")
}

// StopAgent interrupts the thread and takes the agent out of the office. Call inside Do.
func (c *Connector) StopAgent(agent *models.LiveAgent) {
	c.Interrupt(agent)
	if reply := c.takeReply(agent.ID); reply != nil {
		go reply(map[string]string{"decision": "cancel"})
	}
	c.mu.Lock()
	if t := c.byAgent[agent.ID]; t != nil {
		delete(c.threads, t.threadID)
	}
	delete(c.byAgent, agent.ID)
	c.mu.Unlock()
	c.engine.Log(agent.Name, models.LogInstruction, "Stop session", "Stopped", "")
	c.engine.RemoveAgent(agent.ID)
}

// Retry runs the agent's task again as a new turn.
func (c *Connector) Retry(agent *models.LiveAgent) {
	c.mu.Lock()
	t := c.byAgent[agent.ID]
	c.mu.Unlock()
	if t == nil {
		return
	}
	agent.State, agent.Error = models.StateThinking, ""
	c.engine.Touch(agent)
	go c.startTurn(t, agent.Task)
}

// AddSubagent isn't offered for Codex threads yet.
func (c *Connector) AddSubagent(*models.LiveAgent, string, string, string) *models.LiveAgent {
	return nil
}

// Models lists the models Codex reported for the signed-in account.
func (c *Connector) Models() []string {
	for _, account := range c.engine.StoredAccounts() {
		if account.Kind == models.AccountCodex {
			return account.Models
		}
	}
	return nil
}
