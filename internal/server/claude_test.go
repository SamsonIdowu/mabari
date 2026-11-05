// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/connectors/claudecode"
	"github.com/SamsonIdowu/mabari/internal/connectors/simulator"
	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/secrets"
	"github.com/SamsonIdowu/mabari/internal/store"
)

type claudeOffice struct {
	*office
	vault *secrets.Memory
	dir   string
}

// newClaudeOffice is an office with Claude Code connected to a scratch settings folder, never
// the real ~/.claude.
func newClaudeOffice(t *testing.T) *claudeOffice {
	t.Helper()
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
	vault := secrets.NewMemory()
	dir := t.TempDir()
	original := `{"model": "claude-opus-4-1"}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	sim := simulator.New(engine, simulator.Mulberry32(7), 0)
	handler := New(Options{Engine: engine, Simulator: sim, Claude: &ClaudeOptions{
		Connector: connector, Secrets: vault, ConfigDir: dir,
		Hook: claudecode.Hook{Binary: "/opt/mabari/mabari", Port: 4317},
	}})
	return &claudeOffice{office: &office{handler: handler, engine: engine, simulator: sim}, vault: vault, dir: dir}
}

func (o *claudeOffice) hook(t *testing.T, token, event, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:4317"+claudecode.HookPath+event,
		strings.NewReader(body))
	if token != "" {
		nonce := fmt.Sprintf("nonce-%d-%s", time.Now().UnixNano(), event)
		sent := strconv.FormatInt(time.Now().Unix(), 10)
		request.Header.Set(claudecode.NonceHeader, nonce)
		request.Header.Set(claudecode.TimeHeader, sent)
		request.Header.Set(claudecode.SignatureHeader, claudecode.SignRequest(token, nonce, sent, event, []byte(body)))
	}
	recorder := httptest.NewRecorder()
	o.handler.ServeHTTP(recorder, request)
	return recorder
}

func TestConnectShowsTheChangeThenWritesIt(t *testing.T) {
	o := newClaudeOffice(t)
	plan := decode[claudeStatus](t, o.do(t, http.MethodGet, "/api/accounts/claude", ""))
	if plan.Attached || len(plan.Diff) == 0 || !strings.HasSuffix(plan.Backup, ".mabari-backup") {
		t.Errorf("plan = %+v", plan)
	}
	if response := o.do(t, http.MethodPost, "/api/accounts/claude/connect", `{}`); response.Code != http.StatusBadRequest {
		t.Errorf("unconfirmed connect = %d", response.Code)
	}
	if response := o.do(t, http.MethodPost, "/api/accounts/claude/connect", `{"confirm":true}`); response.Code != http.StatusOK {
		t.Fatalf("connect = %d %s", response.Code, response.Body)
	}
	if !claudecode.Attached(o.dir) {
		t.Error("not attached")
	}
	token, err := o.vault.Get(claudecode.TokenName)
	if err != nil || !strings.HasPrefix(token, "mab_hook_") {
		t.Errorf("token = %q, %v", token, err)
	}
	settings, _ := os.ReadFile(filepath.Join(o.dir, "settings.json"))
	if strings.Contains(string(settings), token) {
		t.Error("the token was written into settings.json")
	}

	if response := o.do(t, http.MethodPost, "/api/accounts/claude/disconnect", ""); response.Code != http.StatusOK {
		t.Fatalf("disconnect = %d", response.Code)
	}
	if claudecode.Attached(o.dir) {
		t.Error("still attached")
	}
	if _, err := o.vault.Get(claudecode.TokenName); err == nil {
		t.Error("the token was kept")
	}
}

func TestHooksNeedTheInstallToken(t *testing.T) {
	o := newClaudeOffice(t)
	o.do(t, http.MethodPost, "/api/accounts/claude/connect", `{"confirm":true}`)
	token, _ := o.vault.Get(claudecode.TokenName)
	body := `{"session_id":"s1","cwd":"/tmp/shop","hook_event_name":"SessionStart"}`
	for name, given := range map[string]string{"no token": "", "wrong token": "mab_hook_nope"} {
		if response := o.hook(t, given, "SessionStart", body); response.Code != http.StatusUnauthorized {
			t.Errorf("%s = %d", name, response.Code)
		}
	}
	// A call signed for another event is refused too.
	if response := o.hook(t, token, "Stop", body); response.Code != http.StatusOK {
		t.Fatalf("hook = %d", response.Code)
	}
	sent := strconv.FormatInt(time.Now().Unix(), 10)
	signed := func(nonce, sent, signedEvent string) int {
		request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:4317"+claudecode.HookPath+"SessionStart",
			strings.NewReader(body))
		request.Header.Set(claudecode.NonceHeader, nonce)
		request.Header.Set(claudecode.TimeHeader, sent)
		request.Header.Set(claudecode.SignatureHeader, claudecode.SignRequest(token, nonce, sent, signedEvent, []byte(body)))
		recorder := httptest.NewRecorder()
		o.handler.ServeHTTP(recorder, request)
		return recorder.Code
	}
	if code := signed("0123456789abcdef-a", sent, "Stop"); code != http.StatusUnauthorized {
		t.Errorf("a signature for another event = %d", code)
	}
	old := strconv.FormatInt(time.Now().Add(-5*time.Minute).Unix(), 10)
	if code := signed("0123456789abcdef-b", old, "SessionStart"); code != http.StatusUnauthorized {
		t.Errorf("an old call = %d", code)
	}
	if code := signed("0123456789abcdef-c", sent, "SessionStart"); code != http.StatusOK {
		t.Errorf("a fresh call = %d", code)
	}
	if code := signed("0123456789abcdef-c", sent, "SessionStart"); code != http.StatusUnauthorized {
		t.Errorf("a replayed call = %d", code)
	}
	response := o.hook(t, token, "SessionStart", body)
	if response.Code != http.StatusOK {
		t.Fatalf("hook = %d", response.Code)
	}
	if response.Header().Get(claudecode.SignatureHeader) == "" {
		t.Error("the reply is not signed")
	}
	snapshot := decode[models.Snapshot](t, o.do(t, http.MethodGet, "/api/snapshot", ""))
	if len(snapshot.Agents) != 1 || snapshot.Agents[0].Source != claudecode.Source {
		t.Errorf("agents = %+v", snapshot.Agents)
	}
}

func TestWipeDetachesClaudeCode(t *testing.T) {
	o := newClaudeOffice(t)
	o.do(t, http.MethodPost, "/api/accounts/claude/connect", `{"confirm":true}`)
	o.do(t, http.MethodPost, "/api/wipe", `{"confirm":true}`)
	if claudecode.Attached(o.dir) {
		t.Error("a wipe left the hooks in settings.json")
	}
	settings, _ := os.ReadFile(filepath.Join(o.dir, "settings.json"))
	if !strings.Contains(string(settings), "claude-opus-4-1") {
		t.Errorf("the user's settings were lost: %s", settings)
	}
}

func TestConnectNeedsABuiltBinary(t *testing.T) {
	o := newClaudeOffice(t)
	handler := New(Options{Engine: o.engine, Simulator: o.simulator, Claude: &ClaudeOptions{
		Connector: claudecode.New(o.engine), Secrets: o.vault, ConfigDir: o.dir,
	}})
	request := httptest.NewRequest(http.MethodPost, "http://localhost:4317/api/accounts/claude/connect",
		strings.NewReader(`{"confirm":true}`))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusConflict || claudecode.Attached(o.dir) {
		t.Errorf("connect without a binary = %d", recorder.Code)
	}
}

// Making Mabari the default agent shows the change first, needs a confirming click, keeps a
// backup, leaves every other setting alone, and is undone just as cleanly.
func TestMakingMabariTheDefaultAgent(t *testing.T) {
	o := newClaudeOffice(t)
	plan := decode[defaultAgentStatus](t, o.do(t, http.MethodGet, "/api/accounts/claude/default-agent", ""))
	if plan.On || len(plan.Diff) == 0 {
		t.Fatalf("plan = %+v", plan)
	}
	if response := o.do(t, http.MethodPost, "/api/accounts/claude/default-agent", `{"on":true}`); response.Code != http.StatusBadRequest {
		t.Errorf("unconfirmed = %d", response.Code)
	}
	if response := o.do(t, http.MethodPost, "/api/accounts/claude/default-agent", `{"on":true,"confirm":true}`); response.Code != http.StatusOK {
		t.Fatalf("on = %d %s", response.Code, response.Body)
	}
	if got := claudecode.DefaultAgent(o.dir); got != "mabari" {
		t.Errorf("default agent = %q", got)
	}
	settings, _ := os.ReadFile(filepath.Join(o.dir, "settings.json"))
	if !strings.Contains(string(settings), `"model": "claude-opus-4-1"`) {
		t.Errorf("other settings changed: %s", settings)
	}
	if _, err := os.Stat(filepath.Join(o.dir, "settings.json"+claudecode.BackupSuffix)); err != nil {
		t.Errorf("no backup: %v", err)
	}
	if response := o.do(t, http.MethodPost, "/api/accounts/claude/default-agent", `{"on":false,"confirm":true}`); response.Code != http.StatusOK {
		t.Fatalf("off = %d", response.Code)
	}
	if got := claudecode.DefaultAgent(o.dir); got != "" {
		t.Errorf("still the default: %q", got)
	}
}

// Turning Mabari off never removes an agent someone else chose as the default.
func TestAnotherDefaultAgentIsLeftAlone(t *testing.T) {
	o := newClaudeOffice(t)
	if err := os.WriteFile(filepath.Join(o.dir, "settings.json"), []byte(`{"agent": "reviewer"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	plan := decode[defaultAgentStatus](t, o.do(t, http.MethodGet, "/api/accounts/claude/default-agent", ""))
	if plan.On || plan.Other != "reviewer" {
		t.Errorf("plan = %+v", plan)
	}
	_ = o.do(t, http.MethodPost, "/api/accounts/claude/default-agent", `{"on":false,"confirm":true}`)
	if got := claudecode.DefaultAgent(o.dir); got != "reviewer" {
		t.Errorf("default agent = %q", got)
	}
}
