// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/SamsonIdowu/mabari/internal/connectors/simulator"
	"github.com/SamsonIdowu/mabari/internal/dispatch"
	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
	"github.com/coder/websocket"
)

type office struct {
	handler   http.Handler
	engine    *events.Engine
	simulator *simulator.Simulator
}

func newOffice(t *testing.T) *office {
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
	sim := simulator.New(engine, simulator.Mulberry32(7), 0)
	return &office{
		handler:   New(Options{Version: "1.2.3", Engine: engine, Simulator: sim}),
		engine:    engine,
		simulator: sim,
	}
}

func (o *office) do(t *testing.T, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, "http://localhost:4317"+path, strings.NewReader(body))
	// What Mabari's own page sends, which a few routes insist on.
	request.Header.Set("Origin", "http://localhost:4317")
	recorder := httptest.NewRecorder()
	o.handler.ServeHTTP(recorder, request)
	return recorder
}

func decode[T any](t *testing.T, response *httptest.ResponseRecorder) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
		t.Fatalf("decode %q: %v", response.Body.String(), err)
	}
	return value
}

func (o *office) demo(t *testing.T) models.Snapshot {
	t.Helper()
	if response := o.do(t, http.MethodPost, "/api/demo/load", ""); response.Code != http.StatusOK {
		t.Fatalf("demo load = %d", response.Code)
	}
	return decode[models.Snapshot](t, o.do(t, http.MethodGet, "/api/snapshot", ""))
}

func TestHealth(t *testing.T) {
	response := newOffice(t).do(t, http.MethodGet, "/api/health", "")
	body := decode[map[string]any](t, response)
	if response.Code != http.StatusOK || body["ok"] != true || body["version"] != "1.2.3" {
		t.Errorf("status = %d, body = %v", response.Code, body)
	}
}

func TestUnknownAPIRouteIsJSON404(t *testing.T) {
	response := newOffice(t).do(t, http.MethodGet, "/api/nope", "")
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d", response.Code)
	}
	if got := response.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q", got)
	}
}

func TestServesTheWebAppWhenEmbedded(t *testing.T) {
	office := newOffice(t)
	office.handler = New(Options{
		Engine:   office.engine,
		WebFiles: fstest.MapFS{"index.html": {Data: []byte("<title>Mabari</title>")}},
	})
	response := office.do(t, http.MethodGet, "/", "")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "Mabari") {
		t.Errorf("status = %d, body = %q", response.Code, response.Body.String())
	}
}

func TestLocalOnlyChecks(t *testing.T) {
	cases := []struct {
		name   string
		host   string
		origin string
		want   int
	}{
		{"localhost", "localhost:4317", "", http.StatusOK},
		{"loopback address", "127.0.0.1:4317", "http://127.0.0.1:4317", http.StatusOK},
		{"loopback IPv6", "[::1]:4317", "http://[::1]:4317", http.StatusOK},
		{"our dev page", "localhost:4317", "http://localhost:4317", http.StatusOK},
		{"DNS rebinding", "evil.example:4317", "", http.StatusForbidden},
		{"lookalike host", "localhost.evil.example", "", http.StatusForbidden},
		{"another website", "localhost:4317", "https://evil.example", http.StatusForbidden},
		{"lookalike origin", "localhost:4317", "http://localhost.evil.example", http.StatusForbidden},
		{"sandboxed frame", "localhost:4317", "null", http.StatusForbidden},
		{"file page", "localhost:4317", "file://", http.StatusForbidden},
		{"another local port", "localhost:4317", "http://localhost:3000", http.StatusForbidden},
		{"another local name", "localhost:4317", "http://127.0.0.1:4317", http.StatusForbidden},
		{"published on another port", "localhost:8080", "http://localhost:8080", http.StatusOK},
	}
	handler := newOffice(t).handler
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/health", nil)
			request.Host = tc.host
			if tc.origin != "" {
				request.Header.Set("Origin", tc.origin)
			}
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			if recorder.Code != tc.want {
				t.Errorf("status = %d, want %d", recorder.Code, tc.want)
			}
		})
	}
}

// A page on another local port must not reach a writing route, even with a simple request that
// needs no preflight.
func TestOtherLocalPortCannotWipe(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	request := httptest.NewRequest(http.MethodPost, "/api/wipe", strings.NewReader(`{"confirm":true}`))
	request.Host = "localhost:4317"
	request.Header.Set("Origin", "http://localhost:3000")
	request.Header.Set("Content-Type", "text/plain")
	recorder := httptest.NewRecorder()
	office.handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", recorder.Code)
	}
	if got := decode[models.Snapshot](t, office.do(t, http.MethodGet, "/api/snapshot", "")); len(got.Agents) == 0 {
		t.Error("the office was wiped")
	}
}

func TestFirstRunUntilTheDemoLoads(t *testing.T) {
	office := newOffice(t)
	empty := decode[models.Snapshot](t, office.do(t, http.MethodGet, "/api/snapshot", ""))
	if !empty.FirstRun || len(empty.Agents) != 0 || len(empty.Accounts) != 5 {
		t.Errorf("empty snapshot = %+v", empty)
	}
	demo := office.demo(t)
	if demo.FirstRun || len(demo.Agents) != 10 || len(demo.Projects) != 4 {
		t.Errorf("demo: firstRun %v, %d agents, %d projects",
			demo.FirstRun, len(demo.Agents), len(demo.Projects))
	}
}

func TestSnapshotCarriesEstimatesFromTheServer(t *testing.T) {
	demo := newOffice(t).demo(t)
	for _, agent := range demo.Agents {
		if agent.State.Active() != (agent.Estimate != nil) {
			t.Errorf("%s (%s): estimate = %+v", agent.Name, agent.State, agent.Estimate)
		}
		if agent.Bubble == "" {
			t.Errorf("%s has no speech bubble", agent.Name)
		}
	}
	for _, project := range demo.Projects {
		if project.ID == "checkout" && (project.Estimate == nil || project.Status != models.ProjectNeeds) {
			t.Errorf("checkout = %+v", project)
		}
		if project.ID == "landing" && (project.Status != models.ProjectCompleted || project.Estimate != nil) {
			t.Errorf("landing = %+v", project)
		}
	}
}

func TestProjectRoutes(t *testing.T) {
	office := newOffice(t)
	created := office.do(t, http.MethodPost, "/api/projects", `{"name":" Docs ","color":"#48DBFB"}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create = %d: %s", created.Code, created.Body.String())
	}
	project := decode[models.Project](t, created)
	if project.Name != "Docs" || project.Status != models.ProjectNew {
		t.Errorf("project = %+v", project)
	}

	path := "/api/projects/" + project.ID
	updated := decode[models.Project](t, office.do(t, http.MethodPatch, path, `{"instructions":"Be kind"}`))
	if updated.Instructions != "Be kind" || updated.Name != "Docs" {
		t.Errorf("updated = %+v", updated)
	}
	// A fresh install has no projects: only the ones people make.
	if listed := decode[[]models.Project](t, office.do(t, http.MethodGet, "/api/projects", "")); len(listed) != 1 ||
		listed[0].Name != "Docs" {
		t.Errorf("listed = %+v", listed)
	}
	if response := office.do(t, http.MethodDelete, path, ""); response.Code != http.StatusNoContent {
		t.Errorf("delete = %d", response.Code)
	}
	if response := office.do(t, http.MethodDelete, path, ""); response.Code != http.StatusNotFound {
		t.Errorf("second delete = %d", response.Code)
	}
}

func TestCompleteAndReopenProject(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	if response := office.do(t, http.MethodPost, "/api/projects/checkout/complete", ""); response.Code != http.StatusConflict {
		t.Errorf("busy project = %d", response.Code)
	}
	if response := office.do(t, http.MethodPost, "/api/projects/nope/complete", ""); response.Code != http.StatusNotFound {
		t.Errorf("missing project = %d", response.Code)
	}
	reopened := decode[models.Project](t, office.do(t, http.MethodPost, "/api/projects/landing/reopen", ""))
	if reopened.Done != nil || reopened.Status != models.ProjectNew {
		t.Errorf("reopened = %+v", reopened)
	}
	created := decode[models.Project](t, office.do(t, http.MethodPost, "/api/projects", `{"name":"Idle","color":"#fff"}`))
	err := office.engine.Do(func() {
		pixel := office.engine.AgentByName("Pixel")
		pixel.Project = &created.ID
		office.engine.Touch(pixel)
	})
	if err != nil {
		t.Fatal(err)
	}
	completed := decode[models.Project](t, office.do(t, http.MethodPost, "/api/projects/"+created.ID+"/complete", ""))
	if completed.Done == nil || completed.Done.Agents != 1 || completed.Status != models.ProjectCompleted {
		t.Errorf("completed = %+v", completed)
	}
	rows := decode[[]models.LogEntry](t, office.do(t, http.MethodGet, "/api/activity?q=Marked", ""))
	if len(rows) != 1 || rows[0].Agent != "You" {
		t.Errorf("rows = %+v", rows)
	}
}

func TestProjectValidation(t *testing.T) {
	office := newOffice(t)
	for _, body := range []string{
		`{"name":"","color":"#fff"}`,
		`{"name":"   ","color":"#fff"}`,
		`{"name":"` + strings.Repeat("x", 29) + `","color":"#fff"}`,
		`{"name":"No colour"}`,
		`{"name":"Extra","color":"#fff","admin":true}`,
		`not json`,
		``,
	} {
		if response := office.do(t, http.MethodPost, "/api/projects", body); response.Code != http.StatusBadRequest {
			t.Errorf("%q = %d", body, response.Code)
		}
	}
}

func TestRequestBodiesAreLimited(t *testing.T) {
	big := `{"name":"` + strings.Repeat("x", maxBodyBytes) + `","color":"#fff"}`
	response := newOffice(t).do(t, http.MethodPost, "/api/projects", big)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d", response.Code)
	}
}

func TestAgentRoutes(t *testing.T) {
	office := newOffice(t)
	demo := office.demo(t)
	id := demo.Agents[0].ID
	path := "/api/agents/" + id

	if agents := decode[[]models.LiveAgent](t, office.do(t, http.MethodGet, "/api/agents", "")); len(agents) != 10 {
		t.Errorf("listed %d", len(agents))
	}
	if agent := decode[models.LiveAgent](t, office.do(t, http.MethodGet, path, "")); agent.ID != id {
		t.Errorf("agent = %+v", agent)
	}
	if response := office.do(t, http.MethodGet, "/api/agents/nope", ""); response.Code != http.StatusNotFound {
		t.Errorf("missing agent = %d", response.Code)
	}

	updated := decode[models.Agent](t, office.do(t, http.MethodPatch, path,
		`{"model":"gpt-5","dailyCostCap":5,"allowedTools":["read"],"projectId":"docs"}`))
	if updated.Model != "gpt-5" || *updated.DailyCostCap != 5 || *updated.Project != "docs" ||
		updated.AllowedTools[0] != "read" {
		t.Errorf("updated = %+v", updated)
	}
	if response := office.do(t, http.MethodPatch, path, `{"projectId":"nope"}`); response.Code != http.StatusBadRequest {
		t.Errorf("bad project = %d", response.Code)
	}
	if response := office.do(t, http.MethodPatch, path, `{"dailyCostCap":-1}`); response.Code != http.StatusBadRequest {
		t.Errorf("negative cap = %d", response.Code)
	}

	events := decode[[]models.Event](t, office.do(t, http.MethodGet, path+"/events?limit=2", ""))
	if len(events) != 2 {
		t.Errorf("events = %+v", events)
	}
}

func agentNamed(t *testing.T, office *office, name string) models.LiveAgent {
	t.Helper()
	snapshot := decode[models.Snapshot](t, office.do(t, http.MethodGet, "/api/snapshot", ""))
	for _, agent := range snapshot.Agents {
		if agent.Name == name {
			return agent
		}
	}
	t.Fatalf("no agent called %s", name)
	return models.LiveAgent{}
}

func TestAgentActions(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	mori := agentNamed(t, office, "Mori")
	if response := office.do(t, http.MethodPost, "/api/agents/"+mori.ID+"/retry", ""); response.Code != http.StatusOK {
		t.Fatalf("retry = %d", response.Code)
	}
	if got := agentNamed(t, office, "Mori"); got.State != models.StateThinking || got.Error != "" {
		t.Errorf("Mori = %s, %q", got.State, got.Error)
	}

	ledger := agentNamed(t, office, "Ledger")
	if response := office.do(t, http.MethodPost, "/api/agents/"+ledger.ID+"/interrupt", ""); response.Code != http.StatusOK {
		t.Fatalf("interrupt = %d", response.Code)
	}
	if got := agentNamed(t, office, "Ledger"); got.State != models.StatePaused || got.Estimate != nil {
		t.Errorf("Ledger = %s, estimate %+v", got.State, got.Estimate)
	}

	if response := office.do(t, http.MethodPost, "/api/agents/"+ledger.ID+"/stop", ""); response.Code != http.StatusOK {
		t.Fatalf("stop = %d", response.Code)
	}
	if got := agentNamed(t, office, "Ledger"); !got.Leaving {
		t.Error("Ledger did not start leaving")
	}
	if response := office.do(t, http.MethodPost, "/api/agents/nope/stop", ""); response.Code != http.StatusNotFound {
		t.Errorf("missing agent = %d", response.Code)
	}
}

func TestAddSubagentLimitsAndNames(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	atlas := agentNamed(t, office, "Atlas")
	path := "/api/agents/" + atlas.ID + "/subagents"

	created := office.do(t, http.MethodPost, path, `{"name":"Atlas runner","task":"Run the tests"}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create = %d: %s", created.Code, created.Body.String())
	}
	helper := decode[models.Agent](t, created)
	if helper.Model != "claude-haiku-4-5" || *helper.Lead != atlas.ID || *helper.Project != "checkout" {
		t.Errorf("helper = %+v", helper)
	}

	if response := office.do(t, http.MethodPost, path, `{"name":"Atlas runner"}`); response.Code != http.StatusConflict ||
		!strings.Contains(response.Body.String(), "already an agent") {
		t.Errorf("duplicate = %d %s", response.Code, response.Body.String())
	}
	if response := office.do(t, http.MethodPost, path, `{"name":"  "}`); response.Code != http.StatusBadRequest {
		t.Errorf("blank = %d", response.Code)
	}

	third := decode[models.Agent](t, office.do(t, http.MethodPost, path, `{"name":"Atlas third"}`))
	if !strings.HasPrefix(agentNamed(t, office, third.Name).Task, "Help Atlas with prepare") {
		t.Errorf("task = %q", agentNamed(t, office, third.Name).Task)
	}
	response := office.do(t, http.MethodPost, path, `{"name":"Atlas fourth"}`)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "Three subagents") {
		t.Errorf("fourth = %d %s", response.Code, response.Body.String())
	}
}

func TestTeamEstimateCoversALeadAndItsSubagents(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	atlas := agentNamed(t, office, "Atlas")
	if atlas.Estimate != nil {
		t.Fatalf("Atlas is waiting, so it has no estimate of its own: %+v", atlas.Estimate)
	}
	scribe := agentNamed(t, office, "Atlas scribe")
	if atlas.TeamEstimate == nil || atlas.TeamEstimate.SecondsLeft != scribe.Estimate.SecondsLeft {
		t.Errorf("team = %+v, scribe = %+v", atlas.TeamEstimate, scribe.Estimate)
	}
	if ledger := agentNamed(t, office, "Ledger"); ledger.TeamEstimate != nil {
		t.Errorf("Ledger has no subagents: %+v", ledger.TeamEstimate)
	}
}

func TestAgentSettingsAreRecorded(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	atlas := agentNamed(t, office, "Atlas")
	path := "/api/agents/" + atlas.ID
	body := `{"model":"claude-sonnet-4-5","folder":"~/code/next","projectId":"docs","subModel":"inherit"}`
	if response := office.do(t, http.MethodPatch, path, body); response.Code != http.StatusOK {
		t.Fatalf("update = %d", response.Code)
	}
	if got := agentNamed(t, office, "Atlas scribe"); *got.Project != "docs" {
		t.Errorf("the subagent stayed in %s", *got.Project)
	}
	rows := decode[[]models.LogEntry](t, office.do(t, http.MethodGet, "/api/activity?q=Switch%20model", ""))
	if len(rows) != 1 || rows[0].Outcome != "At next checkpoint" || rows[0].Chip != "amber" {
		t.Errorf("rows = %+v", rows)
	}
	if response := office.do(t, http.MethodPatch, path, `{"folder":"not a path"}`); response.Code != http.StatusBadRequest {
		t.Errorf("bad folder = %d", response.Code)
	}
}

func TestAccountsListEveryKind(t *testing.T) {
	accounts := decode[[]models.Account](t, newOffice(t).do(t, http.MethodGet, "/api/accounts", ""))
	if len(accounts) != 5 || accounts[0].Kind != models.AccountCodex || accounts[0].Status != models.AccountOff {
		t.Errorf("accounts = %+v", accounts)
	}
}

func TestSettingsPartialUpdateAndValidation(t *testing.T) {
	office := newOffice(t)
	updated := decode[models.Settings](t, office.do(t, http.MethodPatch, "/api/settings", `{"retentionDays":7}`))
	if updated.RetentionDays != 7 || updated.QueryModel != "gpt-5-mini" {
		t.Errorf("updated = %+v", updated)
	}
	if got := decode[models.Settings](t, office.do(t, http.MethodGet, "/api/settings", "")); got.RetentionDays != 7 {
		t.Errorf("stored = %+v", got)
	}
	for _, body := range []string{
		`{"retentionDays":8}`, `{"voiceEngine":"cloud"}`, `{"nope":1}`,
	} {
		if response := office.do(t, http.MethodPatch, "/api/settings", body); response.Code != http.StatusBadRequest {
			t.Errorf("%s = %d", body, response.Code)
		}
	}
}

// A rejected update must change nothing, including the defaults map it was decoded onto.
func TestRejectedSettingsChangeNothing(t *testing.T) {
	office := newOffice(t)
	body := `{"retentionDays":5,"defaults":{"claude":"poisoned"}}`
	if response := office.do(t, http.MethodPatch, "/api/settings", body); response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", response.Code)
	}
	got := decode[models.Settings](t, office.do(t, http.MethodGet, "/api/settings", ""))
	if got.Defaults["claude"] == "poisoned" || got.RetentionDays != 30 {
		t.Errorf("settings changed: %+v", got)
	}
}

// Turning auto approve off and then saving other settings must leave it off.
func TestSettingsKeepAutoApproveOff(t *testing.T) {
	office := newOffice(t)
	office.do(t, http.MethodPost, "/api/auto-approve", `{"on":true,"scope":"all","acknowledged":true}`)
	office.do(t, http.MethodPost, "/api/auto-approve", `{"on":false,"scope":"all","acknowledged":true}`)
	updated := decode[models.Settings](t, office.do(t, http.MethodPatch, "/api/settings", `{"spokenReplies":true}`))
	if updated.AutoApprove.On || !updated.SpokenReplies {
		t.Errorf("updated = %+v", updated)
	}
}

func TestSettingsCannotTurnOnAutoApprove(t *testing.T) {
	office := newOffice(t)
	body := `{"autoApprove":{"on":true,"scope":"all"}}`
	updated := decode[models.Settings](t, office.do(t, http.MethodPatch, "/api/settings", body))
	if updated.AutoApprove.On {
		t.Error("the settings route turned on auto approve")
	}
}

func TestApprovalDecision(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	pending := decode[[]models.Approval](t, office.do(t, http.MethodGet, "/api/approvals?pending=1", ""))
	if len(pending) != 1 || pending[0].Detail.Cmd != "npm run db:migrate -- --env=staging" {
		t.Fatalf("pending = %+v", pending)
	}
	path := "/api/approvals/" + pending[0].ID + "/decision"
	if response := office.do(t, http.MethodPost, path, `{"decision":"maybe"}`); response.Code != http.StatusBadRequest {
		t.Errorf("bad decision = %d", response.Code)
	}

	first := decode[map[string]bool](t, office.do(t, http.MethodPost, path, `{"decision":"allowed"}`))
	if !first["applied"] {
		t.Error("first decision was not applied")
	}
	second := decode[map[string]bool](t, office.do(t, http.MethodPost, path, `{"decision":"denied"}`))
	if second["applied"] {
		t.Error("second decision changed something")
	}

	snapshot := decode[models.Snapshot](t, office.do(t, http.MethodGet, "/api/snapshot", ""))
	for _, agent := range snapshot.Agents {
		if agent.Name == "Atlas" && (agent.State != models.StateRunning || agent.Approval != nil) {
			t.Errorf("Atlas = %s, approval %+v", agent.State, agent.Approval)
		}
	}
	if pending := decode[[]models.Approval](t, office.do(t, http.MethodGet, "/api/approvals?pending=1", "")); len(pending) != 0 {
		t.Errorf("still pending: %+v", pending)
	}
	rows := decode[[]models.LogEntry](t, office.do(t, http.MethodGet, "/api/activity?type=Approval&q=migrate", ""))
	if len(rows) != 1 || rows[0].Outcome != "Allowed" {
		t.Errorf("log = %+v", rows)
	}
}

func TestActivitySearch(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	rows := decode[[]models.LogEntry](t, office.do(t, http.MethodGet, "/api/activity?q=changelog", ""))
	if len(rows) != 1 || rows[0].Agent != "Sage" || rows[0].Outcome != "Waiting for checkpoint" {
		t.Errorf("rows = %+v", rows)
	}
}

func TestWipeNeedsConfirmationAndReturnsToFirstRun(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	office.do(t, http.MethodPatch, "/api/settings", `{"retentionDays":7}`)
	office.do(t, http.MethodPost, "/api/auto-approve", `{"on":true,"scope":"all","acknowledged":true}`)
	if response := office.do(t, http.MethodPost, "/api/wipe", `{}`); response.Code != http.StatusBadRequest {
		t.Fatalf("unconfirmed wipe = %d", response.Code)
	}
	if response := office.do(t, http.MethodPost, "/api/wipe", `{"confirm":true}`); response.Code != http.StatusOK {
		t.Fatalf("wipe = %d", response.Code)
	}
	snapshot := decode[models.Snapshot](t, office.do(t, http.MethodGet, "/api/snapshot", ""))
	if !snapshot.FirstRun || len(snapshot.Agents) != 0 || len(snapshot.Projects) != 0 ||
		len(snapshot.Log) != 0 || len(snapshot.Messages) != 0 {
		t.Errorf("after wipe: %+v", snapshot)
	}
	// Preferences stay, as in the prototype, but auto approve is off.
	if snapshot.Settings.RetentionDays != 7 || snapshot.Settings.AutoApprove.On {
		t.Errorf("settings after wipe = %+v", snapshot.Settings)
	}
	if pending := decode[[]models.Approval](t, office.do(t, http.MethodGet, "/api/approvals", "")); len(pending) != 0 {
		t.Errorf("approvals after wipe = %+v", pending)
	}
	for _, account := range snapshot.Accounts {
		if account.Status != models.AccountOff {
			t.Errorf("account %s = %s", account.Kind, account.Status)
		}
	}
}

func dial(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, nil) //nolint:bodyclose // The library closes it.
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	return conn
}

func receive(t *testing.T, conn *websocket.Conn) models.ServerMessage {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var message models.ServerMessage
	if err := json.Unmarshal(data, &message); err != nil {
		t.Fatal(err)
	}
	return message
}

func listen(t *testing.T, office *office) string {
	t.Helper()
	server := httptest.NewUnstartedServer(office.handler)
	server.Start()
	t.Cleanup(server.Close)
	return "ws" + strings.TrimPrefix(server.URL, "http") + "/ws"
}

func TestWebSocketStreamsInOrderAndResumes(t *testing.T) {
	office := newOffice(t)
	url := listen(t, office)
	conn := dial(t, url)

	hello := receive(t, conn)
	if hello.Type != models.MsgHello || hello.BootID == "" {
		t.Fatalf("hello = %+v", hello)
	}
	if err := office.simulator.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	last := hello.Seq
	for range 40 {
		message := receive(t, conn)
		if message.Seq != last+1 {
			t.Fatalf("seq %d after %d", message.Seq, last)
		}
		last = message.Seq
	}
	_ = conn.CloseNow()

	if err := office.simulator.Tick(); err != nil {
		t.Fatal(err)
	}
	// Loading the demo clears the office, which starts a new boot so nothing deleted can be
	// replayed. A page learns the new one from the snapshot it reloads on that reset.
	snapshot := decode[models.Snapshot](t, office.do(t, http.MethodGet, "/api/snapshot", ""))
	if snapshot.BootID == hello.BootID {
		t.Fatal("clearing the office should start a new boot")
	}
	resumed := dial(t, url+"?boot="+snapshot.BootID+"&since="+uintText(last))
	if first := receive(t, resumed); first.Type != models.MsgHello {
		t.Fatalf("first = %+v", first)
	}
	if next := receive(t, resumed); next.Seq != last+1 {
		t.Errorf("resumed at %d, want %d", next.Seq, last+1)
	}
}

func uintText(value uint64) string {
	data, _ := json.Marshal(value)
	return string(data)
}

func TestWebSocketFromAnotherBootResyncs(t *testing.T) {
	conn := dial(t, listen(t, newOffice(t))+"?boot=old&since=5")
	if hello := receive(t, conn); hello.Type != models.MsgHello {
		t.Fatalf("hello = %+v", hello)
	}
	if message := receive(t, conn); message.Type != models.MsgResync {
		t.Errorf("message = %+v", message)
	}
}

func TestWebSocketRefusesOtherWebsites(t *testing.T) {
	url := listen(t, newOffice(t))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	options := &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"https://evil.example"}}}
	conn, response, err := websocket.Dial(ctx, url, options) //nolint:bodyclose // The library closes it.
	if err == nil {
		_ = conn.CloseNow()
		t.Fatal("expected the upgrade to be refused")
	}
	if response == nil || response.StatusCode != http.StatusForbidden {
		t.Errorf("response = %+v", response)
	}
}

func TestDispatchPreviewMatchesTheRealDecision(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	body := `{"text":"the invoice rounding is wrong"}`
	preview := decode[map[string]dispatch.Decision](t, office.do(t, http.MethodPost, "/api/dispatch/preview", body))
	sent := decode[messageResult](t, office.do(t, http.MethodPost, "/api/messages",
		`{"text":"the invoice rounding is wrong","mode":"instruct","target":"auto"}`))
	if preview["decision"].Name != "Ledger" || sent.Routed == nil || sent.Routed.AgentID != preview["decision"].AgentID {
		t.Errorf("preview = %+v, sent = %+v", preview, sent.Routed)
	}
	rows := decode[[]models.LogEntry](t, office.do(t, http.MethodGet, "/api/activity?q=Routed", ""))
	if len(rows) != 1 || rows[0].Agent != "Mabari" {
		t.Errorf("rows = %+v", rows)
	}
}

func TestDispatchRespectsTheProjectInView(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	body := `{"text":"the invoice rounding is wrong","projectId":"docs"}`
	preview := decode[map[string]dispatch.Decision](t, office.do(t, http.MethodPost, "/api/dispatch/preview", body))
	if name := preview["decision"].Name; name != "Scout" && name != "Rune" {
		t.Errorf("went to %s, outside the project", name)
	}
}

func TestInstructionsQueueForBusyClaudeAgents(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	ledger := agentNamed(t, office, "Ledger")
	body := `{"text":"Add a test","mode":"instruct","target":"` + ledger.ID + `"}`
	if response := office.do(t, http.MethodPost, "/api/messages", body); response.Code != http.StatusOK {
		t.Fatalf("send = %d", response.Code)
	}
	if got := agentNamed(t, office, "Ledger"); len(got.Queued) != 1 || got.Queued[0].Text != "Add a test" {
		t.Errorf("queued = %+v", got.Queued)
	}
	rows := decode[[]models.LogEntry](t, office.do(t, http.MethodGet, "/api/activity?q=Add%20a%20test", ""))
	if len(rows) != 1 || rows[0].Outcome != "Waiting for checkpoint" || rows[0].Chip != "amber" {
		t.Errorf("rows = %+v", rows)
	}
}

func TestInstructionsReachOtherAgentsAtOnce(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	scout := agentNamed(t, office, "Scout")
	body := `{"text":"Add the pricing pages","mode":"instruct","target":"` + scout.ID + `"}`
	office.do(t, http.MethodPost, "/api/messages", body)
	got := agentNamed(t, office, "Scout")
	if len(got.Queued) != 0 || got.Feed[0].Summary != "Received: Add the pricing pages" ||
		got.Reply != "Got it. I'll add the pricing pages." {
		t.Errorf("Scout = %+v", got.SessionState)
	}
}

func TestInstructingAFreeAgentGivesItTheTask(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	pixel := agentNamed(t, office, "Pixel")
	body := `{"text":"Pixel, write the changelog","mode":"instruct","target":"` + pixel.ID + `"}`
	office.do(t, http.MethodPost, "/api/messages", body)
	got := agentNamed(t, office, "Pixel")
	if got.Task != "write the changelog" || got.State != models.StateThinking || got.Progress != 0 {
		t.Errorf("Pixel = %+v", got.SessionState)
	}
}

func TestQueriesAreAnsweredFromTheLogWithoutInterrupting(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	ledger := agentNamed(t, office, "Ledger")
	body := `{"text":"How is it going?","mode":"query","target":"` + ledger.ID + `"}`
	result := decode[messageResult](t, office.do(t, http.MethodPost, "/api/messages", body))
	if result.Answer == nil || result.Answer.Name != "Ledger" || len(result.Answer.Events) == 0 {
		t.Fatalf("result = %+v", result)
	}
	after := agentNamed(t, office, "Ledger")
	if after.State != ledger.State || len(after.Queued) != 0 || after.Progress != ledger.Progress {
		t.Errorf("the agent changed: %+v", after.SessionState)
	}
	if after.BubbleKind != "reply" {
		t.Errorf("bubble kind = %q", after.BubbleKind)
	}
}

func TestQuestionsToEveryoneSkipStoppedAgents(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	result := decode[messageResult](t, office.do(t, http.MethodPost, "/api/messages",
		`{"text":"Status?","mode":"query","target":"everyone"}`))
	if len(result.Team) != 9 {
		t.Errorf("team = %d", len(result.Team))
	}
	for _, line := range result.Team {
		if line.Name == "Mori" {
			t.Error("Mori has an error and should be left out")
		}
	}
}

func TestMessageValidation(t *testing.T) {
	office := newOffice(t)
	cases := map[string]int{
		`{"text":"","mode":"instruct","target":"auto"}`:     http.StatusBadRequest,
		`{"text":"hi","mode":"shout","target":"auto"}`:      http.StatusBadRequest,
		`{"text":"hi","mode":"instruct","target":"auto"}`:   http.StatusBadRequest,
		`{"text":"hi","mode":"instruct","target":"nobody"}`: http.StatusBadRequest,
	}
	for body, want := range cases {
		if response := office.do(t, http.MethodPost, "/api/messages", body); response.Code != want {
			t.Errorf("%s = %d", body, response.Code)
		}
	}
}

func TestEverythingAutoApproveNeedsAnAcknowledgement(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	response := office.do(t, http.MethodPost, "/api/auto-approve", `{"on":true,"scope":"all"}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", response.Code)
	}
	if atlas := agentNamed(t, office, "Atlas"); atlas.Approval == nil {
		t.Error("the risky approval was settled without an acknowledgement")
	}
	settled := decode[map[string]int](t, office.do(t, http.MethodPost, "/api/auto-approve",
		`{"on":true,"scope":"all","acknowledged":true}`))
	if settled["settled"] != 1 {
		t.Errorf("settled = %+v", settled)
	}
	if atlas := agentNamed(t, office, "Atlas"); atlas.Approval != nil {
		t.Error("the approval is still waiting")
	}
}

func TestLowRiskAutoApproveLeavesRiskyActionsWaiting(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	settled := decode[map[string]int](t, office.do(t, http.MethodPost, "/api/auto-approve", `{"on":true,"scope":"safe"}`))
	if settled["settled"] != 0 {
		t.Errorf("settled = %+v", settled)
	}
	if atlas := agentNamed(t, office, "Atlas"); atlas.Approval == nil {
		t.Error("a risky action was approved under the low risk scope")
	}
	rows := decode[[]models.LogEntry](t, office.do(t, http.MethodGet, "/api/activity?q=auto%20approve", ""))
	if len(rows) != 1 || rows[0].Outcome != "On" {
		t.Errorf("rows = %+v", rows)
	}
	office.do(t, http.MethodPost, "/api/auto-approve", `{"on":false}`)
	if got := decode[models.Settings](t, office.do(t, http.MethodGet, "/api/settings", "")); got.AutoApprove.On {
		t.Error("auto approve is still on")
	}
}

func askVee(t *testing.T, office *office, body string) veeResult {
	t.Helper()
	response := office.do(t, http.MethodPost, "/api/vee", body)
	if response.Code != http.StatusOK {
		t.Fatalf("status %d: %s", response.Code, response.Body)
	}
	return decode[veeResult](t, response)
}

func TestVeeAnswersFromTheLiveOffice(t *testing.T) {
	office := newOffice(t)
	office.do(t, http.MethodPost, "/api/demo/load", "")
	result := askVee(t, office, `{"text":"Who needs me?"}`)
	if result.Reply.Kind != "needs" || len(result.Reply.Lines) == 0 {
		t.Fatalf("got %+v", result.Reply)
	}
}

func TestVeePassesMessagesOn(t *testing.T) {
	office := newOffice(t)
	office.do(t, http.MethodPost, "/api/demo/load", "")
	result := askVee(t, office, `{"text":"Tell Scout to add the pricing pages"}`)
	if result.Message == nil || len(result.Message.Agents) != 1 {
		t.Fatalf("got %+v", result.Message)
	}
	scout := agentNamed(t, office, "Scout")
	if result.Message.Agents[0] != scout.ID {
		t.Errorf("reached %s", result.Message.Agents[0])
	}
	if len(scout.Feed) == 0 || scout.Feed[0].Summary != "Received: add the pricing pages" {
		t.Errorf("feed = %+v", scout.Feed)
	}

	asked := askVee(t, office, `{"text":"ask Ledger how it is going"}`)
	if asked.Message == nil || asked.Message.Answer == nil || asked.Message.Answer.Name != "Ledger" {
		t.Fatalf("got %+v", asked.Message)
	}
}

func TestVeeDispatchesToTheTeam(t *testing.T) {
	office := newOffice(t)
	office.do(t, http.MethodPost, "/api/demo/load", "")
	result := askVee(t, office, `{"text":"the invoice rounding is wrong"}`)
	ledger := agentNamed(t, office, "Ledger")
	if result.Message == nil || len(result.Message.Agents) != 1 || result.Message.Agents[0] != ledger.ID {
		t.Fatalf("got %+v", result)
	}
	// Mabari works out the project from what its agents are doing, then the agent there.
	if result.Reply.Project == nil || result.Reply.Project.Name != "Checkout revamp" ||
		!strings.HasPrefix(result.Reply.Text, "On it, sent to Ledger (Claude) in Checkout revamp. I picked Checkout revamp because ") ||
		!strings.HasSuffix(result.Reply.Text, " I'll read you the reply the moment it lands.") {
		t.Errorf("reply = %q", result.Reply.Text)
	}
	relay := result.Reply.Relay
	if relay == nil || relay.AgentID != ledger.ID || relay.InstructionID == "" || relay.AI != "Claude" {
		t.Fatalf("relay = %+v", relay)
	}
	// Ledger is mid step, so the instruction waits for its next checkpoint.
	if len(ledger.Queued) != 1 || ledger.Queued[0].ID != relay.InstructionID {
		t.Errorf("queued = %+v", ledger.Queued)
	}
}

// Commands that share words with office questions still go to the team: to the project they
// fit, or Mabari asks which project when none clearly does.
func TestVeeDispatchesCommandsThatLookLikeQuestions(t *testing.T) {
	office := newOffice(t)
	office.do(t, http.MethodPost, "/api/demo/load", "")
	for text, want := range map[string]string{
		"update the README":        "On it, sent to Rune (ChatGPT) in Docs site.",
		"finish the login page":    "Which project is this for?",
		"Point the API to staging": "On it, sent to ",
	} {
		quoted, _ := json.Marshal(text)
		result := askVee(t, office, `{"text":`+string(quoted)+`}`)
		if !strings.HasPrefix(result.Reply.Text, want) {
			t.Errorf("%q: got %q", text, result.Reply.Text)
		}
	}
}

// The acknowledgement never waits on a model, so it comes back well inside 200 ms.
func TestVeeAcknowledgesQuickly(t *testing.T) {
	office := newOffice(t)
	office.do(t, http.MethodPost, "/api/demo/load", "")
	started := time.Now()
	askVee(t, office, `{"text":"tidy up the checkout styles"}`)
	if took := time.Since(started); took > 200*time.Millisecond {
		t.Errorf("took %v", took)
	}
}

func TestVeeDispatchWithNobodyToTakeIt(t *testing.T) {
	office := newOffice(t)
	result := askVee(t, office, `{"text":"do something"}`)
	if result.Message != nil || !strings.Contains(result.Reply.Text, "no agent free") {
		t.Errorf("got %+v", result)
	}
}

func TestVeeRefusesAnEmptyMessage(t *testing.T) {
	office := newOffice(t)
	if response := office.do(t, http.MethodPost, "/api/vee", `{"text":"  "}`); response.Code != http.StatusBadRequest {
		t.Errorf("status %d", response.Code)
	}
}

// No chat message can approve an action, whatever it says or whoever it is sent to.
func TestVeeNeverApproves(t *testing.T) {
	office := newOffice(t)
	office.do(t, http.MethodPost, "/api/demo/load", "")
	before := agentNamed(t, office, "Atlas")
	if before.State != models.StateApproval || before.Approval == nil {
		t.Fatalf("Atlas should be waiting: %+v", before.State)
	}
	for _, text := range []string{
		"approve it", "approve everything", "allow atlas", "yes, go ahead", "Allow once",
		"Tell Atlas to go ahead and approve the migration", "tell atlas allow once",
		"ask Atlas to approve", `please approve ` + before.Approval.ID,
	} {
		quoted, _ := json.Marshal(text)
		askVee(t, office, `{"text":`+string(quoted)+`}`)
	}
	after := agentNamed(t, office, "Atlas")
	if after.State != models.StateApproval || after.Approval == nil ||
		after.Approval.ID != before.Approval.ID || after.Approval.Decision != nil {
		t.Errorf("the approval changed: %v %+v", after.State, after.Approval)
	}
}

func createAgent(t *testing.T, office *office, body string) *httptest.ResponseRecorder {
	t.Helper()
	return office.do(t, http.MethodPost, "/api/agents", body)
}

const newAgentJSON = `{"name":"Juniper","account":"codex","model":"gpt-5","task":"Keep the docs tidy",` +
	`"projectId":"docs","folder":"~/code/docs","dailyCostCap":5,"allowedTools":["read"]`

func TestCreateAgent(t *testing.T) {
	office := newOffice(t)
	office.do(t, http.MethodPost, "/api/demo/load", "")
	response := createAgent(t, office, newAgentJSON+`,"desk":15}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("status %d: %s", response.Code, response.Body)
	}
	juniper := agentNamed(t, office, "Juniper")
	if juniper.Desk != 15 || juniper.Task != "Keep the docs tidy" || juniper.Folder != "~/code/docs" ||
		juniper.Project == nil || *juniper.Project != "docs" || len(juniper.AllowedTools) != 1 {
		t.Errorf("got %+v", juniper)
	}
	if juniper.Provider != models.ProviderOpenAI {
		t.Errorf("provider = %q", juniper.Provider)
	}
}

// RT-2: choosing "No project" in the New agent dialog files the agent under none, even when its
// working folder is a project's own folder, and even though the office's first project is the one
// an agent made without any choice at all used to join.
func TestAnAgentMadeWithNoProjectStaysUnfiled(t *testing.T) {
	office := newOffice(t)
	office.do(t, http.MethodPost, "/api/demo/load", "")
	folder := t.TempDir()
	_ = office.engine.Do(func() {
		office.engine.SaveProject(models.Project{
			ID: "shopfront", Name: "Shopfront", Color: "#FF6B9A", Repository: &models.Repository{Path: folder},
		})
	})
	first := office.engine.Snapshot().Projects[0].ID
	for _, projectID := range []string{`""`, `null`} {
		name := "Loner" + strings.Trim(projectID, `"`)
		body := `{"name":"` + name + `","account":"codex","model":"gpt-5","task":"Keep it tidy",` +
			`"projectId":` + projectID + `,"folder":"` + folder + `","dailyCostCap":0,"allowedTools":["read"]}`
		if response := createAgent(t, office, body); response.Code != http.StatusCreated {
			t.Fatalf("status %d: %s", response.Code, response.Body)
		}
		loner := agentNamed(t, office, name)
		if loner.Project != nil {
			t.Errorf("projectId %s: an agent with no project was filed under %q (the first project is %q)",
				projectID, *loner.Project, first)
		}
	}
	// Choosing the project the folder belongs to is still honoured.
	body := `{"name":"Filed","account":"codex","model":"gpt-5","task":"Keep it tidy",` +
		`"projectId":"shopfront","folder":"` + folder + `","dailyCostCap":0,"allowedTools":["read"]}`
	if response := createAgent(t, office, body); response.Code != http.StatusCreated {
		t.Fatalf("status %d: %s", response.Code, response.Body)
	}
	if filed := agentNamed(t, office, "Filed"); filed.Project == nil || *filed.Project != "shopfront" {
		t.Errorf("an agent given a project lost it: %v", filed.Project)
	}
}

// The desk grid grows, so a desk past the first sixteen is a real desk, and the server says who
// is working.
func TestCreateAgentAtAGrownDesk(t *testing.T) {
	office := newOffice(t)
	office.do(t, http.MethodPost, "/api/demo/load", "")
	response := createAgent(t, office, newAgentJSON+`,"desk":30}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("status %d: %s", response.Code, response.Body)
	}
	juniper := agentNamed(t, office, "Juniper")
	if juniper.Desk != 30 || !juniper.Working || juniper.Workflow {
		t.Errorf("got %+v", juniper)
	}
}

func TestCreateAgentRefusals(t *testing.T) {
	office := newOffice(t)
	if response := createAgent(t, office, newAgentJSON+`}`); response.Code != http.StatusConflict ||
		!strings.Contains(response.Body.String(), "Connect an account first.") {
		t.Fatalf("no account: %d %s", response.Code, response.Body)
	}
	office.do(t, http.MethodPost, "/api/demo/load", "")
	tests := []struct {
		body string
		code int
		says string
	}{
		{strings.Replace(newAgentJSON, "Juniper", " ", 1) + `}`, http.StatusBadRequest, "Give the agent a name."},
		{strings.Replace(newAgentJSON, "Juniper", "Ledger", 1) + `}`, http.StatusConflict, "There is already an agent called Ledger."},
		{strings.Replace(newAgentJSON, "~/code/docs", "", 1) + `}`, http.StatusBadRequest, "Choose a working folder."},
		{strings.Replace(newAgentJSON, "~/code/docs", "not a path", 1) + `}`, http.StatusBadRequest, "doesn't look right"},
		{strings.Replace(newAgentJSON, `"dailyCostCap":5`, `"dailyCostCap":-1`, 1) + `}`, http.StatusBadRequest, "zero or more"},
		{newAgentJSON + `,"desk":99}`, http.StatusBadRequest, "doesn't exist"},
		{newAgentJSON + `,"desk":0}`, http.StatusConflict, "just been taken"},
		{newAgentJSON + `,"leadId":"nobody"}`, http.StatusConflict, "left the office"},
	}
	for _, test := range tests {
		response := createAgent(t, office, test.body)
		if response.Code != test.code || !strings.Contains(response.Body.String(), test.says) {
			t.Errorf("%s: %d %s", test.body, response.Code, response.Body)
		}
	}
}

func TestCreateSubagentFromTheDialog(t *testing.T) {
	office := newOffice(t)
	office.do(t, http.MethodPost, "/api/demo/load", "")
	scout := agentNamed(t, office, "Scout")
	response := createAgent(t, office, newAgentJSON+`,"leadId":"`+scout.ID+`"}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("status %d: %s", response.Code, response.Body)
	}
	if juniper := agentNamed(t, office, "Juniper"); juniper.Lead == nil || *juniper.Lead != scout.ID {
		t.Errorf("lead = %v", juniper.Lead)
	}
}

// A command an agent was allowed to run can reach Mabari's port. What must follow a person's click
// refuses anything but Mabari's own page, which also keeps a script without a browser out.
func TestOnlyMabarisPageCanDoWhatNeedsAClick(t *testing.T) {
	o := newRunOffice(t)
	snapshot := o.demo(t)
	approval := ""
	for _, agent := range snapshot.Agents {
		if agent.Approval != nil {
			approval = agent.Approval.ID
		}
	}
	if approval == "" {
		t.Fatal("no approval waiting")
	}
	routes := map[string]string{
		"/api/auto-approve":  `{"on":true,"scope":"all","acknowledged":true}`,
		"/api/folders/trust": `{"path":"/tmp/shop","confirm":true}`,
		"/api/wipe":          `{"confirm":true}`,
		"/api/approvals/" + approval + "/decision": `{"decision":"allowed"}`,
	}
	for path, body := range routes {
		for name, origin := range map[string]string{
			"no origin":       "",
			"another site":    "https://evil.example",
			"another port":    "http://localhost:3000",
			"a sandbox frame": "null",
		} {
			request := httptest.NewRequest(http.MethodPost, "http://localhost:4317"+path, strings.NewReader(body))
			if origin != "" {
				request.Header.Set("Origin", origin)
			}
			recorder := httptest.NewRecorder()
			o.handler.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusForbidden {
				t.Errorf("%s, %s = %d %s", path, name, recorder.Code, recorder.Body)
			}
		}
	}
	after := decode[models.Snapshot](t, o.do(t, http.MethodGet, "/api/snapshot", ""))
	if after.Settings.AutoApprove.On || len(after.Agents) == 0 {
		t.Fatalf("something got through: auto approve %v, %d agents", after.Settings.AutoApprove.On, len(after.Agents))
	}
	if response := o.do(t, http.MethodPost, "/api/approvals/"+approval+"/decision", `{"decision":"denied"}`); response.Code != http.StatusOK {
		t.Fatalf("from the page = %d %s", response.Code, response.Body)
	}
	if response := o.do(t, http.MethodPost, "/api/auto-approve", `{"on":false,"scope":"safe"}`); response.Code != http.StatusOK {
		t.Fatalf("from the page = %d %s", response.Code, response.Body)
	}
}
