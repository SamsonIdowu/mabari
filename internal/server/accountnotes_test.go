// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/connectors/codex"
	"github.com/SamsonIdowu/mabari/internal/connectors/simulator"
	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

func accountOf(snapshot models.Snapshot, kind models.AccountKind) models.Account {
	for _, account := range snapshot.Accounts {
		if account.Kind == kind {
			return account
		}
	}
	return models.Account{}
}

func (o *office) connect(kinds ...models.AccountKind) {
	_ = o.engine.Do(func() {
		for _, account := range o.engine.StoredAccounts() {
			for _, kind := range kinds {
				if account.Kind == kind {
					account.Status = models.AccountConnected
					o.engine.SetAccount(account)
				}
			}
		}
	})
}

// Outside the demo only a signed in Codex can start an agent. Claude Code starts in the terminal,
// an API key can't run one yet, and each says what to do instead, so the New agent dialog never
// offers a form that can't succeed.
func TestOnlyCodexCanStartAnAgentOutsideTheDemo(t *testing.T) {
	office := newOffice(t)
	office.connect(models.AccountClaudeCode, models.AccountAnthropicKey, models.AccountOpenAIKey)
	snapshot := decode[models.Snapshot](t, office.do(t, http.MethodGet, "/api/snapshot", ""))
	for kind, want := range map[models.AccountKind]string{
		models.AccountClaudeCode:   "run claude",
		models.AccountAnthropicKey: "aren't ready yet",
		models.AccountOpenAIKey:    "aren't ready yet",
	} {
		account := accountOf(snapshot, kind)
		if account.CanStart || !strings.Contains(account.StartNote, want) {
			t.Errorf("%s: canStart %v, note %q, want a note with %q", kind, account.CanStart, account.StartNote, want)
		}
	}
	// What the dialog is told is what the server does when the form is sent.
	response := office.do(t, http.MethodPost, "/api/agents", `{"name":"Tess","account":"claude_code","model":"x",`+
		`"task":"Help","projectId":"","folder":"~/code/x","dailyCostCap":0,"allowedTools":[]}`)
	if response.Code != http.StatusConflict ||
		!strings.Contains(response.Body.String(), accountOf(snapshot, models.AccountClaudeCode).StartNote) {
		t.Errorf("starting on Claude Code = %d %s", response.Code, response.Body)
	}
}

func TestSignedInCodexCanStartAnAgentUnlessItsCLIIsMissing(t *testing.T) {
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
	connector := codex.New(engine, "test")
	sim := simulator.New(engine, simulator.Mulberry32(7), 0)
	office := &office{
		handler:   New(Options{Engine: engine, Simulator: sim, Codex: connector}),
		engine:    engine,
		simulator: sim,
	}
	snapshot := decode[models.Snapshot](t, office.do(t, http.MethodGet, "/api/snapshot", ""))
	if account := accountOf(snapshot, models.AccountCodex); account.CanStart ||
		!strings.Contains(account.StartNote, "Sign in with ChatGPT") {
		t.Errorf("signed out: canStart %v, note %q", account.CanStart, account.StartNote)
	}
	office.connect(models.AccountCodex)
	snapshot = decode[models.Snapshot](t, office.do(t, http.MethodGet, "/api/snapshot", ""))
	if account := accountOf(snapshot, models.AccountCodex); !account.CanStart || account.StartNote != "" || account.Missing != "" {
		t.Errorf("signed in: %+v", account)
	}

	// No codex command on this computer: the account says so, and no form is offered.
	t.Setenv("PATH", t.TempDir())
	if err := connector.Launch(ctx); err == nil {
		t.Fatal("Launch found a codex command on an empty PATH")
	}
	snapshot = decode[models.Snapshot](t, office.do(t, http.MethodGet, "/api/snapshot", ""))
	account := accountOf(snapshot, models.AccountCodex)
	if account.CanStart || account.Missing != "codex" || !strings.Contains(account.StartNote, "isn't installed") {
		t.Errorf("CLI missing: canStart %v, missing %q, note %q", account.CanStart, account.Missing, account.StartNote)
	}
}

// The demo's accounts are pretend and say so. Nothing of that is stored, so it is gone with the demo.
func TestDemoAccountsAreMarkedAndNeverStored(t *testing.T) {
	office := newOffice(t)
	snapshot := office.demo(t)
	for _, kind := range []models.AccountKind{models.AccountCodex, models.AccountClaudeCode} {
		account := accountOf(snapshot, kind)
		if !account.Demo || account.Status != models.AccountConnected || !account.CanStart {
			t.Errorf("%s in the demo: %+v", kind, account)
		}
	}
	for _, kind := range []models.AccountKind{models.AccountAnthropicKey, models.AccountOpenAIKey, models.AccountHub} {
		if account := accountOf(snapshot, kind); account.Demo || account.CanStart {
			t.Errorf("%s in the demo: %+v", kind, account)
		}
	}
	// What the office works out about an account is dropped when the account is stored.
	_ = office.engine.Do(func() {
		for _, account := range office.engine.StoredAccounts() {
			account.Demo, account.CanStart, account.StartNote, account.Missing = true, true, "x", "y"
			office.engine.SetAccount(account)
		}
		for _, account := range office.engine.StoredAccounts() {
			if account.Demo || account.CanStart || account.StartNote != "" || account.Missing != "" {
				t.Errorf("%s was stored with %+v", account.Kind, account)
			}
		}
	})
	if response := office.do(t, http.MethodPost, "/api/demo/stop", ""); response.Code != http.StatusOK {
		t.Fatalf("stop = %d", response.Code)
	}
	after := decode[models.Snapshot](t, office.do(t, http.MethodGet, "/api/snapshot", ""))
	for _, account := range after.Accounts {
		if account.Demo || account.Status == models.AccountConnected {
			t.Errorf("%s after the demo: %+v", account.Kind, account)
		}
	}
}

// A model setting no account offers is corrected on the server, in the reply and in the log, so a
// select never shows one model while another is used.
func TestAModelNoAccountOffersIsCorrectedAndSaid(t *testing.T) {
	office := newOffice(t)
	patch := `{"defaults":{"claude":"claude-haiku-4-5","codex":"gpt-5-codex","anthropic":"claude-sonnet-4-5","openai":"gpt-5"},` +
		`"queryModel":"claude-opus-4-1"}`
	response := office.do(t, http.MethodPatch, "/api/settings", patch)
	if response.Code != http.StatusOK {
		t.Fatalf("patch = %d %s", response.Code, response.Body)
	}
	got := decode[models.Settings](t, response)
	if got.Defaults["anthropic"] != "claude-sonnet-5-5" || got.Defaults["claude"] != "claude-haiku-4-5" ||
		got.QueryModel != "claude-opus-4-1" {
		t.Errorf("settings = %+v", got)
	}
	if stored := decode[models.Settings](t, office.do(t, http.MethodGet, "/api/settings", "")); stored.Defaults["anthropic"] != "claude-sonnet-5-5" {
		t.Errorf("stored = %+v", stored.Defaults)
	}
	var said bool
	for _, entry := range decode[models.Snapshot](t, office.do(t, http.MethodGet, "/api/snapshot", "")).Log {
		if strings.Contains(entry.Message+entry.Outcome, "Anthropic API key default was claude-sonnet-4-5") {
			said = true
		}
	}
	if !said {
		t.Error("the correction is not in the Activity log")
	}
}

// The engine corrects what an earlier version stored, when Mabari starts.
func TestStoredModelsAreCorrectedAtStart(t *testing.T) {
	office := newOffice(t)
	_ = office.engine.Do(func() {
		stale := office.engine.Settings()
		stale.Defaults["anthropic"] = "claude-sonnet-4-5"
		office.engine.SaveSettings(stale)
		office.engine.CorrectModels()
		if got := office.engine.Settings().Defaults["anthropic"]; got != "claude-sonnet-5-5" {
			t.Errorf("anthropic default = %q", got)
		}
	})
}
