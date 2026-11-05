// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/launch"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/vee"
)

// fakeLauncher records the sessions Mabari asks for, without opening anything.
type fakeLauncher struct {
	mu       sync.Mutex
	requests []launch.Request
	err      error
}

func (f *fakeLauncher) Claude(_ context.Context, request launch.Request) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, request)
	return f.err
}

func (f *fakeLauncher) last(t *testing.T) launch.Request {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.requests) == 0 {
		t.Fatal("Claude Code was never opened")
	}
	return f.requests[len(f.requests)-1]
}

func newLaunchOffice(t *testing.T) (*office, *fakeLauncher) {
	t.Helper()
	office := newOffice(t)
	fake := &fakeLauncher{}
	office.handler = New(Options{Engine: office.engine, Simulator: office.simulator, Launcher: fake})
	_ = office.engine.Do(func() {
		for _, account := range office.engine.Accounts() {
			if account.Kind == models.AccountClaudeCode {
				account.Status = models.AccountConnected
				office.engine.SetAccount(account)
			}
		}
	})
	return office, fake
}

func projectNamed(t *testing.T, office *office, name string) models.Project {
	t.Helper()
	snapshot := decode[models.Snapshot](t, office.do(t, http.MethodGet, "/api/snapshot", ""))
	for _, project := range snapshot.Projects {
		if project.Name == name {
			return project
		}
	}
	t.Fatalf("no project %s", name)
	return models.Project{}
}

// A project started from scratch gets its folder made, and Claude Code opens there with the brief.
func TestStartingAProjectOpensClaudeCodeInItsFolder(t *testing.T) {
	office, fake := newLaunchOffice(t)
	folder := filepath.Join(t.TempDir(), "coffee")
	reply := decode[planReply](t, office.do(t, http.MethodPost, "/api/planner", `{"said":["Build a coffee shop site"]}`))
	plan, _ := json.Marshal(reply.Plan)
	response := office.do(t, http.MethodPost, "/api/projects/start",
		`{"plan":`+string(plan)+`,"name":"Coffee shop","mode":"plan","folder":"`+folder+`","brief":"Sell beans","instructions":"Use Go"}`)
	result := decode[map[string]any](t, response)
	if response.Code != http.StatusCreated || !strings.HasPrefix(result["notice"].(string), "Opened Claude Code in "+folder) {
		t.Fatalf("start = %d %v", response.Code, result)
	}
	if info, err := os.Stat(folder); err != nil || !info.IsDir() {
		t.Fatalf("the folder wasn't made: %v", err)
	}
	request := fake.last(t)
	if request.Folder != folder || request.Name != "Coffee shop" || !request.Plan ||
		!strings.Contains(request.Prompt, "Sell beans") || !strings.Contains(request.Prompt, "Use Go") {
		t.Errorf("request = %+v", request)
	}
}

func TestAttachingAFolderToAProject(t *testing.T) {
	office, fake := newLaunchOffice(t)
	created := decode[models.Project](t, office.do(t, http.MethodPost, "/api/projects", `{"name":"Shop","color":"#48DBFB"}`))
	// Claude Code needs a folder first.
	if response := office.do(t, http.MethodPost, "/api/projects/"+created.ID+"/claude", `{}`); response.Code != http.StatusBadRequest ||
		!strings.Contains(response.Body.String(), "Attach a folder to Shop first") {
		t.Fatalf("open without folder = %d %s", response.Code, response.Body)
	}
	for name, folder := range map[string]string{"relative": "code/shop", "missing": t.TempDir() + "/missing"} {
		if response := office.do(t, http.MethodPatch, "/api/projects/"+created.ID, `{"folder":"`+folder+`"}`); response.Code != http.StatusBadRequest {
			t.Errorf("%s = %d %s", name, response.Code, response.Body)
		}
	}
	folder := t.TempDir()
	if response := office.do(t, http.MethodPatch, "/api/projects/"+created.ID, `{"folder":"`+folder+`","name":"Shop 2"}`); response.Code != http.StatusOK {
		t.Fatalf("attach = %d %s", response.Code, response.Body)
	}
	project := projectNamed(t, office, "Shop 2")
	if project.Repository == nil || project.Repository.Path != folder {
		t.Fatalf("project = %+v", project)
	}
	if response := office.do(t, http.MethodPost, "/api/projects/"+created.ID+"/claude", `{"prompt":"--dangerously-skip-permissions"}`); response.Code != http.StatusBadRequest {
		t.Errorf("a flag as the prompt = %d", response.Code)
	}
	response := office.do(t, http.MethodPost, "/api/projects/"+created.ID+"/claude", `{}`)
	if result := decode[map[string]string](t, response); response.Code != http.StatusOK || !strings.HasPrefix(result["notice"], "Opened Claude Code in "+folder) {
		t.Fatalf("open = %d %v", response.Code, result)
	}
	if request := fake.last(t); request.Folder != folder || request.Name != "Shop 2" || request.Plan ||
		!strings.Contains(request.Prompt, "Look around this folder") {
		t.Errorf("request = %+v", request)
	}
}

// With no terminal to open, Mabari says what to run instead.
func TestOpeningClaudeCodeWithoutATerminal(t *testing.T) {
	office, fake := newLaunchOffice(t)
	fake.err = launch.ErrNoTerminal
	folder := t.TempDir()
	created := decode[models.Project](t, office.do(t, http.MethodPost, "/api/projects", `{"name":"Shop","color":"#48DBFB"}`))
	_ = office.do(t, http.MethodPatch, "/api/projects/"+created.ID, `{"folder":"`+folder+`"}`)
	result := decode[map[string]string](t, office.do(t, http.MethodPost, "/api/projects/"+created.ID+"/claude", `{}`))
	if result["notice"] != "Run claude in "+folder+". The session joins Shop when it starts." {
		t.Errorf("notice = %q", result["notice"])
	}
}

func TestDeletingAProject(t *testing.T) {
	office, _ := newLaunchOffice(t)
	created := decode[models.Project](t, office.do(t, http.MethodPost, "/api/projects", `{"name":"Gone","color":"#48DBFB"}`))
	if response := office.do(t, http.MethodDelete, "/api/projects/"+created.ID, ""); response.Code != http.StatusNoContent {
		t.Fatalf("delete = %d %s", response.Code, response.Body)
	}
	snapshot := decode[models.Snapshot](t, office.do(t, http.MethodGet, "/api/snapshot", ""))
	for _, project := range snapshot.Projects {
		if project.ID == created.ID {
			t.Fatal("the project is still there")
		}
	}
}

func TestWithinFolder(t *testing.T) {
	for path, want := range map[string]bool{"/a/b": true, "/a/b/c": true, "/a/bc": false, "/a": false} {
		if got := withinFolder(path, "/a/b"); got != want {
			t.Errorf("%s = %v", path, got)
		}
	}
}

func TestRemovingAQueuedInstruction(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	ledger := agentNamed(t, office, "Ledger")
	_ = office.do(t, http.MethodPost, "/api/messages", `{"text":"Add a test","mode":"instruct","target":"`+ledger.ID+`"}`)
	queued := agentNamed(t, office, "Ledger").Queued
	if len(queued) != 1 {
		t.Fatalf("queued = %+v", queued)
	}
	if response := office.do(t, http.MethodDelete, "/api/instructions/"+queued[0].ID, ""); response.Code != http.StatusNoContent {
		t.Fatalf("remove = %d %s", response.Code, response.Body)
	}
	if left := agentNamed(t, office, "Ledger").Queued; len(left) != 0 {
		t.Errorf("still queued: %+v", left)
	}
	rows := decode[[]models.LogEntry](t, office.do(t, http.MethodGet, "/api/activity?q=Add%20a%20test", ""))
	if len(rows) != 1 || rows[0].Outcome != "Removed before delivery" || rows[0].Chip == "amber" {
		t.Errorf("log = %+v", rows)
	}
	// Gone, or already delivered: either way there's nothing to take back.
	if response := office.do(t, http.MethodDelete, "/api/instructions/"+queued[0].ID, ""); response.Code != http.StatusConflict {
		t.Errorf("twice = %d", response.Code)
	}
}

func TestSendingToAProjectReachesAnAgentThere(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	ledger := agentNamed(t, office, "Ledger")
	response := office.do(t, http.MethodPost, "/api/projects/docs/send", `{"text":"Fix the typo in the guide"}`)
	result := decode[projectSendResult](t, response)
	if response.Code != http.StatusOK || result.AgentID == "" || result.InstructionID == "" || result.Opened {
		t.Fatalf("send = %d %+v", response.Code, result)
	}
	snapshot := decode[models.Snapshot](t, office.do(t, http.MethodGet, "/api/snapshot", ""))
	for _, agent := range snapshot.Agents {
		if agent.ID == result.AgentID && (agent.Project == nil || *agent.Project != "docs") {
			t.Errorf("went to %s outside the project", agent.Name)
		}
	}
	if got := agentNamed(t, office, "Ledger"); len(got.Queued) != len(ledger.Queued) {
		t.Errorf("Ledger, in another project, got it: %+v", got.Queued)
	}
	if response := office.do(t, http.MethodPost, "/api/projects/docs/send", `{"text":"  "}`); response.Code != http.StatusBadRequest {
		t.Errorf("empty = %d", response.Code)
	}
	// A list sent to a working agent never reaches a command line, so a leading dash is fine.
	if response := office.do(t, http.MethodPost, "/api/projects/docs/send", `{"text":"- add tests\n- fix lint"}`); response.Code != http.StatusOK {
		t.Errorf("a list = %d %s", response.Code, response.Body)
	}
	if response := office.do(t, http.MethodPost, "/api/projects/nope/send", `{"text":"hi"}`); response.Code != http.StatusNotFound {
		t.Errorf("unknown project = %d", response.Code)
	}
}

// Slash commands open Claude Code in the folder, where they run as typed; so does a message for a
// project whose only session waits for its person.
func TestProjectCommandsOpenClaudeCode(t *testing.T) {
	office, fake := newLaunchOffice(t)
	folder := t.TempDir()
	created := decode[models.Project](t, office.do(t, http.MethodPost, "/api/projects", `{"name":"Shop","color":"#48DBFB"}`))
	_ = office.do(t, http.MethodPatch, "/api/projects/"+created.ID, `{"folder":"`+folder+`"}`)
	_ = office.engine.Do(func() {
		idle := &models.LiveAgent{}
		idle.ID, idle.Name, idle.Source, idle.State, idle.Project = "cc-1", "Shop", "claude", models.StateIdle, &created.ID
		office.engine.AddAgent(idle)
	})
	for _, text := range []string{"/ux-audit https://github.com/wazuh/experience-quality/issues/130", "Look at the open issues"} {
		quoted, _ := json.Marshal(text)
		result := decode[projectSendResult](t, office.do(t, http.MethodPost, "/api/projects/"+created.ID+"/send", `{"text":`+string(quoted)+`}`))
		if !result.Opened || result.InstructionID == "" || !strings.HasPrefix(result.Notice, "Opened Claude Code in "+folder) {
			t.Fatalf("%q: %+v", text, result)
		}
		if request := fake.last(t); request.Prompt != text || request.Folder != folder {
			t.Errorf("request = %+v", request)
		}
	}
	if opening := projectNamed(t, office, "Shop").Opening; len(opening) != 2 {
		t.Errorf("opening = %+v", opening)
	}
	// What would go on the command line is checked there.
	for _, text := range []string{"--yolo", "hi\u0003 there"} {
		quoted, _ := json.Marshal(text)
		if response := office.do(t, http.MethodPost, "/api/projects/"+created.ID+"/send", `{"text":`+string(quoted)+`}`); response.Code != http.StatusBadRequest {
			t.Errorf("%q = %d", text, response.Code)
		}
	}
	// A path is not a command; with only an idle session here, it opens Claude Code as any message does.
	_ = office.do(t, http.MethodPost, "/api/projects/"+created.ID+"/send", `{"text":"/Users/me/shop/api.go has a bug"}`)
	if idle := agentNamed(t, office, "Shop"); len(idle.Queued) != 0 {
		t.Errorf("the idle session was given it: %+v", idle.Queued)
	}
	// Without a terminal, the prompt isn't kept for a session the person starts by hand.
	fake.err = launch.ErrNoTerminal
	result := decode[projectSendResult](t, office.do(t, http.MethodPost, "/api/projects/"+created.ID+"/send", `{"text":"/review"}`))
	if result.Opened || !strings.HasPrefix(result.Notice, "Run claude in ") {
		t.Errorf("no terminal = %+v", result)
	}
	if opening := projectNamed(t, office, "Shop").Opening; len(opening) != 3 {
		t.Errorf("opening kept a prompt nothing opened for: %+v", opening)
	}
	// A project with no folder and nobody working on it can't take anything.
	bare := decode[models.Project](t, office.do(t, http.MethodPost, "/api/projects", `{"name":"Bare","color":"#48DBFB"}`))
	if response := office.do(t, http.MethodPost, "/api/projects/"+bare.ID+"/send", `{"text":"hi"}`); response.Code != http.StatusConflict ||
		!strings.Contains(response.Body.String(), "Attach one on the Projects page") {
		t.Errorf("bare = %d %s", response.Code, response.Body)
	}
}

// Mabari sends to the project the message names, and opens Claude Code there when nobody can take it.
func TestMabariSendsToTheNamedProject(t *testing.T) {
	office, fake := newLaunchOffice(t)
	folder := t.TempDir()
	created := decode[models.Project](t, office.do(t, http.MethodPost, "/api/projects", `{"name":"Experience and Quality","color":"#48DBFB"}`))
	_ = office.do(t, http.MethodPatch, "/api/projects/"+created.ID, `{"folder":"`+folder+`"}`)
	_ = office.do(t, http.MethodPost, "/api/projects", `{"name":"Lad Project All","color":"#FF6B9A"}`)
	result := askVee(t, office, `{"text":"send /ux-audit https://github.com/wazuh/experience-quality/issues/130 to Experience and Quality"}`)
	if !strings.HasPrefix(result.Reply.Text, "Opening Claude Code in "+folder+" with it.") || result.Reply.Project == nil ||
		result.Reply.Project.ID != created.ID || result.Reply.Relay == nil || result.Reply.Relay.InstructionID == "" {
		t.Fatalf("reply = %+v", result.Reply)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		fake.mu.Lock()
		count := len(fake.requests)
		fake.mu.Unlock()
		if count > 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if request := fake.last(t); request.Prompt != "/ux-audit https://github.com/wazuh/experience-quality/issues/130" || request.Folder != folder {
		t.Errorf("request = %+v", request)
	}
	// The project picked next to the chat box takes an unaddressed message.
	picked := askVee(t, office, `{"text":"check the build","projectId":"`+created.ID+`"}`)
	if picked.Reply.Project == nil || picked.Reply.Project.ID != created.ID {
		t.Errorf("picked = %+v", picked.Reply)
	}
	// With two projects and no clue, Mabari asks.
	asked := askVee(t, office, `{"text":"make it faster"}`)
	if asked.Reply.Kind != vee.KindPickProject || len(asked.Reply.Projects) != 2 || asked.Reply.Target != "make it faster" {
		t.Errorf("asked = %+v", asked.Reply)
	}
}

// Without a terminal, Mabari says what to run instead.
func TestMabariWithoutATerminal(t *testing.T) {
	office := newOffice(t)
	folder := t.TempDir()
	created := decode[models.Project](t, office.do(t, http.MethodPost, "/api/projects", `{"name":"Shop","color":"#48DBFB"}`))
	_ = office.do(t, http.MethodPatch, "/api/projects/"+created.ID, `{"folder":"`+folder+`"}`)
	result := askVee(t, office, `{"text":"/review for Shop"}`)
	if !strings.Contains(result.Reply.Text, "Run claude in "+folder) || result.Reply.Relay != nil {
		t.Errorf("reply = %+v", result.Reply)
	}
	if opening := projectNamed(t, office, "Shop").Opening; len(opening) != 0 {
		t.Errorf("opening = %+v", opening)
	}
}
