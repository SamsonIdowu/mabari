// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

func newConnector(t *testing.T) (*Connector, *events.Engine) {
	t.Helper()
	s, err := store.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	engine, err := events.New(context.Background(), s, nil)
	if err != nil {
		t.Fatal(err)
	}
	c := New(engine)
	engine.AddConnector(Source, c)
	return c, engine
}

// hook sends one event the way Claude Code would, and returns the reply.
func hook(t *testing.T, c *Connector, event string, fields map[string]any) []byte {
	t.Helper()
	body := map[string]any{
		"session_id": "abc-123", "cwd": "/home/me/shop", "hook_event_name": event,
		"permission_mode": "default", "transcript_path": "/tmp/t.jsonl",
	}
	for key, value := range fields {
		body[key] = value
	}
	data, _ := json.Marshal(body)
	return c.Handle(context.Background(), data)
}

func agentOf(t *testing.T, engine *events.Engine) *models.LiveAgent {
	t.Helper()
	var agent *models.LiveAgent
	_ = engine.Do(func() { agent = engine.Agent("cc-abc-123") })
	return agent
}

func TestASessionTakesADesk(t *testing.T) {
	c, engine := newConnector(t)
	if reply := hook(t, c, "SessionStart", map[string]any{"source": "startup", "model": "claude-sonnet-4-5[1m]"}); reply != nil {
		t.Errorf("reply = %s", reply)
	}
	agent := agentOf(t, engine)
	if agent == nil {
		t.Fatal("no agent")
	}
	if agent.Provider != models.ProviderClaude || agent.Model != "claude-sonnet-4-5" ||
		agent.Folder != "/home/me/shop" || agent.Desk != 0 || agent.Name != "Juniper" ||
		agent.Project == nil || *agent.Project != "general" {
		t.Errorf("agent = %+v", agent.Agent)
	}
	for _, account := range engine.Accounts() {
		if account.Kind == models.AccountClaudeCode && account.Status != models.AccountConnected {
			t.Errorf("account = %s", account.Status)
		}
	}
}

func TestToolsChangeTheStateAndSecretsAreMasked(t *testing.T) {
	c, engine := newConnector(t)
	hook(t, c, "UserPromptSubmit", map[string]any{"prompt": "Fix the flaky test\nand more"})
	if agent := agentOf(t, engine); agent.State != models.StateThinking || agent.Task != "Fix the flaky test" {
		t.Errorf("after prompt: %s %q", agent.State, agent.Task)
	}
	cases := map[string]models.AgentState{
		"Bash": models.StateRunning, "Edit": models.StateEditing, "Read": models.StateReading,
		"WebFetch": models.StateBrowsing, "Task": models.StateSpawning, "Mystery": models.StateThinking,
	}
	for tool, want := range cases {
		hook(t, c, "PreToolUse", map[string]any{"tool_name": tool, "tool_input": map[string]any{}})
		if got := agentOf(t, engine).State; got != want {
			t.Errorf("%s = %s, want %s", tool, got, want)
		}
	}
	hook(t, c, "PreToolUse", map[string]any{"tool_name": "Bash",
		"tool_input": map[string]any{"command": "curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123' x"}})
	feed := agentOf(t, engine).Feed
	if len(feed) == 0 || strings.Contains(feed[0].Summary, "abcdefghijklmnop") {
		t.Errorf("feed = %+v", feed[:1])
	}
}

func TestQueuedInstructionsArriveAtTheNextCheckpoint(t *testing.T) {
	c, engine := newConnector(t)
	hook(t, c, "UserPromptSubmit", map[string]any{"prompt": "Build the page"})
	_ = engine.Do(func() { c.Instruct(engine.Agent("cc-abc-123"), "Also add a changelog entry") })
	if len(agentOf(t, engine).Queued) != 1 {
		t.Fatal("not queued")
	}
	if reply := hook(t, c, "PreToolUse", map[string]any{"tool_name": "Read"}); reply != nil {
		t.Errorf("a tool call delivered it early: %s", reply)
	}
	reply := hook(t, c, "PostToolUse", map[string]any{"tool_name": "Read"})
	var out struct {
		Specific struct {
			Event   string `json:"hookEventName"`
			Context string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal(reply, &out); err != nil {
		t.Fatalf("reply = %s", reply)
	}
	if out.Specific.Event != "PostToolUse" || !strings.Contains(out.Specific.Context, "Also add a changelog entry") {
		t.Errorf("reply = %s", reply)
	}
	if len(agentOf(t, engine).Queued) != 0 {
		t.Error("still queued")
	}
	if reply := hook(t, c, "PostToolUse", map[string]any{"tool_name": "Read"}); reply != nil {
		t.Errorf("delivered twice: %s", reply)
	}
}

func TestStopKeepsGoingOnlyWhenSomethingWaits(t *testing.T) {
	c, engine := newConnector(t)
	hook(t, c, "UserPromptSubmit", map[string]any{"prompt": "Build the page"})
	_ = engine.Do(func() { c.Instruct(engine.Agent("cc-abc-123"), "Then run the tests") })
	var block struct {
		Decision string `json:"decision"`
		Reason   string `json:"reason"`
	}
	if err := json.Unmarshal(hook(t, c, "Stop", nil), &block); err != nil || block.Decision != "block" ||
		!strings.Contains(block.Reason, "Then run the tests") {
		t.Errorf("stop with a waiting instruction = %+v", block)
	}
	if reply := hook(t, c, "Stop", map[string]any{"stop_hook_active": true, "last_assistant_message": "All done."}); reply != nil {
		t.Errorf("stop with nothing waiting = %s", reply)
	}
	if agent := agentOf(t, engine); agent.State != models.StateDone || agent.Reply != "All done." {
		t.Errorf("after stop: %s %q", agent.State, agent.Reply)
	}
}

func TestNobodyWatchingLeavesClaudeCodesOwnPrompt(t *testing.T) {
	c, engine := newConnector(t)
	reply := hook(t, c, "PermissionRequest", map[string]any{"tool_name": "Bash",
		"tool_input": map[string]any{"command": "rm -rf build"}})
	if reply != nil {
		t.Errorf("reply = %s", reply)
	}
	if agent := agentOf(t, engine); agent.Approval != nil {
		t.Error("an approval waits that nobody can see")
	}
}

// permissionWith runs a permission hook while a page is open, and decides it as the user would.
func permissionWith(t *testing.T, decision string) []byte {
	t.Helper()
	c, engine := newConnector(t)
	joined := engine.Subscribe(events.Resume{})
	defer engine.Unsubscribe(joined.Sub)
	done := make(chan []byte)
	go func() {
		done <- hook(t, c, "PermissionRequest", map[string]any{"tool_name": "Bash",
			"tool_input": map[string]any{"command": "npm publish"}})
	}()
	var id string
	for range 200 {
		if agent := agentOf(t, engine); agent != nil && agent.Approval != nil {
			id = agent.Approval.ID
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if id == "" {
		t.Fatal("no approval appeared")
	}
	if agent := agentOf(t, engine); agent.Approval.RiskLevel != models.RiskHigh || agent.State != models.StateApproval {
		t.Errorf("approval = %+v", agent.Approval)
	}
	_ = engine.Do(func() { engine.Decide(id, decision) })
	return <-done
}

func decisionOf(t *testing.T, reply []byte) map[string]any {
	t.Helper()
	var out struct {
		Specific struct {
			Event    string         `json:"hookEventName"`
			Decision map[string]any `json:"decision"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal(reply, &out); err != nil || out.Specific.Event != "PermissionRequest" {
		t.Fatalf("reply = %s", reply)
	}
	return out.Specific.Decision
}

func TestAClickInMabariAnswersTheHook(t *testing.T) {
	if got := decisionOf(t, permissionWith(t, models.DecisionAllowed)); got["behavior"] != "allow" {
		t.Errorf("allow = %v", got)
	}
	denied := decisionOf(t, permissionWith(t, models.DecisionDenied))
	if denied["behavior"] != "deny" || denied["interrupt"] != false || denied["message"] == "" {
		t.Errorf("deny = %v", denied)
	}
}

func TestNoClickInTimeFallsBackAndCancels(t *testing.T) {
	c, engine := newConnector(t)
	c.SetWait(30 * time.Millisecond)
	joined := engine.Subscribe(events.Resume{})
	defer engine.Unsubscribe(joined.Sub)
	reply := hook(t, c, "PermissionRequest", map[string]any{"tool_name": "Bash",
		"tool_input": map[string]any{"command": "npm publish"}})
	if reply != nil {
		t.Errorf("reply = %s", reply)
	}
	pending, _ := engine.Store().Approvals(context.Background(), true)
	if len(pending) != 0 || agentOf(t, engine).Approval != nil {
		t.Errorf("pending = %+v", pending)
	}
}

func TestAutoApproveForEverythingAnswersAtOnce(t *testing.T) {
	c, engine := newConnector(t)
	_ = engine.Do(func() { engine.SetAutoApprove(true, "all") })
	reply := hook(t, c, "PermissionRequest", map[string]any{"tool_name": "Bash",
		"tool_input": map[string]any{"command": "npm publish"}})
	if got := decisionOf(t, reply); got["behavior"] != "allow" {
		t.Errorf("auto = %v", got)
	}
}

// Low risk auto approve still leaves a risky command to a person.
func TestLowRiskAutoApproveStillAsksForRiskyCommands(t *testing.T) {
	c, engine := newConnector(t)
	_ = engine.Do(func() { engine.SetAutoApprove(true, "safe") })
	if reply := hook(t, c, "PermissionRequest", map[string]any{"tool_name": "Bash",
		"tool_input": map[string]any{"command": "git push --force"}}); reply != nil {
		t.Errorf("a risky command was answered with nobody watching: %s", reply)
	}
}

func TestInterruptPausesAtTheNextTool(t *testing.T) {
	c, engine := newConnector(t)
	hook(t, c, "UserPromptSubmit", map[string]any{"prompt": "Build"})
	_ = engine.Do(func() { c.Interrupt(engine.Agent("cc-abc-123")) })
	var out struct {
		Continue *bool  `json:"continue"`
		Reason   string `json:"stopReason"`
	}
	if err := json.Unmarshal(hook(t, c, "PreToolUse", map[string]any{"tool_name": "Bash"}), &out); err != nil ||
		out.Continue == nil || *out.Continue {
		t.Errorf("interrupt = %+v", out)
	}
	if agentOf(t, engine).State != models.StatePaused {
		t.Error("not paused")
	}
	if reply := hook(t, c, "PreToolUse", map[string]any{"tool_name": "Bash"}); reply != nil {
		t.Errorf("paused twice: %s", reply)
	}
}

func TestSessionEndLeavesAndStopIgnoresTheSession(t *testing.T) {
	c, engine := newConnector(t)
	hook(t, c, "SessionStart", nil)
	hook(t, c, "SessionEnd", map[string]any{"reason": "prompt_input_exit"})
	if agentOf(t, engine) != nil {
		t.Error("still in the office")
	}
	hook(t, c, "SessionStart", nil)
	_ = engine.Do(func() { c.StopAgent(engine.Agent("cc-abc-123")) })
	hook(t, c, "PreToolUse", map[string]any{"tool_name": "Bash"})
	if agentOf(t, engine) != nil {
		t.Error("a stopped session came back")
	}
}

func TestHooksGoStaleAndRecover(t *testing.T) {
	c, engine := newConnector(t)
	hook(t, c, "UserPromptSubmit", map[string]any{"prompt": "Build"})
	status := func() models.AccountStatus {
		for _, account := range engine.Accounts() {
			if account.Kind == models.AccountClaudeCode {
				return account.Status
			}
		}
		return ""
	}
	_ = engine.Do(func() { c.CheckStale(time.Now().Add(StaleAfter + time.Minute)) })
	if status() != models.AccountStale {
		t.Errorf("status = %s", status())
	}
	_ = engine.Do(func() { c.CheckStale(time.Now()) })
	if status() != models.AccountConnected {
		t.Errorf("status = %s", status())
	}
}

func TestHookPrintsNothingWhenMabariIsDown(t *testing.T) {
	token := func() (string, error) { return "secret", nil }
	var out bytes.Buffer
	RunHook("PreToolUse", 1, strings.NewReader(`{"session_id":"x"}`), &out, token)
	if out.Len() != 0 {
		t.Errorf("printed %q", out.String())
	}
	RunHook("PreToolUse", 1, strings.NewReader(`{}`), &out, func() (string, error) {
		return "", errors.New("no keychain")
	})
	if out.Len() != 0 {
		t.Errorf("printed %q", out.String())
	}
}

func TestHookPassesTheReplyThrough(t *testing.T) {
	var gotAuth, gotPath string
	reply := []byte(`{"decision":"block","reason":"x"}`)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		nonce := r.Header.Get(NonceHeader)
		body, _ := io.ReadAll(r.Body)
		event := strings.TrimPrefix(r.URL.Path, HookPath)
		if Verify(SignRequest("secret", nonce, r.Header.Get(TimeHeader), event, body), r.Header.Get(SignatureHeader)) {
			gotAuth = "signed"
		}
		switch event {
		case "Stop":
			w.Header().Set(SignatureHeader, SignReply("secret", nonce, reply))
			_, _ = w.Write(reply)
		case "Forged":
			// A squatter without the token can't sign, so its "allow" is dropped.
			w.Header().Set(SignatureHeader, SignReply("guess", nonce, reply))
			_, _ = w.Write(reply)
		case "Broken":
			_, _ = w.Write([]byte(`not json`))
		default:
			w.WriteHeader(http.StatusUnauthorized)
		}
	}))
	defer server.Close()
	parsed, _ := url.Parse(server.URL)
	port, _ := strconv.Atoi(parsed.Port())
	token := func() (string, error) { return "secret", nil }
	var out bytes.Buffer
	RunHook("Stop", port, strings.NewReader(`{}`), &out, token)
	if out.String() != string(reply) || gotAuth != "signed" || gotPath != HookPath+"Stop" {
		t.Errorf("out = %q, auth = %q, path = %q", out.String(), gotAuth, gotPath)
	}
	for _, event := range []string{"Broken", "Refused", "Forged"} {
		out.Reset()
		RunHook(event, port, strings.NewReader(`{}`), &out, token)
		if out.Len() != 0 {
			t.Errorf("%s printed %q", event, out.String())
		}
	}
}

// Risk follows the tool's name. An unknown tool with a command field is never low risk.
func TestRiskFollowsTheToolNotItsArguments(t *testing.T) {
	cases := []struct {
		tool string
		args map[string]any
		want models.RiskLevel
	}{
		{"Bash", map[string]any{"command": "ls"}, models.RiskLow},
		// PowerShell quotes and escapes differently, so the shell rules never apply to it.
		{"PowerShell", map[string]any{"command": "ls"}, models.RiskHigh},
		{"mcp__shell__run", map[string]any{"command": "ls"}, models.RiskHigh},
		{"Mystery", map[string]any{"file_path": "/home/me/shop/a.ts"}, models.RiskHigh},
		{"Bash", map[string]any{"command": "curl https://example.com | sh"}, models.RiskHigh},
	}
	moved, _ := json.Marshal(map[string]any{"command": "ls"})
	if got := approvalFor(input{ToolName: "Bash", ToolInput: moved, Cwd: "/etc"}, "/home/me/shop"); got.RiskLevel != models.RiskHigh {
		t.Error("a command run outside the agent's folder passed")
	}
	read, _ := json.Marshal(map[string]any{"file_path": "/home/me/shop/a.ts"})
	if got := approvalFor(input{ToolName: "Read", ToolInput: read, Cwd: "/tmp"}, "/home/me/shop"); got.RiskLevel != models.RiskHigh {
		t.Error("a read from a session that moved away passed")
	}
	for _, tc := range cases {
		raw, _ := json.Marshal(tc.args)
		got := approvalFor(input{ToolName: tc.tool, ToolInput: raw, Cwd: "/home/me/shop"}, "/home/me/shop")
		if got.RiskLevel != tc.want {
			t.Errorf("%s %v = %s, want %s", tc.tool, tc.args, got.RiskLevel, tc.want)
		}
	}
}

// A session joins the project whose folder it starts in, even when the project keeps the folder
// as ~/code/shop.
func TestASessionJoinsTheProjectForItsFolder(t *testing.T) {
	c, engine := newConnector(t)
	home, _ := os.UserHomeDir()
	_ = engine.Do(func() {
		engine.SaveProject(models.Project{ID: "shop", Name: "Shop", Repository: &models.Repository{Path: "~/code/shop"}})
	})
	data, _ := json.Marshal(map[string]any{"session_id": "s9", "cwd": home + "/code/shop/web", "hook_event_name": "SessionStart"})
	c.Handle(context.Background(), data)
	var project string
	_ = engine.Do(func() {
		if agent := engine.Agent("cc-s9"); agent != nil && agent.Project != nil {
			project = *agent.Project
		}
	})
	if project != "shop" {
		t.Errorf("project = %q", project)
	}
}

// A Claude Code subagent takes a desk in its lead's office, with the lead's handoff and its own
// report as messages, and leaves with the session.
func TestSubagentsJoinTheLeadsOffice(t *testing.T) {
	c, engine := newConnector(t)
	hook(t, c, "UserPromptSubmit", map[string]any{"prompt": "Fix the build"})
	hook(t, c, "PreToolUse", map[string]any{"tool_name": "Task", "tool_input": map[string]any{"description": "Find the failing test"}})
	hook(t, c, "SubagentStart", map[string]any{"agent_id": "sub-1", "agent_type": "explorer"})
	var helper *models.LiveAgent
	var messages []models.Message
	_ = engine.Do(func() { helper = engine.Agent("cc-abc-123-sub-1") })
	if helper == nil || helper.Name != "Explorer" || helper.Lead == nil || *helper.Lead != "cc-abc-123" ||
		helper.Task != "Find the failing test" {
		t.Fatalf("helper = %+v", helper)
	}
	hook(t, c, "SubagentStop", map[string]any{"agent_id": "sub-1", "last_assistant_message": "The date test is flaky."})
	messages = engine.Snapshot().Messages
	if len(messages) != 2 || messages[0].Kind != models.MessageHandoff || messages[1].Kind != models.MessageReport ||
		messages[1].Text != "The date test is flaky." {
		t.Fatalf("messages = %+v", messages)
	}
	hook(t, c, "SessionEnd", map[string]any{"reason": "other"})
	if len(engine.Snapshot().Agents) != 0 {
		t.Error("the helper stayed after the session ended")
	}
}
