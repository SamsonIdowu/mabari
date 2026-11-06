// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

// These tests run real child processes through the connector. The child is fakeclaude, built here
// and handed over by path, so the real claude can't be reached. It follows the documented permission
// rules and writes to $FAKE_CLAUDE_RAN only when an action really happens, which is how a test
// proves that a denied action didn't. Its hooks reach the connector through files instead of a port,
// the one part of the chain not covered here.

var (
	fakeOnce sync.Once
	fakePath string
	fakeErr  error
)

func fakeClaude(t *testing.T) string {
	t.Helper()
	fakeOnce.Do(func() {
		dir, err := os.MkdirTemp("", "fake-claude-")
		if err != nil {
			fakeErr = err
			return
		}
		fakePath = filepath.Join(dir, "claude")
		// #nosec G204 -- a fixed command in a test
		out, err := exec.CommandContext(context.Background(), "go", "build", "-o", fakePath, "./fakeclaude").CombinedOutput()
		if err != nil {
			fakeErr = errors.New(string(out))
		}
	})
	if fakeErr != nil {
		t.Fatal(fakeErr)
	}
	return fakePath
}

type bench struct {
	t      *testing.T
	c      *Connector
	engine *events.Engine
	folder string
	config string
	ran    string
	logs   string
	hooks  string
	// down makes every gating hook fail, as when Mabari can't be reached.
	mu       sync.Mutex
	down     bool
	settings int
	answers  sync.WaitGroup
}

func newBench(t *testing.T) *bench {
	t.Helper()
	program := fakeClaude(t)
	c, engine := newConnector(t)
	// Not t.TempDir: a hook still being answered may write here after a test has what it needs.
	root, err := os.MkdirTemp("", "bench-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	b := &bench{
		t: t, c: c, engine: engine, folder: filepath.Join(root, "shop"), config: filepath.Join(root, "config"),
		ran: filepath.Join(root, "ran"), logs: filepath.Join(root, "logs"), hooks: filepath.Join(root, "hooks"),
	}
	for _, dir := range []string{b.folder, b.config, b.logs, b.hooks} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("CLAUDE_CONFIG_DIR", b.config)
	t.Setenv("FAKE_CLAUDE_RAN", b.ran)
	t.Setenv("FAKE_CLAUDE_LOG", b.logs)
	t.Setenv("FAKE_HOOK_DIR", b.hooks)
	c.Program = func() string { return program }
	c.Hook = Hook{Binary: program, Port: 1}
	c.ConfigDir = b.config
	c.endWait = 2 * time.Second
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		b.bridge(ctx)
	}()
	t.Cleanup(func() {
		ending, finish := context.WithTimeout(context.Background(), 5*time.Second)
		defer finish()
		c.Shutdown(ending)
		cancel()
		<-done
		b.answers.Wait()
	})
	return b
}

// bridge answers the hook calls the fake leaves as files, as the server would.
func (b *bench) bridge(ctx context.Context) {
	seen := map[string]bool{}
	for ctx.Err() == nil {
		calls, _ := filepath.Glob(filepath.Join(b.hooks, "*.call"))
		for _, call := range calls {
			if seen[call] {
				continue
			}
			seen[call] = true
			b.answers.Go(func() { b.answer(ctx, call) })
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func (b *bench) answer(ctx context.Context, call string) {
	body, err := os.ReadFile(call) // #nosec G304 -- a test's own file
	if err != nil {
		return
	}
	parts := strings.Split(filepath.Base(call), ".")
	kind, event := parts[1], parts[2]
	b.mu.Lock()
	down := b.down
	if kind == "settings" {
		b.settings++
	}
	b.mu.Unlock()
	var reply []byte
	switch {
	case down && Gates(event):
		reply = []byte("exit 2")
	case kind == "run":
		reply = b.c.HandleRun(ctx, body)
	default:
		reply = b.c.Handle(ctx, body)
	}
	_ = os.WriteFile(strings.TrimSuffix(call, ".call")+".tmp2", reply, 0o600)
	_ = os.Rename(strings.TrimSuffix(call, ".call")+".tmp2", strings.TrimSuffix(call, ".call")+".reply")
}

func (b *bench) start(prompt string, change ...func(*SessionSpec)) *models.LiveAgent {
	b.t.Helper()
	spec := SessionSpec{Name: "Juniper", Folder: b.folder, Task: prompt}
	for _, apply := range change {
		apply(&spec)
	}
	var agent *models.LiveAgent
	var err error
	_ = b.engine.Do(func() { agent, err = b.c.StartSession(spec) })
	if err != nil {
		b.t.Fatal(err)
	}
	return agent
}

// read gives a copy of the agent as it is now.
func (b *bench) read(id string) models.LiveAgent {
	var copied models.LiveAgent
	_ = b.engine.Do(func() {
		if agent := b.engine.Agent(id); agent != nil {
			copied = *agent
		}
	})
	return copied
}

func (b *bench) until(what string, ok func() bool) {
	b.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			b.t.Fatalf("waited too long for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (b *bench) untilState(id string, state models.AgentState) {
	b.t.Helper()
	b.until("state "+string(state), func() bool { return b.read(id).State == state })
}

func (b *bench) conversation(id string) []models.ConversationItem {
	b.t.Helper()
	items, _, err := b.engine.Store().Conversation(context.Background(), id, 0, 500)
	if err != nil {
		b.t.Fatal(err)
	}
	return items
}

// said is everything in the conversation, as "kind: text" lines.
func (b *bench) said(id string) []string {
	b.t.Helper()
	var lines []string
	for _, item := range b.conversation(id) {
		text := item.Text
		if item.Tool != nil {
			text = item.Tool.Name + " " + string(item.Tool.State)
		}
		lines = append(lines, string(item.Kind)+": "+text)
	}
	return lines
}

// actions is how many actions really happened.
func (b *bench) actions() int {
	data, err := os.ReadFile(b.ran)
	if errors.Is(err, os.ErrNotExist) {
		return 0
	}
	if err != nil {
		b.t.Fatal(err)
	}
	return strings.Count(string(data), "\n")
}

// argsOf is every command line the session was started with.
func (b *bench) argsOf(session string) [][]string {
	b.t.Helper()
	data, err := os.ReadFile(filepath.Join(b.logs, session+".args"))
	if err != nil {
		b.t.Fatal(err)
	}
	var all [][]string
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var args []string
		if err := json.Unmarshal([]byte(line), &args); err != nil {
			b.t.Fatal(err)
		}
		all = append(all, args)
	}
	return all
}

func (b *bench) instruct(id, text string) {
	_ = b.engine.Do(func() {
		if agent := b.engine.Agent(id); agent != nil {
			b.c.Instruct(agent, text)
		}
	})
}

func (b *bench) decide(id, decision string) {
	b.t.Helper()
	b.until("an approval", func() bool { return b.read(id).Approval != nil })
	_ = b.engine.Do(func() {
		if agent := b.engine.Agent(id); agent != nil && agent.Approval != nil {
			b.engine.Decide(agent.Approval.ID, decision)
		}
	})
}

func hasArg(args []string, flag, value string) bool {
	index := slices.Index(args, flag)
	return index >= 0 && index+1 < len(args) && args[index+1] == value
}

func processGone(pid int) bool {
	return errors.Is(syscall.Kill(pid, 0), syscall.ESRCH)
}

func TestASessionStartsWithNoTerminalAndKeepsItsConversation(t *testing.T) {
	b := newBench(t)
	agent := b.start("say hello")
	b.untilState(agent.ID, models.StateDone)
	saved := b.read(agent.ID)
	if saved.Session == nil || saved.Session.Status != models.SessionRunning || saved.Session.PID == 0 {
		t.Fatalf("session = %+v", saved.Session)
	}
	if saved.Source != Source || saved.Provider != models.ProviderClaude {
		t.Fatalf("agent = %+v", saved.Agent)
	}
	b.until("the reply", func() bool {
		return slices.Contains(b.said(agent.ID), "assistant: Done: say hello")
	})
	want := []string{"notice: Session started in " + b.folder + ".", "user: say hello", "assistant: Done: say hello"}
	if got := b.said(agent.ID); !slices.Equal(got, want) {
		t.Fatalf("conversation = %q", got)
	}
	if saved := b.read(agent.ID); len(saved.Asked) != 1 || saved.Asked[0].Reply != "Done: say hello" {
		t.Fatalf("asked = %+v", saved.Asked)
	}
	if !strings.Contains(saved.Session.Resume, "claude --resume "+saved.Session.ID) {
		t.Fatalf("resume = %q", saved.Session.Resume)
	}
}

// Nothing Mabari passes grants anything, whatever a person typed for a name or a model.
func TestTheCommandLineNeverGrantsAnything(t *testing.T) {
	forbidden := []string{
		"--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--allowedTools",
		"--allowed-tools", "--bare", "--permission-prompt-tool", "--add-dir", "bypassPermissions",
		"acceptEdits", "auto", "dontAsk",
	}
	for _, hostile := range []string{"--dangerously-skip-permissions", "-p", "--bare", "x --bare"} {
		args := runArgs(runLine{
			Session: "s", Name: hostile, Model: hostile, AgentFile: hostile, Settings: "{}", Mode: hostile,
		})
		for _, arg := range args {
			if slices.Contains(forbidden, arg) {
				t.Errorf("name %q put %q on the command line", hostile, arg)
			}
		}
		if !hasArg(args, "--permission-mode", "default") || !hasArg(args, "--permission-prompts", "none") {
			t.Errorf("name %q changed the permission flags: %q", hostile, args)
		}
	}
	args := runArgs(runLine{Session: "s", Mode: "plan", Settings: "{}", Resume: true, Model: "claude-sonnet-4-5", Name: "Mori 2"})
	if !hasArg(args, "--permission-mode", "plan") || !hasArg(args, "--resume", "s") ||
		!hasArg(args, "--model", "claude-sonnet-4-5") || !hasArg(args, "--name", "Mori 2") {
		t.Fatalf("args = %q", args)
	}
}

// A session runs on per-process hooks, so nothing has to touch the real settings file.
func TestHooksArePassedPerProcessAndGatesFailClosed(t *testing.T) {
	b := newBench(t)
	agent := b.start("hello")
	b.untilState(agent.ID, models.StateDone)
	args := b.argsOf(agent.Session.ID)[0]
	index := slices.Index(args, "--settings")
	var settings struct {
		Hooks map[string][]struct {
			Hooks []struct {
				Command   string   `json:"command"`
				Args      []string `json:"args"`
				Timeout   int      `json:"timeout"`
				OnFailure string   `json:"onFailure"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal([]byte(args[index+1]), &settings); err != nil {
		t.Fatal(err)
	}
	for _, event := range []string{"PermissionRequest", "PreToolUse"} {
		handler := settings.Hooks[event][0].Hooks[0]
		if handler.OnFailure != "block" || !slices.Contains(handler.Args, "--run") {
			t.Errorf("%s: %+v", event, handler)
		}
	}
	if wait := settings.Hooks["PermissionRequest"][0].Hooks[0].Timeout; wait <= SessionPermissionWait {
		t.Errorf("the hook gives up after %d seconds, before Mabari does", wait)
	}
	if _, listed := settings.Hooks["MessageDisplay"]; listed {
		t.Error("MessageDisplay would repeat what the stream carries")
	}
	if _, err := os.Stat(filepath.Join(b.config, "settings.json")); !errors.Is(err, os.ErrNotExist) {
		t.Error("a settings file was written")
	}
}

func TestAnInstructionToAnIdleSessionLandsAtOnce(t *testing.T) {
	b := newBench(t)
	agent := b.start("first")
	b.untilState(agent.ID, models.StateDone)
	pid := b.read(agent.ID).Session.PID
	b.instruct(agent.ID, "second")
	if saved := b.read(agent.ID); len(saved.Queued) != 0 {
		t.Fatalf("queued instead of delivered: %+v", saved.Queued)
	}
	b.until("the reply", func() bool {
		return slices.Contains(b.said(agent.ID), "assistant: Done: second")
	})
	if got := b.read(agent.ID).Session.PID; got != pid {
		t.Fatalf("started a new process, %d after %d", got, pid)
	}
}

// Mid-run stays as it was: queued, and read at the next checkpoint.
func TestAnInstructionWhileWorkingWaitsForACheckpoint(t *testing.T) {
	b := newBench(t)
	agent := b.start("fake:slow 12")
	b.until("work to start", func() bool { return b.read(agent.ID).State.Active() })
	b.instruct(agent.ID, "and this")
	if saved := b.read(agent.ID); len(saved.Queued) != 1 {
		t.Fatalf("queued = %+v", saved.Queued)
	}
	b.until("it to be delivered", func() bool {
		return slices.Contains(b.said(agent.ID), "user: and this")
	})
	if saved := b.read(agent.ID); len(saved.Queued) != 0 {
		t.Fatalf("still queued: %+v", saved.Queued)
	}
}

func TestARiskyActionWaitsForAClickAndOnlyThenRuns(t *testing.T) {
	b := newBench(t)
	agent := b.start("fake:bash rm -rf build")
	b.until("the approval", func() bool { return b.read(agent.ID).Approval != nil })
	if saved := b.read(agent.ID); saved.State != models.StateApproval || saved.Approval.Detail.Cmd != "rm -rf build" {
		t.Fatalf("state %s, approval %+v", saved.State, saved.Approval)
	}
	// It stops and stays stopped, however long nobody answers within the wait.
	time.Sleep(150 * time.Millisecond)
	if got := b.actions(); got != 0 {
		t.Fatalf("%d actions ran before any click", got)
	}
	b.decide(agent.ID, models.DecisionAllowed)
	b.until("the action", func() bool { return b.actions() == 1 })
	b.untilState(agent.ID, models.StateDone)
	if said := b.said(agent.ID); !slices.Contains(said, "tool: Bash done") {
		t.Fatalf("conversation = %q", said)
	}
}

func TestADeniedActionNeverRuns(t *testing.T) {
	b := newBench(t)
	agent := b.start("fake:bash rm -rf build")
	b.decide(agent.ID, models.DecisionDenied)
	b.untilState(agent.ID, models.StateDone)
	if got := b.actions(); got != 0 {
		t.Fatalf("%d actions ran after a denial", got)
	}
	if said := b.said(agent.ID); !slices.Contains(said, "tool: Bash denied") {
		t.Fatalf("conversation = %q", said)
	}
}

// The spec's central promise: with no answer, it is denied.
func TestNoAnswerDeniesTheAction(t *testing.T) {
	b := newBench(t)
	b.c.SetRunWait(100 * time.Millisecond)
	agent := b.start("fake:bash rm -rf build")
	b.untilState(agent.ID, models.StateDone)
	if got := b.actions(); got != 0 {
		t.Fatalf("%d actions ran with no answer", got)
	}
	saved := b.read(agent.ID)
	if saved.Approval != nil {
		t.Fatalf("still waiting: %+v", saved.Approval)
	}
	if said := b.said(agent.ID); !slices.Contains(said, "tool: Bash denied") {
		t.Fatalf("conversation = %q", said)
	}
}

// With nobody watching, a terminal session falls back to its own prompt. This one has none, so it
// must still stop and wait, not race through to a denial or an allow.
func TestItWaitsForAClickEvenWithNoPageOpen(t *testing.T) {
	b := newBench(t)
	agent := b.start("fake:bash rm -rf build")
	b.until("the approval", func() bool { return b.read(agent.ID).Approval != nil })
	var viewers bool
	_ = b.engine.Do(func() { viewers = b.engine.HasViewers() })
	if viewers {
		t.Fatal("the test needs an office nobody is watching")
	}
	b.decide(agent.ID, models.DecisionAllowed)
	b.until("the action", func() bool { return b.actions() == 1 })
}

// A hook that can't reach Mabari mustn't turn into the action going ahead.
func TestWithMabariUnreachableNothingRuns(t *testing.T) {
	b := newBench(t)
	b.mu.Lock()
	b.down = true
	b.mu.Unlock()
	agent := b.start("fake:bash rm -rf build")
	b.untilState(agent.ID, models.StateDone)
	if got := b.actions(); got != 0 {
		t.Fatalf("%d actions ran with Mabari unreachable", got)
	}
}

// PermissionRequest only fires when Claude Code would ask. An allow rule means it wouldn't, so the
// PreToolUse gate is what brings a risky action to the person.
func TestAnAllowRuleDoesNotSkipTheClickForARiskyAction(t *testing.T) {
	b := newBench(t)
	agent := b.start("fake:allowed rm -rf build")
	b.until("the approval", func() bool { return b.read(agent.ID).Approval != nil })
	if got := b.actions(); got != 0 {
		t.Fatalf("%d actions ran on an allow rule alone", got)
	}
	b.decide(agent.ID, models.DecisionDenied)
	b.untilState(agent.ID, models.StateDone)
	if got := b.actions(); got != 0 {
		t.Fatalf("%d actions ran after a denial", got)
	}
}

func TestAnAllowRuleStillCoversWhatIsLowRisk(t *testing.T) {
	b := newBench(t)
	agent := b.start("fake:allowed ls")
	b.untilState(agent.ID, models.StateDone)
	if got := b.actions(); got != 1 {
		t.Fatalf("%d actions ran", got)
	}
	if saved := b.read(agent.ID); saved.Approval != nil {
		t.Fatalf("asked about a low risk action: %+v", saved.Approval)
	}
}

// Ask outranks allow, so another hook's allow can't get a risky action past the person.
func TestAnotherHooksAllowCannotSkipTheClick(t *testing.T) {
	b := newBench(t)
	agent := b.start("fake:hook-allowed rm -rf build")
	b.until("the approval", func() bool { return b.read(agent.ID).Approval != nil })
	if got := b.actions(); got != 0 {
		t.Fatalf("%d actions ran on another hook's allow", got)
	}
}

func TestAutoApproveWorksAsItDoesForAnyAgent(t *testing.T) {
	b := newBench(t)
	_ = b.engine.Do(func() { b.engine.SetAutoApprove(true, "all") })
	agent := b.start("fake:bash rm -rf build")
	b.until("the action", func() bool { return b.actions() == 1 })
	b.untilState(agent.ID, models.StateDone)
}

// Low risk auto approve doesn't reach a risky action.
func TestLowRiskAutoApproveStillStopsARiskyAction(t *testing.T) {
	b := newBench(t)
	_ = b.engine.Do(func() { b.engine.SetAutoApprove(true, "safe") })
	agent := b.start("fake:bash rm -rf build")
	b.until("the approval", func() bool { return b.read(agent.ID).Approval != nil })
	if got := b.actions(); got != 0 {
		t.Fatalf("%d actions ran", got)
	}
}

// Attached and running here, a session fires both sets of hooks. The person is asked once.
func TestAnAttachedAccountDoesNotAskTwice(t *testing.T) {
	b := newBench(t)
	settings, err := Hook{Binary: b.c.Hook.Binary, Port: 1}.SessionSettings()
	if err != nil {
		t.Fatal(err)
	}
	// The same hooks in the settings file, without the mark of a session's own.
	settings = strings.ReplaceAll(settings, `"--run",`, "")
	if err := os.WriteFile(filepath.Join(b.config, "settings.json"), []byte(settings), 0o600); err != nil {
		t.Fatal(err)
	}
	agent := b.start("fake:bash rm -rf build")
	b.until("the approval", func() bool { return b.read(agent.ID).Approval != nil })
	first := b.read(agent.ID).Approval.ID
	b.mu.Lock()
	fired := b.settings
	b.mu.Unlock()
	if fired == 0 {
		t.Fatal("the test proves nothing: the settings file's hooks didn't fire")
	}
	time.Sleep(100 * time.Millisecond)
	if again := b.read(agent.ID).Approval; again == nil || again.ID != first {
		t.Fatalf("asked again: %+v", again)
	}
	b.decide(agent.ID, models.DecisionAllowed)
	b.until("the action", func() bool { return b.actions() == 1 })
}

// working waits until the process is really in the middle of a turn.
func (b *bench) working(id string) {
	b.t.Helper()
	b.until("work to start", func() bool { return slices.Contains(b.said(id), "assistant: Working on it.") })
}

func TestInterruptAndContinueWorkOnTheProcess(t *testing.T) {
	b := newBench(t)
	agent := b.start("fake:hang")
	b.working(agent.ID)
	pid := b.read(agent.ID).Session.PID
	_ = b.engine.Do(func() { b.c.Interrupt(b.engine.Agent(agent.ID)) })
	b.untilState(agent.ID, models.StatePaused)
	if said := b.read(agent.ID); said.Error != "" {
		t.Fatalf("an interrupt shows as an error: %q", said.Error)
	}
	_ = b.engine.Do(func() { b.c.Continue(b.engine.Agent(agent.ID)) })
	b.until("the reply", func() bool {
		return slices.Contains(b.said(agent.ID), "assistant: Done: Carry on from where you stopped.")
	})
	if got := b.read(agent.ID).Session.PID; got != pid {
		t.Fatalf("it should carry on in the same process, %d after %d", got, pid)
	}
}

// The docs don't say whether SIGINT leaves the process running, so either way has to work.
func TestAnInterruptThatEndsTheProcessStillContinues(t *testing.T) {
	b := newBench(t)
	t.Setenv("FAKE_CLAUDE_SIGINT_EXITS", "1")
	agent := b.start("fake:hang")
	b.working(agent.ID)
	_ = b.engine.Do(func() { b.c.Interrupt(b.engine.Agent(agent.ID)) })
	b.until("the process to end", func() bool {
		session := b.read(agent.ID).Session
		return session != nil && session.Status == models.SessionResumable
	})
	if saved := b.read(agent.ID); saved.State != models.StatePaused || saved.Error != "" {
		t.Fatalf("state %s, error %q", saved.State, saved.Error)
	}
	_ = b.engine.Do(func() { b.c.Continue(b.engine.Agent(agent.ID)) })
	b.until("the reply", func() bool {
		return slices.Contains(b.said(agent.ID), "assistant: Done: Carry on from where you stopped.")
	})
	if runs := b.argsOf(agent.Session.ID); len(runs) != 2 || !hasArg(runs[1], "--resume", agent.Session.ID) {
		t.Fatalf("runs = %q", runs)
	}
}

// An interrupted turn's result reads as an error. Arriving after Continue, it must not show as one.
func TestAnInterruptedTurnsResultIsNotAnError(t *testing.T) {
	b := newBench(t)
	agent := b.start("fake:hang")
	b.working(agent.ID)
	// Both in one step, so Continue always gets in before the result.
	_ = b.engine.Do(func() {
		running := b.engine.Agent(agent.ID)
		b.c.Interrupt(running)
		b.c.Continue(running)
	})
	b.until("the reply", func() bool {
		return slices.Contains(b.said(agent.ID), "assistant: Done: Carry on from where you stopped.")
	})
	b.untilState(agent.ID, models.StateDone)
	if said := b.said(agent.ID); slices.ContainsFunc(said, func(line string) bool { return strings.HasPrefix(line, "notice: Claude") }) {
		t.Fatalf("shown as a failure: %q", said)
	}
}

// A process that dies before Claude Code saved anything leaves nothing to resume. --resume would
// fail every time, so the session starts afresh under its id.
func TestASessionThatNeverStartedDoesNotResume(t *testing.T) {
	b := newBench(t)
	t.Setenv("FAKE_CLAUDE_DIE_AT_START", "1")
	agent := b.start("hello")
	b.untilState(agent.ID, models.StateError)
	if saved := b.read(agent.ID); saved.Session.Started {
		t.Fatalf("session = %+v", saved.Session)
	}
	t.Setenv("FAKE_CLAUDE_DIE_AT_START", "")
	_ = b.engine.Do(func() { b.c.Retry(b.engine.Agent(agent.ID)) })
	b.until("the reply", func() bool { return slices.Contains(b.said(agent.ID), "assistant: Done: hello") })
	runs := b.argsOf(agent.Session.ID)
	if len(runs) != 2 || !hasArg(runs[1], "--session-id", agent.Session.ID) {
		t.Fatalf("runs = %q", runs)
	}
}

// Package 3 relies on this: pausing never settles an approval.
func TestInterruptNeverSettlesAnApproval(t *testing.T) {
	b := newBench(t)
	agent := b.start("fake:bash rm -rf build")
	b.until("the approval", func() bool { return b.read(agent.ID).Approval != nil })
	_ = b.engine.Do(func() { b.c.Interrupt(b.engine.Agent(agent.ID)) })
	time.Sleep(50 * time.Millisecond)
	saved := b.read(agent.ID)
	if saved.Approval == nil || saved.State != models.StateApproval {
		t.Fatalf("state %s, approval %+v", saved.State, saved.Approval)
	}
	if got := b.actions(); got != 0 {
		t.Fatalf("%d actions ran", got)
	}
}

// A session Mabari runs fires settings.json's hooks as well as its own. That copy says nothing,
// or the person would be asked twice.
func TestSettingsHooksOfALiveRunAreIgnored(t *testing.T) {
	b := newBench(t)
	agent := b.start("fake:hang")
	b.working(agent.ID)
	body, _ := json.Marshal(map[string]any{
		"session_id": agent.Session.ID, "cwd": b.folder, "hook_event_name": "PreToolUse",
		"tool_name": "Bash", "tool_input": map[string]any{"command": "rm -rf build"},
	})
	if reply := b.c.Handle(context.Background(), body); reply != nil {
		t.Fatalf("reply = %s", reply)
	}
	if saved := b.read(agent.ID); saved.Approval != nil {
		t.Fatalf("asked: %+v", saved.Approval)
	}
}

// A folder can bring more after the click, from a pull or a branch. A running process already has
// what it has, but no new one starts until the person has seen the rest.
func TestAFolderThatGainedConfigStartsNoProcess(t *testing.T) {
	b := newBench(t)
	agent := b.start("hello")
	b.untilState(agent.ID, models.StateDone)
	_ = b.engine.Do(func() {
		if err := b.c.ReleaseSession(b.engine.Agent(agent.ID)); err != nil {
			t.Error(err)
		}
	})
	b.until("the process to end", func() bool { return b.read(agent.ID).Session.PID == 0 })
	gained := filepath.Join(b.folder, ".mcp.json")
	if err := os.WriteFile(gained, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var err error
	_ = b.engine.Do(func() { err = b.c.deliverNow(b.engine.Agent(agent.ID), "fake:bash rm -rf build") })
	var changed FolderChanged
	if !errors.As(err, &changed) || !strings.Contains(err.Error(), gained) || changed.Folder != b.folder {
		t.Fatalf("deliverNow = %v", err)
	}
	if runs := b.argsOf(agent.Session.ID); len(runs) != 1 {
		t.Fatalf("runs = %q", runs)
	}
	// Once the person has agreed to it, the session carries on.
	_ = b.engine.Do(func() {
		b.engine.SetMeta(store.MetaTrusted, `{"`+b.folder+`":["`+gained+`"]}`)
		err = b.c.deliverNow(b.engine.Agent(agent.ID), "hello again")
	})
	if err != nil {
		t.Fatal(err)
	}
	b.until("a new process", func() bool { return len(b.argsOf(agent.Session.ID)) == 2 })
}

// A message for a session that can't start waits, and the person is told why.
func TestAMessageToAFolderThatGainedConfigWaits(t *testing.T) {
	b := newBench(t)
	agent := b.start("hello")
	b.untilState(agent.ID, models.StateDone)
	_ = b.engine.Do(func() { _ = b.c.ReleaseSession(b.engine.Agent(agent.ID)) })
	b.until("the process to end", func() bool { return b.read(agent.ID).Session.PID == 0 })
	if err := os.MkdirAll(filepath.Join(b.folder, ".claude", "hooks"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(b.folder, ".claude", "hooks", "run.sh"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	_ = b.engine.Do(func() { b.c.Instruct(b.engine.Agent(agent.ID), "fake:bash rm -rf build") })
	if saved := b.read(agent.ID); len(saved.Queued) != 1 {
		t.Fatalf("queued = %+v", saved.Queued)
	}
	if runs := b.argsOf(agent.Session.ID); len(runs) != 1 {
		t.Fatalf("runs = %q", runs)
	}
	if got := b.actions(); got != 0 {
		t.Fatalf("%d actions ran", got)
	}
}

// A session saved by an earlier version can have any id. One that reads as a flag never reaches
// --resume, and Mabari says why.
func TestASavedSessionIdThatIsAFlagStartsNoProcess(t *testing.T) {
	b := newBench(t)
	agent := b.start("hello")
	b.untilState(agent.ID, models.StateDone)
	_ = b.engine.Do(func() { _ = b.c.ReleaseSession(b.engine.Agent(agent.ID)) })
	b.until("the process to end", func() bool { return b.read(agent.ID).Session.PID == 0 })
	const hostile = "--dangerously-skip-permissions"
	real := agent.Session.ID
	var delivered, resumed error
	_ = b.engine.Do(func() {
		saved := b.engine.Agent(agent.ID)
		session := *saved.Session
		session.ID, session.Started = hostile, true
		saved.Session = &session
		delivered = b.c.deliverNow(saved, "hello")
		session.Status = models.SessionElsewhere
		saved.Session = &session
		resumed = b.c.ResumeSession(saved)
	})
	if !errors.Is(delivered, ErrBadSession) || !errors.Is(resumed, ErrBadSession) {
		t.Fatalf("delivered = %v, resumed = %v", delivered, resumed)
	}
	if runs := b.argsOf(real); len(runs) != 1 {
		t.Fatalf("runs = %q", runs)
	}
}

func TestStopEndsTheProcess(t *testing.T) {
	b := newBench(t)
	agent := b.start("fake:hang")
	b.working(agent.ID)
	pid := b.read(agent.ID).Session.PID
	_ = b.engine.Do(func() { b.c.StopAgent(b.engine.Agent(agent.ID)) })
	b.until("the process to end", func() bool { return processGone(pid) })
	if saved := b.read(agent.ID); saved.ID != "" {
		t.Fatalf("still in the office: %+v", saved.Agent)
	}
	if said := b.said(agent.ID); len(said) == 0 {
		t.Fatal("the conversation went with it")
	}
}

// Stopping while an approval waits answers no, rather than leaving the process holding on.
func TestStopDeniesAWaitingApproval(t *testing.T) {
	b := newBench(t)
	agent := b.start("fake:bash rm -rf build")
	b.until("the approval", func() bool { return b.read(agent.ID).Approval != nil })
	pid := b.read(agent.ID).Session.PID
	_ = b.engine.Do(func() { b.c.StopAgent(b.engine.Agent(agent.ID)) })
	b.until("the process to end", func() bool { return processGone(pid) })
	if got := b.actions(); got != 0 {
		t.Fatalf("%d actions ran", got)
	}
}

func TestShutdownLeavesNoProcessAndSessionsResume(t *testing.T) {
	b := newBench(t)
	agent := b.start("fake:hang")
	b.working(agent.ID)
	pid := b.read(agent.ID).Session.PID
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	b.c.Shutdown(ctx)
	if !processGone(pid) {
		t.Fatalf("process %d outlived Mabari", pid)
	}
	saved := b.read(agent.ID)
	if saved.Session.Status != models.SessionResumable || saved.Session.PID != 0 || saved.State.Active() {
		t.Fatalf("state %s, session %+v", saved.State, saved.Session)
	}
	if saved.Error != "" {
		t.Fatalf("a clean shutdown shows as an error: %q", saved.Error)
	}
}

// What a server restart sees: the stored agent, with no process, and a new connector.
func TestARestartShowsSessionsAsResumableAndTheyCarryOn(t *testing.T) {
	b := newBench(t)
	agent := b.start("first")
	b.untilState(agent.ID, models.StateDone)
	session := b.read(agent.ID).Session.ID
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	b.c.Shutdown(ctx)
	restarted := New(b.engine)
	restarted.Program, restarted.Hook, restarted.endWait = b.c.Program, b.c.Hook, b.c.endWait
	b.engine.AddConnector(Source, restarted)
	b.c = restarted
	_ = b.engine.Do(restarted.Resume)
	if saved := b.read(agent.ID); saved.Session.Status != models.SessionResumable {
		t.Fatalf("after a restart: %+v", saved.Session)
	}
	if runs := b.argsOf(session); len(runs) != 1 {
		t.Fatalf("a restart started something by itself: %q", runs)
	}
	b.instruct(agent.ID, "second")
	b.until("the reply", func() bool {
		return slices.Contains(b.said(agent.ID), "assistant: Done: second")
	})
	runs := b.argsOf(session)
	if len(runs) != 2 || !hasArg(runs[1], "--resume", session) || !hasArg(runs[1], "--permission-mode", "default") {
		t.Fatalf("runs = %q", runs)
	}
	if said := b.said(agent.ID); !slices.Contains(said, "user: first") {
		t.Fatalf("the conversation didn't survive: %q", said)
	}
}

// A process gone with its approval unanswered leaves no card that does nothing.
func TestARestartSettlesAnApprovalNobodyCanAnswer(t *testing.T) {
	b := newBench(t)
	agent := b.start("fake:bash rm -rf build")
	b.until("the approval", func() bool { return b.read(agent.ID).Approval != nil })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	b.c.Shutdown(ctx)
	_ = b.engine.Do(b.c.Resume)
	saved := b.read(agent.ID)
	if saved.Approval != nil || saved.State == models.StateApproval {
		t.Fatalf("state %s, approval %+v", saved.State, saved.Approval)
	}
	if got := b.actions(); got != 0 {
		t.Fatalf("%d actions ran", got)
	}
}

func TestTheCapStopsANewSessionAndSaysSo(t *testing.T) {
	b := newBench(t)
	_ = b.engine.Do(func() {
		settings := b.engine.Settings()
		settings.MaxSessions = 1
		b.engine.SaveSettings(settings)
	})
	busy := b.start("fake:hang")
	b.until("work to start", func() bool { return b.read(busy.ID).State.Active() })
	var err error
	_ = b.engine.Do(func() { _, err = b.c.StartSession(SessionSpec{Name: "Pepper", Folder: b.folder, Task: "hi"}) })
	var capped CapError
	if !errors.As(err, &capped) || capped.Limit != 1 || !strings.Contains(err.Error(), "Settings") {
		t.Fatalf("err = %v", err)
	}
	var count int
	_ = b.engine.Do(func() { count = len(b.engine.Agents()) })
	if count != 1 {
		t.Fatalf("%d agents after a refused start", count)
	}
}

// Sitting idle shouldn't take a place from work that is waiting. It resumes with nothing lost.
func TestAnIdleSessionGivesUpItsPlace(t *testing.T) {
	b := newBench(t)
	_ = b.engine.Do(func() {
		settings := b.engine.Settings()
		settings.MaxSessions = 1
		b.engine.SaveSettings(settings)
	})
	idle := b.start("first")
	b.untilState(idle.ID, models.StateDone)
	pid := b.read(idle.ID).Session.PID
	other := b.start("second", func(spec *SessionSpec) { spec.Name = "Pepper" })
	b.until("the idle process to end", func() bool { return processGone(pid) })
	if saved := b.read(idle.ID); saved.Session.Status != models.SessionResumable {
		t.Fatalf("session = %+v", saved.Session)
	}
	b.untilState(other.ID, models.StateDone)
	b.instruct(idle.ID, "third")
	b.until("the reply", func() bool {
		return slices.Contains(b.said(idle.ID), "assistant: Done: third")
	})
}

func TestACrashShowsAnErrorWithSecretsMaskedAndCanResume(t *testing.T) {
	b := newBench(t)
	agent := b.start("hello")
	b.untilState(agent.ID, models.StateDone)
	b.instruct(agent.ID, "fake:crash")
	b.untilState(agent.ID, models.StateError)
	saved := b.read(agent.ID)
	if strings.Contains(saved.Error, "abcd1234secret") {
		t.Fatalf("the error shows a secret: %q", saved.Error)
	}
	if !strings.Contains(saved.Error, "stopped unexpectedly") || saved.Session.Status != models.SessionResumable {
		t.Fatalf("error %q, session %+v", saved.Error, saved.Session)
	}
	_ = b.engine.Do(func() { b.c.Retry(b.engine.Agent(agent.ID)) })
	b.until("a new process", func() bool {
		session := b.read(agent.ID).Session
		return session != nil && session.Status == models.SessionRunning
	})
}

func TestAnErrorResultShowsOnTheAgent(t *testing.T) {
	b := newBench(t)
	agent := b.start("fake:error Invalid API key. Please run /login")
	b.untilState(agent.ID, models.StateError)
	if saved := b.read(agent.ID); !strings.Contains(saved.Error, "Please run /login") {
		t.Fatalf("error = %q", saved.Error)
	}
}

func TestOutputIsSizeBounded(t *testing.T) {
	b := newBench(t)
	agent := b.start("fake:big 300000")
	b.untilState(agent.ID, models.StateDone)
	b.until("the message", func() bool {
		items := b.conversation(agent.ID)
		last := items[len(items)-1]
		return last.Kind == models.ConversationAssistant && !last.Streaming
	})
	items := b.conversation(agent.ID)
	last := items[len(items)-1]
	if !last.Clipped || len(last.Text) != models.ConversationTextLimit {
		t.Fatalf("clipped %v, length %d", last.Clipped, len(last.Text))
	}
}

// A secret split across two deltas must never reach a page, whole or in part.
func TestASecretAcrossDeltasNeverReachesAPage(t *testing.T) {
	b := newBench(t)
	joined := b.engine.Subscribe(events.Resume{})
	defer b.engine.Unsubscribe(joined.Sub)
	var sent strings.Builder
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		for message := range joined.Sub.C {
			data, _ := json.Marshal(message)
			sent.Write(data)
		}
	}()
	agent := b.start("fake:secret")
	b.untilState(agent.ID, models.StateDone)
	b.until("the message", func() bool {
		return slices.Contains(b.said(agent.ID), "assistant: the key is [redacted] ok")
	})
	b.engine.Unsubscribe(joined.Sub)
	<-finished
	for _, part := range []string{"sk-ant", "abcdefghij", "efghijklmnop1234"} {
		if strings.Contains(sent.String(), part) {
			t.Fatalf("%q reached a page", part)
		}
	}
}

func TestPartialTextStreamsBeforeTheMessageIsFinished(t *testing.T) {
	b := newBench(t)
	joined := b.engine.Subscribe(events.Resume{})
	defer b.engine.Unsubscribe(joined.Sub)
	agent := b.start("fake:slow 8")
	deltas := 0
	deadline := time.After(10 * time.Second)
	for deltas < 2 {
		select {
		case message := <-joined.Sub.C:
			if message.Type == models.MsgConversationDelta && message.AgentID == agent.ID {
				deltas++
			}
		case <-deadline:
			t.Fatalf("%d deltas", deltas)
		}
	}
	b.untilState(agent.ID, models.StateDone)
}

// If managed settings or anything else starts a session where approvals may not stop, it is ended
// before it does anything.
func TestASessionInAnotherPermissionModeIsEnded(t *testing.T) {
	b := newBench(t)
	t.Setenv("FAKE_CLAUDE_REPORT_MODE", "bypassPermissions")
	agent := b.start("fake:bash rm -rf build")
	b.untilState(agent.ID, models.StateError)
	saved := b.read(agent.ID)
	if !strings.Contains(saved.Error, "bypassPermissions") {
		t.Fatalf("error = %q", saved.Error)
	}
	b.until("the process to end", func() bool { return processGone(agent.Session.PID) })
}

func TestAPlanSessionAsksThenStartsAgainOutOfPlanMode(t *testing.T) {
	b := newBench(t)
	agent := b.start("write a plan", func(spec *SessionSpec) { spec.Plan = true })
	b.until("the plan", func() bool { return b.read(agent.ID).Approval != nil })
	saved := b.read(agent.ID)
	if saved.Approval.Type != models.ApprovalPlan || !hasArg(b.argsOf(agent.Session.ID)[0], "--permission-mode", "plan") {
		t.Fatalf("approval %+v, args %q", saved.Approval, b.argsOf(agent.Session.ID))
	}
	b.decide(agent.ID, models.DecisionAllowed)
	b.until("the go-ahead", func() bool {
		return slices.Contains(b.said(agent.ID), "assistant: Done: "+planApproved)
	})
	runs := b.argsOf(agent.Session.ID)
	if len(runs) != 2 || !hasArg(runs[1], "--permission-mode", "default") || !hasArg(runs[1], "--resume", agent.Session.ID) {
		t.Fatalf("runs = %q", runs)
	}
}

func TestDenyingAPlanStaysInPlanMode(t *testing.T) {
	b := newBench(t)
	agent := b.start("write a plan", func(spec *SessionSpec) { spec.Plan = true })
	b.decide(agent.ID, models.DecisionDenied)
	b.untilState(agent.ID, models.StateDone)
	if saved := b.read(agent.ID); saved.Session.Mode != runModePlan || len(b.argsOf(agent.Session.ID)) != 1 {
		t.Fatalf("mode %q, runs %q", saved.Session.Mode, b.argsOf(agent.Session.ID))
	}
}

func TestUntickedToolsAreDeniedToTheSession(t *testing.T) {
	if got := deniedTools([]string{"read", "edit"}); !slices.Contains(got, "Bash") || slices.Contains(got, "Write") {
		t.Fatalf("denied = %q", got)
	}
	if got := deniedTools(nil); got != nil {
		t.Fatalf("nothing was asked, but denied %q", got)
	}
	args := runArgs(runLine{Session: "s", Settings: "{}", Denied: deniedTools([]string{"read"}), Budget: 5})
	if !hasArg(args, "--max-budget-usd", "5.00") || !slices.Contains(args, "--disallowedTools") {
		t.Fatalf("args = %q", args)
	}
}

// A wipe deletes conversations. A process that hasn't noticed yet mustn't write them back.
func TestAWipeEndsSessionsAndNothingIsWrittenAfterIt(t *testing.T) {
	b := newBench(t)
	agent := b.start("fake:slow 40")
	b.until("work to start", func() bool { return len(b.said(agent.ID)) > 1 })
	pid := b.read(agent.ID).Session.PID
	_ = b.engine.Do(b.engine.Wipe)
	b.until("the process to end", func() bool { return processGone(pid) })
	time.Sleep(100 * time.Millisecond)
	if said := b.said(agent.ID); len(said) != 0 {
		t.Fatalf("written after the wipe: %q", said)
	}
}

// Loading the demo clears the office. Sessions leaving with it mustn't work on unseen.
func TestClearingTheOfficeEndsSessionsThatLeaveAndKeepsThoseThatStay(t *testing.T) {
	b := newBench(t)
	going := b.start("fake:hang")
	staying := b.start("fake:hang", func(spec *SessionSpec) { spec.Name = "Pepper" })
	b.until("work to start", func() bool {
		return b.read(going.ID).State.Active() && b.read(staying.ID).State.Active()
	})
	goingPID, stayingPID := b.read(going.ID).Session.PID, b.read(staying.ID).Session.PID
	_ = b.engine.Do(func() { b.c.OfficeCleared([]string{staying.ID}) })
	b.until("the process to end", func() bool { return processGone(goingPID) })
	if processGone(stayingPID) {
		t.Fatal("ended a session that stays")
	}
}

func TestReleasingASessionKeepsItResumable(t *testing.T) {
	b := newBench(t)
	agent := b.start("first")
	b.untilState(agent.ID, models.StateDone)
	pid := b.read(agent.ID).Session.PID
	var err error
	_ = b.engine.Do(func() { err = b.c.ReleaseSession(b.engine.Agent(agent.ID)) })
	if err != nil {
		t.Fatal(err)
	}
	b.until("the process to end", func() bool { return processGone(pid) })
	if saved := b.read(agent.ID); saved.Session.Status != models.SessionResumable {
		t.Fatalf("session = %+v", saved.Session)
	}
}

// Opened in a terminal afterwards, it reports through settings hooks, and Mabari only follows.
func TestASessionCarriedOnInATerminalIsFollowed(t *testing.T) {
	b := newBench(t)
	agent := b.start("first")
	b.untilState(agent.ID, models.StateDone)
	pid := b.read(agent.ID).Session.PID
	_ = b.engine.Do(func() { _ = b.c.ReleaseSession(b.engine.Agent(agent.ID)) })
	b.until("the process to end", func() bool { return processGone(pid) })
	body, _ := json.Marshal(map[string]any{
		"session_id": agent.Session.ID, "cwd": b.folder, "hook_event_name": "PreToolUse", "tool_name": "Read",
	})
	b.c.Handle(context.Background(), body)
	saved := b.read(agent.ID)
	if saved.Session.Status != models.SessionElsewhere || saved.RunsHere() {
		t.Fatalf("session = %+v", saved.Session)
	}
	b.instruct(agent.ID, "while you're there")
	if saved := b.read(agent.ID); len(saved.Queued) != 1 {
		t.Fatalf("a session open elsewhere was driven: %+v", saved.Queued)
	}
}

func TestTakingOverASessionStartedElsewhere(t *testing.T) {
	b := newBench(t)
	session := newSessionID()
	transcript := filepath.Join(b.config, "projects", "shop", session+".jsonl")
	if err := os.MkdirAll(filepath.Dir(transcript), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(transcript, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// The fake finds a session by the folder it runs in, as Claude Code searches.
	fakeFile := filepath.Join(b.config, "projects", strings.ReplaceAll(strings.ReplaceAll(b.folder, "/", "-"), ".", "-"), session+".jsonl")
	if err := os.MkdirAll(filepath.Dir(fakeFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fakeFile, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{
		"session_id": session, "cwd": b.folder, "hook_event_name": "Stop", "last_assistant_message": "Done.",
	})
	b.c.Handle(context.Background(), body)
	id := agentID(session)
	if saved := b.read(id); saved.Session == nil || saved.Session.Status != models.SessionElsewhere {
		t.Fatalf("session = %+v", saved.Session)
	}
	b.instruct(id, "carry on please")
	if saved := b.read(id); len(saved.Queued) != 1 {
		t.Fatalf("queued = %+v", saved.Queued)
	}
	var err error
	_ = b.engine.Do(func() { err = b.c.ResumeSession(b.engine.Agent(id)) })
	if err != nil {
		t.Fatal(err)
	}
	b.until("the reply", func() bool {
		return slices.Contains(b.said(id), "assistant: Done: carry on please")
	})
	if runs := b.argsOf(session); !hasArg(runs[0], "--resume", session) {
		t.Fatalf("runs = %q", runs)
	}
}

func TestItWontTakeOverASessionThatIsWorking(t *testing.T) {
	b := newBench(t)
	body, _ := json.Marshal(map[string]any{
		"session_id": testSession(88), "cwd": b.folder, "hook_event_name": "PreToolUse", "tool_name": "Read",
	})
	b.c.Handle(context.Background(), body)
	var err error
	_ = b.engine.Do(func() { err = b.c.ResumeSession(b.engine.Agent(agentID(testSession(88)))) })
	if err == nil || !strings.Contains(err.Error(), "working") {
		t.Fatalf("err = %v", err)
	}
}

func TestContinueCommandInATerminal(t *testing.T) {
	b := newBench(t)
	agent := b.start("hello")
	b.untilState(agent.ID, models.StateDone)
	if resume := b.read(agent.ID).Session.Resume; !strings.HasSuffix(resume, "&& claude --resume "+agent.Session.ID) ||
		!strings.Contains(resume, filepath.Base(b.folder)) {
		t.Fatalf("resume = %q", resume)
	}
}
