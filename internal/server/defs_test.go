// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/agentdefs"
	"github.com/SamsonIdowu/mabari/internal/connectors/simulator"
	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

// officeWithDefs is an office whose agent folders live under home, and whose database is a file,
// so a test can stop it and start another on the same data, as a restart does.
func officeWithDefs(t *testing.T, home, database string) *office {
	t.Helper()
	ctx := context.Background()
	s, err := store.Open(ctx, database)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	engine, err := events.New(ctx, s, nil)
	if err != nil {
		t.Fatal(err)
	}
	library := agentdefs.New(agentdefs.Folders{
		Account: filepath.Join(home, ".claude", "agents"),
		State:   filepath.Join(home, ".mabari", "agents-state.json"),
		Home:    home,
	})
	if _, err := library.Refresh(engine); err != nil {
		t.Fatal(err)
	}
	sim := simulator.New(engine, simulator.Mulberry32(7), 0)
	return &office{
		handler:   New(Options{Version: "1.2.3", Engine: engine, Simulator: sim, Defs: library}),
		engine:    engine,
		simulator: sim,
	}
}

const reviewerBody = `{"def":{"name":"code-reviewer","description":"Use after any change to review it.",
	"scope":"account","model":"sonnet","tools":["Read","Grep"],"instructions":"Review it.","color":"#4FB3FF"}}`

func defNamed(t *testing.T, o *office, name string) (models.AgentDef, bool) {
	t.Helper()
	for _, def := range o.engine.Snapshot().Defs {
		if def.Name == name {
			return def, true
		}
	}
	return models.AgentDef{}, false
}

// An agent file is the source of truth: it outlives a switch of account and a restart.
func TestAnAgentFileSurvivesAnAccountSwitchAndARestart(t *testing.T) {
	home := t.TempDir()
	database := filepath.Join(t.TempDir(), "mabari.db")
	first := officeWithDefs(t, home, database)
	if response := first.do(t, http.MethodPost, "/api/defs", reviewerBody); response.Code != http.StatusOK {
		t.Fatalf("save = %d %s", response.Code, response.Body)
	}
	saved, ok := defNamed(t, first, "code-reviewer")
	if !ok || saved.Path != "~/.claude/agents/code-reviewer.md" {
		t.Fatalf("saved = %+v", saved)
	}
	// Switching accounts: connect one, then disconnect it and connect another.
	_ = first.engine.Do(func() {
		first.engine.SetAccount(models.Account{ID: "claude_code", Kind: models.AccountClaudeCode, Status: models.AccountConnected})
		first.engine.SetAccount(models.Account{ID: "claude_code", Kind: models.AccountClaudeCode, Status: models.AccountOff})
		first.engine.SetAccount(models.Account{ID: "codex", Kind: models.AccountCodex, Status: models.AccountConnected})
	})
	if _, ok := defNamed(t, first, "code-reviewer"); !ok {
		t.Fatal("lost after an account switch")
	}
	// A wipe clears Mabari's own data, never the agent files.
	if response := first.do(t, http.MethodPost, "/api/wipe", `{"confirm":true}`); response.Code != http.StatusOK {
		t.Fatalf("wipe = %d", response.Code)
	}
	restarted := officeWithDefs(t, home, database)
	got, ok := defNamed(t, restarted, "code-reviewer")
	if !ok || got.ID != saved.ID || got.Model != "sonnet" {
		t.Fatalf("after a restart: %+v", got)
	}
	if mabari, ok := defNamed(t, restarted, "mabari"); !ok || !mabari.System {
		t.Errorf("mabari = %+v", mabari)
	}
}

func TestBuilderRoutes(t *testing.T) {
	o := officeWithDefs(t, t.TempDir(), ":memory:")
	if response := o.do(t, http.MethodPost, "/api/defs", strings.Replace(reviewerBody, "code-reviewer", "Bad Name", 1)); response.Code != http.StatusBadRequest ||
		!strings.Contains(response.Body.String(), "lowercase") {
		t.Errorf("bad name = %d %s", response.Code, response.Body)
	}
	o.do(t, http.MethodPost, "/api/defs", reviewerBody)
	def, _ := defNamed(t, o, "code-reviewer")
	if response := o.do(t, http.MethodPost, "/api/defs/"+def.ID+"/enabled", `{"on":false}`); response.Code != http.StatusOK {
		t.Fatalf("off = %d", response.Code)
	}
	if def, _ = defNamed(t, o, "code-reviewer"); def.Enabled {
		t.Error("still on")
	}
	if response := o.do(t, http.MethodPost, "/api/defs/"+def.ID+"/run", ""); response.Code != http.StatusBadRequest {
		t.Errorf("ran while off: %d", response.Code)
	}
	o.do(t, http.MethodPost, "/api/defs/"+def.ID+"/enabled", `{"on":true}`)
	o.demo(t)
	response := o.do(t, http.MethodPost, "/api/defs/"+def.ID+"/run", "")
	if response.Code != http.StatusCreated {
		t.Fatalf("run = %d %s", response.Code, response.Body)
	}
	agent := decode[models.LiveAgent](t, response)
	if agent.DefID != def.ID || agent.Name != "code-reviewer" {
		t.Errorf("agent = %+v", agent.Agent)
	}
	if def, _ = defNamed(t, o, "code-reviewer"); def.Runs != 1 {
		t.Errorf("runs = %d", def.Runs)
	}
	report := decode[agentdefs.Report](t, o.do(t, http.MethodPost, "/api/defs/rescan", ""))
	if report.Account != 2 {
		t.Errorf("report = %+v", report)
	}
	mabari, _ := defNamed(t, o, "mabari")
	if response := o.do(t, http.MethodDelete, "/api/defs/"+mabari.ID, ""); response.Code != http.StatusBadRequest {
		t.Errorf("deleted Mabari: %d", response.Code)
	}
	if response := o.do(t, http.MethodDelete, "/api/defs/"+def.ID, ""); response.Code != http.StatusOK {
		t.Errorf("delete = %d", response.Code)
	}
	if _, ok := defNamed(t, o, "code-reviewer"); ok {
		t.Error("still listed")
	}
}

// Mabari counts every request it routes.
func TestMabariCountsWhatItDispatches(t *testing.T) {
	o := officeWithDefs(t, t.TempDir(), ":memory:")
	o.demo(t)
	askVee(t, o, `{"text":"the invoice rounding is wrong"}`)
	if mabari, _ := defNamed(t, o, "mabari"); mabari.Runs != 1 {
		t.Errorf("runs = %d", mabari.Runs)
	}
}

func TestInterruptAndContinue(t *testing.T) {
	o := newOffice(t)
	o.demo(t)
	ledger := agentNamed(t, o, "Ledger")
	before := ledger.State
	if response := o.do(t, http.MethodPost, "/api/agents/"+ledger.ID+"/interrupt", ""); response.Code != http.StatusOK {
		t.Fatalf("interrupt = %d", response.Code)
	}
	if got := agentNamed(t, o, "Ledger"); got.State != models.StatePaused || got.PausedFrom != before {
		t.Fatalf("paused = %v from %v", got.State, got.PausedFrom)
	}
	if response := o.do(t, http.MethodPost, "/api/agents/"+ledger.ID+"/continue", ""); response.Code != http.StatusOK {
		t.Fatalf("continue = %d", response.Code)
	}
	got := agentNamed(t, o, "Ledger")
	if got.State != before || got.Feed[0].Summary != "Continued by you from where it stopped" {
		t.Errorf("after continue: %v, %q", got.State, got.Feed[0].Summary)
	}
	rows := decode[[]models.LogEntry](t, o.do(t, http.MethodGet, "/api/activity?q=Continue", ""))
	if len(rows) == 0 || rows[0].Outcome != "Continued by you" {
		t.Errorf("log = %+v", rows)
	}
}
