// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/connectors/claudecode"
	"github.com/SamsonIdowu/mabari/internal/connectors/simulator"
	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/secrets"
	"github.com/SamsonIdowu/mabari/internal/store"
)

var (
	fakeOnce sync.Once
	fakePath string
	fakeErr  error
)

// fakeClaude builds the stand-in for claude. Tests hand it over by path, so these can't reach the
// real program, whatever is on PATH.
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
		out, err := exec.CommandContext(context.Background(), "go", "build", "-o", fakePath,
			"../connectors/claudecode/fakeclaude").CombinedOutput()
		if err != nil {
			fakeErr = errors.New(string(out))
		}
	})
	if fakeErr != nil {
		t.Fatal(fakeErr)
	}
	return fakePath
}

// runOffice is an office that runs Claude Code sessions, with no hooks answered: what these tests
// look at is the stream and the API. internal/connectors/claudecode covers the hooks.
type runOffice struct {
	*office
	connector *claudecode.Connector
	launcher  *fakeLauncher
	config    string
	folder    string
	logs      string
	data      string
	vault     *secrets.Memory
}

func newRunOffice(t *testing.T) *runOffice {
	t.Helper()
	program := fakeClaude(t)
	ctx := context.Background()
	s, err := store.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	engine, err := events.New(ctx, s, nil)
	if err != nil {
		t.Fatal(err)
	}
	connector := claudecode.New(engine)
	engine.AddConnector(claudecode.Source, connector)
	connector.Program = func() string { return program }
	connector.Hook = claudecode.Hook{Binary: program, Port: 1}
	root, err := os.MkdirTemp("", "run-office-")
	if err != nil {
		t.Fatal(err)
	}
	config, folder, logs := filepath.Join(root, "config"), filepath.Join(root, "shop"), filepath.Join(root, "logs")
	data := filepath.Join(root, "data")
	for _, dir := range []string{config, folder, logs, data} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("CLAUDE_CONFIG_DIR", config)
	t.Setenv("FAKE_CLAUDE_LOG", logs)
	t.Setenv("FAKE_HOOK_DIR", "")
	connector.ConfigDir = config
	t.Cleanup(func() {
		ending, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		connector.Shutdown(ending)
		_ = os.RemoveAll(root)
	})
	sim := simulator.New(engine, simulator.Mulberry32(7), 0)
	launcher := &fakeLauncher{}
	vault := secrets.NewMemory()
	handler := New(Options{
		Engine: engine, Simulator: sim, Launcher: launcher, DataDir: data,
		Claude: &ClaudeOptions{Connector: connector, Secrets: vault, ConfigDir: config},
	})
	return &runOffice{
		office:    &office{handler: handler, engine: engine, simulator: sim},
		connector: connector, launcher: launcher, config: config, folder: folder, logs: logs, data: data, vault: vault,
	}
}

func (o *runOffice) agentBody(extra string) string {
	body, _ := json.Marshal(map[string]any{
		"name": "Juniper", "account": "claude_code", "model": "claude-sonnet-4-5", "task": "say hello",
		"projectId": "", "folder": o.folder, "dailyCostCap": 5, "allowedTools": []string{"read", "edit", "shell"},
	})
	if extra == "" {
		return string(body)
	}
	return strings.TrimSuffix(string(body), "}") + "," + extra + "}"
}

func (o *runOffice) until(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("waited too long for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (o *runOffice) conversation(t *testing.T, id string) models.Conversation {
	t.Helper()
	response := o.do(t, http.MethodGet, "/api/agents/"+id+"/conversation", "")
	if response.Code != http.StatusOK {
		t.Fatalf("conversation: %d %s", response.Code, response.Body.String())
	}
	return decode[models.Conversation](t, response)
}

func (o *runOffice) said(t *testing.T, id, text string) bool {
	t.Helper()
	for _, item := range o.conversation(t, id).Items {
		if item.Text == text && !item.Streaming {
			return true
		}
	}
	return false
}

func (o *runOffice) start(t *testing.T) models.LiveAgent {
	t.Helper()
	response := o.do(t, http.MethodPost, "/api/agents", o.agentBody(""))
	if response.Code != http.StatusCreated {
		t.Fatalf("start: %d %s", response.Code, response.Body.String())
	}
	agent := decode[models.LiveAgent](t, response)
	o.until(t, "the reply", func() bool { return o.said(t, agent.ID, "Done: say hello") })
	return agent
}

func (o *runOffice) state(id string) models.LiveAgent {
	var copied models.LiveAgent
	_ = o.engine.Do(func() {
		if agent := o.engine.Agent(id); agent != nil {
			copied = *agent
		}
	})
	return copied
}

func (o *runOffice) claudeAccount(t *testing.T) models.Account {
	t.Helper()
	for _, account := range decode[[]models.Account](t, o.do(t, http.MethodGet, "/api/accounts", "")) {
		if account.Kind == models.AccountClaudeCode {
			return account
		}
	}
	t.Fatal("no Claude Code account")
	return models.Account{}
}

func TestClaudeCodeCanStartWithNoAttaching(t *testing.T) {
	o := newRunOffice(t)
	account := o.claudeAccount(t)
	if !account.CanStart || account.StartNote != "" || account.Missing != "" {
		t.Fatalf("account = %+v", account)
	}
	if account.Status == models.AccountConnected {
		t.Fatalf("nothing attached it: %+v", account)
	}
	if _, err := os.Stat(filepath.Join(o.config, "settings.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the settings file was touched")
	}
}

func TestAComputerWithoutClaudeSaysSo(t *testing.T) {
	o := newRunOffice(t)
	o.connector.Program = func() string { return "" }
	account := o.claudeAccount(t)
	if account.CanStart || account.Missing != "claude" || !strings.Contains(account.StartNote, "isn't installed") {
		t.Fatalf("account = %+v", account)
	}
}

// Nothing here sets a program, as in Docker and every older test, so nothing can start.
func TestWithoutAProgramNothingStarts(t *testing.T) {
	o := newOffice(t)
	response := o.do(t, http.MethodGet, "/api/accounts", "")
	for _, account := range decode[[]models.Account](t, response) {
		if account.Kind == models.AccountClaudeCode && account.CanStart {
			t.Fatalf("account = %+v", account)
		}
	}
}

func TestNewAgentStartsASessionAndItStreams(t *testing.T) {
	o := newRunOffice(t)
	agent := o.start(t)
	if agent.Session == nil || agent.Session.Status != models.SessionRunning || agent.Source != claudecode.Source {
		t.Fatalf("agent = %+v, session = %+v", agent.Agent, agent.Session)
	}
	if !strings.Contains(agent.Session.Resume, "claude --resume "+agent.Session.ID) {
		t.Fatalf("resume = %q", agent.Session.Resume)
	}
	conversation := o.conversation(t, agent.ID)
	if conversation.AgentID != agent.ID || conversation.HasMore || len(conversation.Items) != 3 {
		t.Fatalf("conversation = %+v", conversation)
	}
	if first := conversation.Items[1]; first.Kind != models.ConversationUser || first.From != models.SaidInMabari || first.Text != "say hello" {
		t.Fatalf("user item = %+v", first)
	}
}

func TestAnInstructionLandsOnAnIdleSessionThroughTheAPI(t *testing.T) {
	o := newRunOffice(t)
	agent := o.start(t)
	o.until(t, "it to finish", func() bool { return o.state(agent.ID).State == models.StateDone })
	body, _ := json.Marshal(map[string]string{"text": "and now this", "mode": "instruct", "target": agent.ID})
	if response := o.do(t, http.MethodPost, "/api/messages", string(body)); response.Code != http.StatusOK {
		t.Fatalf("send: %d %s", response.Code, response.Body.String())
	}
	if queued := o.state(agent.ID).Queued; len(queued) != 0 {
		t.Fatalf("queued = %+v", queued)
	}
	o.until(t, "the reply", func() bool { return o.said(t, agent.ID, "Done: and now this") })
}

func TestTheConversationAPIPagesBack(t *testing.T) {
	o := newRunOffice(t)
	_ = o.engine.Do(func() {
		for range 5 {
			o.engine.Converse("gone", models.ConversationItem{Kind: models.ConversationAssistant, Text: "x"})
		}
	})
	page := decode[models.Conversation](t, o.do(t, http.MethodGet, "/api/agents/gone/conversation?limit=2", ""))
	if !page.HasMore || len(page.Items) != 2 || page.Items[0].Seq != 4 {
		t.Fatalf("newest = %+v", page)
	}
	older := decode[models.Conversation](t, o.do(t, http.MethodGet, "/api/agents/gone/conversation?limit=10&before=4", ""))
	if older.HasMore || len(older.Items) != 3 {
		t.Fatalf("older = %+v", older)
	}
	if response := o.do(t, http.MethodGet, "/api/agents/nobody/conversation", ""); response.Code != http.StatusNotFound {
		t.Fatalf("unknown agent: %d", response.Code)
	}
}

// An agent nothing has been said to yet has an empty conversation, not a missing one.
func TestAnEmptyConversationIsNotAnError(t *testing.T) {
	o := newOffice(t)
	if response := o.do(t, http.MethodPost, "/api/demo/load", ""); response.Code >= 300 {
		t.Fatalf("demo: %d", response.Code)
	}
	id := o.engine.Snapshot().Agents[0].ID
	response := o.do(t, http.MethodGet, "/api/agents/"+id+"/conversation", "")
	if response.Code != http.StatusOK {
		t.Fatalf("conversation: %d", response.Code)
	}
	if items := decode[models.Conversation](t, response).Items; items == nil {
		t.Fatal("items is null, which a page would have to guard against")
	}
}

// -p skips the trust dialog, so Mabari asks for that click before running what a folder brings.
func TestAFolderThatBringsCodeNeedsAClickFirst(t *testing.T) {
	o := newRunOffice(t)
	config := filepath.Join(o.folder, ".mcp.json")
	if err := os.WriteFile(config, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	response := o.do(t, http.MethodPost, "/api/agents", o.agentBody(""))
	if response.Code != http.StatusConflict {
		t.Fatalf("start: %d %s", response.Code, response.Body.String())
	}
	refused := decode[struct {
		Error string      `json:"error"`
		Trust folderTrust `json:"trust"`
	}](t, response)
	if refused.Trust.Folder != o.folder || len(refused.Trust.Found) != 1 || refused.Trust.Found[0] != config {
		t.Fatalf("refused = %+v", refused)
	}
	if entries, _ := os.ReadDir(o.logs); len(entries) != 0 {
		t.Fatal("a session started before the click")
	}
	if got := len(o.engine.Snapshot().Agents); got != 0 {
		t.Fatalf("%d agents before the click", got)
	}
	body, _ := json.Marshal(map[string]any{"path": o.folder})
	if response := o.do(t, http.MethodPost, "/api/folders/trust", string(body)); response.Code != http.StatusBadRequest {
		t.Fatalf("trust without a click: %d", response.Code)
	}
	body, _ = json.Marshal(map[string]any{"path": o.folder, "confirm": true})
	if response := o.do(t, http.MethodPost, "/api/folders/trust", string(body)); response.Code != http.StatusOK {
		t.Fatalf("trust: %d %s", response.Code, response.Body.String())
	}
	if response := o.do(t, http.MethodPost, "/api/agents", o.agentBody("")); response.Code != http.StatusCreated {
		t.Fatalf("start after the click: %d %s", response.Code, response.Body.String())
	}
}

func TestTheTerminalStaysAChoice(t *testing.T) {
	o := newRunOffice(t)
	response := o.do(t, http.MethodPost, "/api/agents", o.agentBody(`"where":"terminal"`))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "Opened Claude Code") {
		t.Fatalf("start: %d %s", response.Code, response.Body.String())
	}
	if request := o.launcher.last(t); request.Folder != o.folder || request.Prompt != "say hello" {
		t.Fatalf("request = %+v", request)
	}
	if entries, _ := os.ReadDir(o.logs); len(entries) != 0 {
		t.Fatal("a session ran here as well")
	}
}

func TestTheCapIsSaidOutLoud(t *testing.T) {
	o := newRunOffice(t)
	if response := o.do(t, http.MethodPatch, "/api/settings", `{"maxSessions":1}`); response.Code != http.StatusOK {
		t.Fatalf("settings: %d %s", response.Code, response.Body.String())
	}
	first := o.agentBody("")
	first = strings.Replace(first, "say hello", "fake:hang", 1)
	if response := o.do(t, http.MethodPost, "/api/agents", first); response.Code != http.StatusCreated {
		t.Fatalf("first: %d %s", response.Code, response.Body.String())
	}
	second := strings.Replace(o.agentBody(""), "Juniper", "Pepper", 1)
	response := o.do(t, http.MethodPost, "/api/agents", second)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "raise the limit in Settings") {
		t.Fatalf("second: %d %s", response.Code, response.Body.String())
	}
}

func TestTheCapSettingIsChecked(t *testing.T) {
	o := newRunOffice(t)
	for _, value := range []string{"0", "17", "-1"} {
		if response := o.do(t, http.MethodPatch, "/api/settings", `{"maxSessions":`+value+`}`); response.Code != http.StatusBadRequest {
			t.Errorf("%s: %d", value, response.Code)
		}
	}
	if got := decode[models.Settings](t, o.do(t, http.MethodGet, "/api/settings", "")).MaxSessions; got != models.DefaultSessions {
		t.Fatalf("default = %d", got)
	}
}

// In the demo, agents are simulated. No session starts, whatever is installed.
func TestTheDemoNeverStartsASession(t *testing.T) {
	o := newRunOffice(t)
	if response := o.do(t, http.MethodPost, "/api/demo/load", ""); response.Code >= 300 {
		t.Fatalf("demo: %d", response.Code)
	}
	response := o.do(t, http.MethodPost, "/api/agents", o.agentBody(""))
	if response.Code != http.StatusCreated {
		t.Fatalf("start: %d %s", response.Code, response.Body.String())
	}
	if agent := decode[models.LiveAgent](t, response); agent.Source != simulator.Source {
		t.Fatalf("source = %s", agent.Source)
	}
	if entries, _ := os.ReadDir(o.logs); len(entries) != 0 {
		t.Fatal("the demo started a real session")
	}
}

func TestProjectChatStartsASessionWithNoTerminal(t *testing.T) {
	o := newRunOffice(t)
	created := o.do(t, http.MethodPost, "/api/projects", `{"name":"Shop","color":"#48DBFB"}`)
	project := decode[models.Project](t, created)
	_ = o.engine.Do(func() {
		saved := *o.engine.Project(project.ID)
		saved.Repository = &models.Repository{Path: o.folder}
		o.engine.SaveProject(saved)
	})
	response := o.do(t, http.MethodPost, "/api/projects/"+project.ID+"/send", `{"text":"look around"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("send: %d %s", response.Code, response.Body.String())
	}
	result := decode[projectSendResult](t, response)
	if result.AgentID == "" || result.Opened {
		t.Fatalf("result = %+v", result)
	}
	o.until(t, "the reply", func() bool { return o.said(t, result.AgentID, "Done: look around") })
	if len(o.launcher.requests) != 0 {
		t.Fatal("a terminal opened")
	}
	// It stays and takes the next message at once, so no second session starts.
	o.until(t, "it to finish", func() bool { return o.state(result.AgentID).State == models.StateDone })
	again := decode[projectSendResult](t, o.do(t, http.MethodPost, "/api/projects/"+project.ID+"/send", `{"text":"and again"}`))
	if again.AgentID != result.AgentID {
		t.Fatalf("again = %+v", again)
	}
	o.until(t, "the reply", func() bool { return o.said(t, result.AgentID, "Done: and again") })
}

func TestProjectChatAsksAboutAFolderThatBringsCode(t *testing.T) {
	o := newRunOffice(t)
	if err := os.WriteFile(filepath.Join(o.folder, ".mcp.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	project := decode[models.Project](t, o.do(t, http.MethodPost, "/api/projects", `{"name":"Shop","color":"#48DBFB"}`))
	_ = o.engine.Do(func() {
		saved := *o.engine.Project(project.ID)
		saved.Repository = &models.Repository{Path: o.folder}
		o.engine.SaveProject(saved)
	})
	response := o.do(t, http.MethodPost, "/api/projects/"+project.ID+"/send", `{"text":"look around"}`)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"trust"`) {
		t.Fatalf("send: %d %s", response.Code, response.Body.String())
	}
	if entries, _ := os.ReadDir(o.logs); len(entries) != 0 {
		t.Fatal("a session started")
	}
}

func TestTakingOverASessionNeedsThePersonsWord(t *testing.T) {
	o := newRunOffice(t)
	body, _ := json.Marshal(map[string]any{
		"session_id": "elsewhere", "cwd": o.folder, "hook_event_name": "Stop", "last_assistant_message": "Done.",
	})
	o.connector.Handle(context.Background(), body)
	id := "cc-elsewhere"
	response := o.do(t, http.MethodPost, "/api/agents/"+id+"/session/resume", `{}`)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "may still be open") {
		t.Fatalf("resume: %d %s", response.Code, response.Body.String())
	}
	if status := o.state(id).Session.Status; status != models.SessionElsewhere {
		t.Fatalf("status = %s", status)
	}
	response = o.do(t, http.MethodPost, "/api/agents/"+id+"/session/resume", `{"confirm":true}`)
	if response.Code != http.StatusOK {
		t.Fatalf("resume: %d %s", response.Code, response.Body.String())
	}
	if status := o.state(id).Session.Status; status != models.SessionResumable {
		t.Fatalf("status = %s", status)
	}
}

func TestReleaseLetsASessionGoAndKeepsItResumable(t *testing.T) {
	o := newRunOffice(t)
	agent := o.start(t)
	o.until(t, "it to finish", func() bool { return o.state(agent.ID).State == models.StateDone })
	if response := o.do(t, http.MethodPost, "/api/agents/"+agent.ID+"/session/release", ""); response.Code != http.StatusOK {
		t.Fatalf("release: %d %s", response.Code, response.Body.String())
	}
	if status := o.state(agent.ID).Session.Status; status != models.SessionResumable {
		t.Fatalf("status = %s", status)
	}
	if response := o.do(t, http.MethodPost, "/api/agents/nobody/session/release", ""); response.Code != http.StatusNotFound {
		t.Fatalf("nobody: %d", response.Code)
	}
}

func TestStopEndsASessionThroughTheAPI(t *testing.T) {
	o := newRunOffice(t)
	agent := o.start(t)
	if response := o.do(t, http.MethodPost, "/api/agents/"+agent.ID+"/stop", ""); response.Code != http.StatusOK {
		t.Fatalf("stop: %d %s", response.Code, response.Body.String())
	}
	if saved := o.state(agent.ID); saved.ID != "" {
		t.Fatalf("still here: %+v", saved.Agent)
	}
	if !o.said(t, agent.ID, "Done: say hello") {
		t.Fatal("the conversation went with it")
	}
}

// claudePlan asks the planner for a plan on Claude Code, which needs no attaching.
func (o *runOffice) claudePlan(t *testing.T) string {
	t.Helper()
	reply := decode[planReply](t, o.do(t, http.MethodPost, "/api/planner", `{"said":["Build a coffee shop site, use Claude"]}`))
	if reply.Plan.Account != models.AccountClaudeCode {
		t.Fatalf("the planner chose %s", reply.Plan.Account)
	}
	plan, _ := json.Marshal(reply.Plan)
	return string(plan)
}

func TestNewProjectStartsItsLeadWithNoTerminal(t *testing.T) {
	o := newRunOffice(t)
	response := o.do(t, http.MethodPost, "/api/projects/start",
		`{"plan":`+o.claudePlan(t)+`,"name":"Coffee shop","mode":"go","folder":"`+o.folder+`","brief":"Sell beans"}`)
	result := decode[struct {
		LeadID  string         `json:"leadId"`
		Notice  string         `json:"notice"`
		Project models.Project `json:"project"`
	}](t, response)
	if response.Code != http.StatusCreated || result.LeadID == "" || result.Notice != "" {
		t.Fatalf("start = %d %+v", response.Code, result)
	}
	if len(o.launcher.requests) != 0 {
		t.Fatal("a terminal opened")
	}
	lead := o.state(result.LeadID)
	if lead.Project == nil || *lead.Project != result.Project.ID || lead.Session == nil || lead.Session.Mode != "default" {
		t.Fatalf("lead = %+v, session %+v", lead.Agent, lead.Session)
	}
	o.until(t, "the brief", func() bool {
		for _, item := range o.conversation(t, result.LeadID).Items {
			if item.Kind == models.ConversationUser && strings.Contains(item.Text, "Sell beans") {
				return true
			}
		}
		return false
	})
}

func TestPlanFirstStartsTheLeadInPlanMode(t *testing.T) {
	o := newRunOffice(t)
	response := o.do(t, http.MethodPost, "/api/projects/start",
		`{"plan":`+o.claudePlan(t)+`,"name":"Coffee shop","mode":"plan","folder":"`+o.folder+`"}`)
	result := decode[map[string]any](t, response)
	lead := o.state(result["leadId"].(string))
	if lead.Session == nil || lead.Session.Mode != "plan" {
		t.Fatalf("session = %+v", lead.Session)
	}
}

func TestNewProjectInATerminalIsStillAChoice(t *testing.T) {
	o := newRunOffice(t)
	response := o.do(t, http.MethodPost, "/api/projects/start",
		`{"plan":`+o.claudePlan(t)+`,"name":"Coffee shop","mode":"go","folder":"`+o.folder+`","where":"terminal"}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("start = %d %s", response.Code, response.Body.String())
	}
	if request := o.launcher.last(t); request.Folder != o.folder {
		t.Fatalf("request = %+v", request)
	}
	if entries, _ := os.ReadDir(o.logs); len(entries) != 0 {
		t.Fatal("a session ran here as well")
	}
}

// Asked before anything is made, so saying no leaves no project behind.
func TestNewProjectAsksAboutAFolderBeforeMakingAnything(t *testing.T) {
	o := newRunOffice(t)
	if err := os.WriteFile(filepath.Join(o.folder, ".mcp.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	response := o.do(t, http.MethodPost, "/api/projects/start",
		`{"plan":`+o.claudePlan(t)+`,"name":"Coffee shop","mode":"go","folder":"`+o.folder+`"}`)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"trust"`) {
		t.Fatalf("start = %d %s", response.Code, response.Body.String())
	}
	if projects := o.engine.Snapshot().Projects; len(projects) != 0 {
		t.Fatalf("made %+v", projects)
	}
}

func TestStartingAnAgentFileAtTheDeskRunsItHere(t *testing.T) {
	o := newRunOffice(t)
	withDefs(o.office, plannerFile)
	created := decode[models.Project](t, o.do(t, http.MethodPost, "/api/projects", `{"name":"Shop","color":"#48DBFB"}`))
	if response := o.do(t, http.MethodPatch, "/api/projects/"+created.ID, `{"folder":"`+o.folder+`"}`); response.Code != http.StatusOK {
		t.Fatalf("attach = %d %s", response.Code, response.Body.String())
	}
	response := o.do(t, http.MethodPost, "/api/desks/start",
		`{"defId":"account:planner","projectId":"`+created.ID+`","task":"Plan the checkout page"}`)
	result := decode[deskStartResult](t, response)
	if response.Code != http.StatusCreated || result.AgentID == "" {
		t.Fatalf("start = %d %+v", response.Code, result)
	}
	agent := o.state(result.AgentID)
	if agent.DefID != plannerFile.ID || agent.Session.AgentFile != "planner" {
		t.Fatalf("agent = %+v, session %+v", agent.Agent, agent.Session)
	}
	o.until(t, "the reply", func() bool { return o.said(t, result.AgentID, "Done: Plan the checkout page") })
	if len(o.launcher.requests) != 0 {
		t.Fatal("a terminal opened")
	}
	args, err := os.ReadFile(filepath.Join(o.logs, agent.Session.ID+".args")) // #nosec G304 -- a test's own file
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(args), `"--agent","planner"`) {
		t.Fatalf("args = %s", args)
	}
	// No terminal session reports, so nothing is left waiting for one.
	_ = o.engine.Do(func() {
		if project := o.engine.Project(created.ID); len(project.Opening) != 0 {
			t.Errorf("opening = %+v", project.Opening)
		}
	})
}

// A file sent to one session, through the one send, is readable there with no click, and only there.
func TestAnAttachmentIsReadableByTheSessionItWasSentTo(t *testing.T) {
	o := newRunOffice(t)
	agent := o.start(t)
	o.until(t, "the first turn", func() bool { return o.state(agent.ID).State == models.StateDone })
	other := o.do(t, http.MethodPost, "/api/agents", strings.Replace(o.agentBody(""), "Juniper", "Pepper", 1))
	if other.Code != http.StatusCreated && other.Code != http.StatusOK {
		t.Fatalf("second agent: %d %s", other.Code, other.Body.String())
	}
	second := decode[models.LiveAgent](t, other)
	o.until(t, "the second agent's turn", func() bool { return o.state(second.ID).State == models.StateDone })
	uploaded := o.do(t, http.MethodPost, "/api/attachments?name=notes.txt", "words")
	if uploaded.Code != http.StatusCreated {
		t.Fatalf("upload: %d %s", uploaded.Code, uploaded.Body.String())
	}
	file := decode[Attachment](t, uploaded)
	sent := o.do(t, http.MethodPost, "/api/chat/send", asJSON(map[string]any{
		"agentId": agent.ID, "text": "look at this", "attachments": []string{file.ID},
	}))
	if sent.Code != http.StatusOK {
		t.Fatalf("send: %d %s", sent.Code, sent.Body.String())
	}
	answer := func(session, path string) string {
		body, _ := json.Marshal(map[string]any{
			"session_id": session, "cwd": o.folder, "hook_event_name": "PreToolUse", "tool_name": "Read",
			"tool_input": map[string]any{"file_path": path},
		})
		return string(o.connector.HandleRun(context.Background(), body))
	}
	if got := answer(agent.Session.ID, file.Path); !strings.Contains(got, `"permissionDecision":"allow"`) {
		t.Errorf("the session it was sent to: %s", got)
	}
	if got := answer(second.Session.ID, file.Path); !strings.Contains(got, `"permissionDecision":"ask"`) {
		t.Errorf("another session: %s", got)
	}
	if got := answer(agent.Session.ID, filepath.Join(filepath.Dir(file.Path), "other.txt")); !strings.Contains(got, `"permissionDecision":"ask"`) {
		t.Errorf("another file: %s", got)
	}
}
