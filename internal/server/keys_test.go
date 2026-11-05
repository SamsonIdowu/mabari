// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/connectors/hub"
	"github.com/SamsonIdowu/mabari/internal/connectors/simulator"
	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/secrets"
	"github.com/SamsonIdowu/mabari/internal/store"
)

func newKeyOffice(t *testing.T) (*office, *secrets.Memory) {
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
	connector := hub.New(engine)
	engine.AddConnector(hub.Source, connector)
	vault := secrets.NewMemory()
	sim := simulator.New(engine, simulator.Mulberry32(7), 0)
	handler := New(Options{Engine: engine, Simulator: sim, Secrets: vault, Hub: connector})
	return &office{handler: handler, engine: engine, simulator: sim}, vault
}

func accountStatus(t *testing.T, o *office, kind models.AccountKind) models.AccountStatus {
	t.Helper()
	for _, account := range decode[[]models.Account](t, o.do(t, http.MethodGet, "/api/accounts", "")) {
		if account.Kind == kind {
			return account.Status
		}
	}
	return ""
}

// A key that doesn't fit is refused with the shape it should have, so the page can say it beside
// the field instead of leaving a guess.
func TestAKeyThatDoesNotFitSaysWhatShapeToPaste(t *testing.T) {
	o, vault := newKeyOffice(t)
	for kind, want := range map[string]string{
		"anthropic_key": "an Anthropic API key. It starts with sk-ant- and has at least 20 more",
		"openai_key":    "an OpenAI API key. It starts with sk- and has at least 20 more",
	} {
		response := o.do(t, http.MethodPut, "/api/accounts/"+kind+"/key", `{"key":"hello"}`)
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), want) {
			t.Errorf("%s = %d %s, want it to say %q", kind, response.Code, response.Body, want)
		}
		if _, err := vault.Get(kind); err == nil {
			t.Errorf("a key that doesn't fit was stored for %s", kind)
		}
	}
}

func TestKeysAreStoredButNeverShown(t *testing.T) {
	o, vault := newKeyOffice(t)
	key := "sk-ant-api03-" + strings.Repeat("a", 40)
	for _, bad := range []string{`{"key":"hello"}`, `{"key":"sk-ant-short"}`, `{"key":"sk-ant-` + strings.Repeat("a", 30) + ` x"}`} {
		if response := o.do(t, http.MethodPut, "/api/accounts/anthropic_key/key", bad); response.Code != http.StatusBadRequest {
			t.Errorf("%s = %d", bad, response.Code)
		}
	}
	response := o.do(t, http.MethodPut, "/api/accounts/anthropic_key/key", `{"key":"`+key+`"}`)
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), key) {
		t.Fatalf("save = %d %s", response.Code, response.Body)
	}
	if got, _ := vault.Get("anthropic_key"); got != key {
		t.Error("not in the secret store")
	}
	if accountStatus(t, o, models.AccountAnthropicKey) != models.AccountConnected {
		t.Error("not connected")
	}
	snapshot := o.do(t, http.MethodGet, "/api/snapshot", "").Body.String()
	if strings.Contains(snapshot, key) || strings.Contains(snapshot, "api03") {
		t.Error("the key reached the snapshot")
	}
	if response := o.do(t, http.MethodPut, "/api/accounts/hub/key", `{"key":"x"}`); response.Code != http.StatusNotFound {
		t.Errorf("unknown kind = %d", response.Code)
	}
	o.do(t, http.MethodDelete, "/api/accounts/anthropic_key/key", "")
	if _, err := vault.Get("anthropic_key"); err == nil || accountStatus(t, o, models.AccountAnthropicKey) != models.AccountOff {
		t.Error("the key was kept")
	}
}

func hubCall(t *testing.T, o *office, token, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, "http://127.0.0.1:4317"+path, strings.NewReader(body))
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	o.handler.ServeHTTP(recorder, request)
	return recorder
}

func TestHubAgentsReportAndCollectInstructions(t *testing.T) {
	o, _ := newKeyOffice(t)
	token := decode[map[string]string](t, o.do(t, http.MethodPost, "/api/accounts/hub/token", ""))["token"]
	if !strings.HasPrefix(token, "mab_") {
		t.Fatalf("token = %q", token)
	}
	event := `{"agent":"price-bot","name":"Scraper","model":"gpt-4o","state":"running","task":"Check prices","tool":"fetch","summary":"GET shop"}`
	if response := hubCall(t, o, "", http.MethodPost, "/hub/v1/events", event); response.Code != http.StatusUnauthorized {
		t.Errorf("no token = %d", response.Code)
	}
	if response := hubCall(t, o, "mab_wrong", http.MethodPost, "/hub/v1/events", event); response.Code != http.StatusUnauthorized {
		t.Errorf("wrong token = %d", response.Code)
	}
	if response := hubCall(t, o, token, http.MethodPost, "/hub/v1/events", `{"agent":"../x","state":"running"}`); response.Code != http.StatusBadRequest {
		t.Errorf("bad id = %d", response.Code)
	}
	if response := hubCall(t, o, token, http.MethodPost, "/hub/v1/events", event); response.Code != http.StatusOK {
		t.Fatalf("event = %d %s", response.Code, response.Body)
	}
	snapshot := decode[models.Snapshot](t, o.do(t, http.MethodGet, "/api/snapshot", ""))
	if len(snapshot.Agents) != 1 || snapshot.Agents[0].Provider != models.ProviderCustom ||
		snapshot.Agents[0].State != models.StateRunning || snapshot.Agents[0].Name != "Scraper" {
		t.Fatalf("agents = %+v", snapshot.Agents)
	}
	o.do(t, http.MethodPost, "/api/messages",
		`{"text":"Also check shipping","mode":"instruct","target":"hub-price-bot","projectId":"","teamId":""}`)
	got := decode[map[string][]string](t, hubCall(t, o, token, http.MethodGet, "/hub/v1/agents/price-bot/instructions", ""))
	if len(got["instructions"]) != 1 || got["instructions"][0] != "Also check shipping" {
		t.Errorf("instructions = %v", got)
	}
	o.do(t, http.MethodDelete, "/api/accounts/hub/token", "")
	if response := hubCall(t, o, token, http.MethodPost, "/hub/v1/events", event); response.Code != http.StatusUnauthorized {
		t.Errorf("revoked token = %d", response.Code)
	}
}

func TestWipeRemovesKeysAndTokens(t *testing.T) {
	o, vault := newKeyOffice(t)
	o.do(t, http.MethodPut, "/api/accounts/openai_key/key", `{"key":"sk-proj-`+strings.Repeat("b", 40)+`"}`)
	o.do(t, http.MethodPost, "/api/accounts/hub/token", "")
	o.do(t, http.MethodPost, "/api/wipe", `{"confirm":true}`)
	if names := vault.Names(); len(names) != 0 {
		t.Errorf("left after a wipe: %v", names)
	}
}

type fakeAnswerer struct{ text, model, facts string }

func (f *fakeAnswerer) Answer(_ context.Context, model, _, facts string) (string, error) {
	f.model, f.facts = model, facts
	return f.text, nil
}

func TestQueriesUseTheClaudeQueryModelWhenAKeyIsSaved(t *testing.T) {
	o, vault := newKeyOffice(t)
	fake := &fakeAnswerer{text: "Ledger is refactoring the totals. It should finish soon."}
	o.handler = New(Options{
		Engine: o.engine, Simulator: o.simulator, Secrets: vault,
		Answerer: func(string) QueryAnswerer { return fake },
	})
	o.demo(t)
	query := `{"text":"What is Ledger doing?","mode":"query","target":"auto","projectId":"","teamId":""}`
	before := decode[messageResult](t, o.do(t, http.MethodPost, "/api/messages", query))
	if before.Answer == nil || before.Answer.Text != "" {
		t.Fatalf("without a key the log answers: %+v", before.Answer)
	}
	o.do(t, http.MethodPut, "/api/accounts/anthropic_key/key", `{"key":"sk-ant-api03-`+strings.Repeat("a", 40)+`"}`)
	o.do(t, http.MethodPatch, "/api/settings", `{"queryModel":"claude-opus-5-5"}`)
	after := decode[messageResult](t, o.do(t, http.MethodPost, "/api/messages", query))
	if after.Answer == nil || after.Answer.Text != fake.text || after.Answer.AnsweredBy != "claude-opus-5-5" ||
		!strings.Contains(fake.facts, "Ledger") {
		t.Errorf("answer = %+v, facts = %q", after.Answer, fake.facts)
	}
}
