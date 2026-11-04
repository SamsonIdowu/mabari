// SPDX-License-Identifier: Apache-2.0

package simulator

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

const (
	goldenSeed  = 20261104
	goldenStart = int64(1_800_000_000_000)
)

type clock struct{ ms int64 }

func (c *clock) now() time.Time { return time.UnixMilli(c.ms) }

func setup(t *testing.T, path string, seed uint32) (*Simulator, *events.Engine, *clock, *store.Store) {
	t.Helper()
	s, err := store.Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	c := &clock{ms: goldenStart}
	engine, err := events.New(context.Background(), s, c.now)
	if err != nil {
		t.Fatal(err)
	}
	return New(engine, Mulberry32(seed), 0), engine, c, s
}

func advance(t *testing.T, sim *Simulator, c *clock, ticks int) {
	t.Helper()
	for range ticks {
		c.ms += 1000
		if err := sim.Tick(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMulberry32MatchesJavaScript(t *testing.T) {
	// From node: mulberry32(1) called three times, using the function in web/scripts.
	random := Mulberry32(1)
	want := []float64{0.6270739405881613, 0.002735721180215478, 0.5274470399599522}
	for index, expected := range want {
		if got := random(); math.Abs(got-expected) > 1e-12 {
			t.Errorf("value %d = %v, want %v", index, got, expected)
		}
	}
}

func TestDemoHasEveryStateAtOnce(t *testing.T) {
	sim, engine, _, _ := setup(t, ":memory:", 1)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	snapshot := engine.Snapshot()
	states := map[models.AgentState]string{}
	for _, agent := range snapshot.Agents {
		states[agent.State] = agent.Name
	}
	for _, state := range []models.AgentState{
		models.StateEditing, models.StateBrowsing, models.StateApproval, models.StateSpawning,
		models.StateRunning, models.StateIdle, models.StateDone, models.StateError,
		models.StateThinking,
	} {
		if states[state] == "" {
			t.Errorf("no agent is %s", state)
		}
	}
	if len(snapshot.Messages) != 10 || len(snapshot.Log) != 5 {
		t.Errorf("%d messages, %d log rows", len(snapshot.Messages), len(snapshot.Log))
	}
	if snapshot.Messages[0].Time > snapshot.Messages[9].Time {
		t.Error("messages are not oldest first")
	}
}

func TestSubagentSitsNextToItsLead(t *testing.T) {
	sim, engine, _, _ := setup(t, ":memory:", 1)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	var atlas, scribe models.LiveAgent
	for _, agent := range engine.Snapshot().Agents {
		switch agent.Name {
		case "Atlas":
			atlas = agent
		case "Atlas scribe":
			scribe = agent
		}
	}
	if scribe.Lead == nil || *scribe.Lead != atlas.ID || scribe.Desk != 5 ||
		*scribe.Project != "checkout" {
		t.Errorf("scribe = %+v", scribe.Agent)
	}
}

func TestEstimatesStayCurrentAsTheOfficeRuns(t *testing.T) {
	sim, engine, c, _ := setup(t, ":memory:", 1)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	advance(t, sim, c, 20)
	for _, agent := range engine.Snapshot().Agents {
		if agent.State.Active() {
			if agent.Estimate == nil || agent.Estimate.LowSeconds > agent.Estimate.SecondsLeft ||
				agent.Estimate.HighSeconds < agent.Estimate.SecondsLeft ||
				agent.Estimate.FinishAt <= c.ms {
				t.Errorf("%s estimate = %+v", agent.Name, agent.Estimate)
			}
		} else if agent.Estimate != nil {
			t.Errorf("%s (%s) has an estimate", agent.Name, agent.State)
		}
	}
}

func TestQueuedInstructionIsDeliveredAtTheNextCheckpoint(t *testing.T) {
	sim, engine, c, _ := setup(t, ":memory:", 1)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	sage := func() models.LiveAgent {
		for _, agent := range engine.Snapshot().Agents {
			if agent.Name == "Sage" {
				return agent
			}
		}
		t.Fatal("no Sage")
		return models.LiveAgent{}
	}
	if len(sage().Queued) != 1 {
		t.Fatalf("queued = %+v", sage().Queued)
	}
	for tick := 0; len(sage().Queued) > 0; tick++ {
		if tick > 20 {
			t.Fatal("instruction was never delivered")
		}
		advance(t, sim, c, 1)
	}
	if !strings.HasPrefix(sage().Reply, "Got it.") {
		t.Errorf("reply = %q", sage().Reply)
	}
	rows, err := engine.Store().Log(context.Background(), store.LogQuery{Search: "changelog"})
	if err != nil {
		t.Fatal(err)
	}
	if rows[0].Outcome != "Delivered at checkpoint" || rows[0].Chip != "ok" {
		t.Errorf("row = %+v", rows[0])
	}
}

func decide(t *testing.T, engine *events.Engine, id, decision string) bool {
	t.Helper()
	var applied bool
	if err := engine.Do(func() { applied = engine.Decide(id, decision) }); err != nil {
		t.Fatal(err)
	}
	return applied
}

func TestAutoApproveScopes(t *testing.T) {
	cases := []struct {
		name  string
		on    bool
		scope string
		risk  models.RiskLevel
		waits bool
	}{
		{"off", false, "safe", models.RiskLow, true},
		{"low risk scope passes low risk", true, "safe", models.RiskLow, false},
		{"low risk scope holds risky actions", true, "safe", models.RiskHigh, true},
		{"everything scope passes risky actions", true, "all", models.RiskHigh, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sim, engine, _, _ := setup(t, ":memory:", 1)
			if err := sim.LoadDemo(); err != nil {
				t.Fatal(err)
			}
			err := engine.Do(func() {
				settings := engine.Settings()
				settings.AutoApprove = models.AutoApprove{On: tc.on, Scope: tc.scope}
				engine.SaveSettings(settings)
				ledger := engine.AgentByName("Ledger")
				engine.RequestApproval(ledger, models.Approval{
					Type: models.ApprovalCommand, RiskLevel: tc.risk,
					Detail: models.ApprovalDetail{Cmd: "npm test"},
				})
			})
			if err != nil {
				t.Fatal(err)
			}
			for _, agent := range engine.Snapshot().Agents {
				if agent.Name != "Ledger" {
					continue
				}
				if waiting := agent.Approval != nil; waiting != tc.waits {
					t.Errorf("waiting = %v, state %s", waiting, agent.State)
				}
				if !tc.waits && agent.State != models.StateRunning {
					t.Errorf("state = %s", agent.State)
				}
			}
		})
	}
}

func TestDecisionsApplyOnce(t *testing.T) {
	sim, engine, _, _ := setup(t, ":memory:", 1)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	var id string
	if err := engine.Do(func() { id = engine.AgentByName("Atlas").Approval.ID }); err != nil {
		t.Fatal(err)
	}
	if !decide(t, engine, id, models.DecisionDenied) {
		t.Fatal("first decision was refused")
	}
	if decide(t, engine, id, models.DecisionAllowed) {
		t.Fatal("second decision was applied")
	}
	rows, err := engine.Store().Log(context.Background(), store.LogQuery{Type: models.LogApproval})
	if err != nil {
		t.Fatal(err)
	}
	if rows[0].Outcome != "Denied" {
		t.Errorf("newest row = %+v", rows[0])
	}
}

func TestDataSurvivesARestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mabari.db")
	ctx := context.Background()
	s, err := store.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	c := &clock{ms: goldenStart}
	engine, err := events.New(ctx, s, c.now)
	if err != nil {
		t.Fatal(err)
	}
	sim := New(engine, Mulberry32(1), 0)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	advance(t, sim, c, 30)
	before := engine.Snapshot()
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := store.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	restarted, err := events.New(ctx, reopened, c.now)
	if err != nil {
		t.Fatal(err)
	}
	after := restarted.Snapshot()
	if after.FirstRun || len(after.Agents) != len(before.Agents) ||
		len(after.Projects) != len(before.Projects) || len(after.Log) != len(before.Log) ||
		len(after.Messages) != len(before.Messages) {
		t.Fatalf("after restart: %d agents, %d projects, %d log, %d messages",
			len(after.Agents), len(after.Projects), len(after.Log), len(after.Messages))
	}
	for index, agent := range after.Agents {
		was := before.Agents[index]
		if agent.Name != was.Name || agent.State != was.State || agent.Progress != was.Progress ||
			agent.TokensIn != was.TokensIn || len(agent.Feed) != len(was.Feed) ||
			len(agent.Queued) != len(was.Queued) || (agent.Approval == nil) != (was.Approval == nil) {
			t.Errorf("%s changed across the restart", agent.Name)
		}
	}
	if active, err := reopened.Meta(ctx, store.MetaDemo); err != nil || active != "1" {
		t.Errorf("demo flag = %q, %v", active, err)
	}

	// Event numbers carry on, so nothing collides with what was stored.
	resumed := New(restarted, Mulberry32(2), 0)
	if err := resumed.Resume(true); err != nil {
		t.Fatal(err)
	}
	advance(t, resumed, c, 20)
}

// restartedDemo loads the demo, lets it run, then reopens the same database as Mabari does at start.
func restartedDemo(t *testing.T, change func(*Simulator, *events.Engine)) (*Simulator, *events.Engine, *clock) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "mabari.db")
	ctx := context.Background()
	s, err := store.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	c := &clock{ms: goldenStart}
	engine, err := events.New(ctx, s, c.now)
	if err != nil {
		t.Fatal(err)
	}
	sim := New(engine, Mulberry32(1), 0)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	advance(t, sim, c, 5)
	if change != nil {
		if err := engine.Do(func() { change(sim, engine) }); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := store.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	restarted, err := events.New(ctx, reopened, c.now)
	if err != nil {
		t.Fatal(err)
	}
	resumed := New(restarted, Mulberry32(2), 0)
	if err := resumed.Resume(true); err != nil {
		t.Fatal(err)
	}
	return resumed, restarted, c
}

func TestIdleAgentsGoBackToWorkAfterARestart(t *testing.T) {
	sim, engine, c := restartedDemo(t, nil)
	var idle []string
	for _, agent := range engine.Snapshot().Agents {
		if agent.State == models.StateIdle {
			idle = append(idle, agent.ID)
		}
	}
	if len(idle) == 0 {
		t.Fatal("the demo has no idle agent to check")
	}
	advance(t, sim, c, 60)
	for _, agent := range engine.Snapshot().Agents {
		if slices.Contains(idle, agent.ID) && agent.State == models.StateIdle {
			t.Errorf("%s is still idle a minute after the restart", agent.Name)
		}
	}
}

func TestStoppedAgentLeavesAfterARestart(t *testing.T) {
	_, engine, _ := restartedDemo(t, func(sim *Simulator, engine *events.Engine) {
		sim.StopAgent(engine.AgentByName("Ledger"))
	})
	if agent := engine.Snapshot(); slices.ContainsFunc(agent.Agents, func(a models.LiveAgent) bool {
		return a.Name == "Ledger"
	}) {
		t.Error("Ledger stayed in the office after the restart")
	}
}

func TestNewAgentsGetAFreshColourAfterARestart(t *testing.T) {
	sim, engine, _ := restartedDemo(t, nil)
	used := map[string]bool{}
	for _, agent := range engine.Snapshot().Agents {
		used[agent.Hue] = true
	}
	var hue string
	if err := engine.Do(func() {
		agent, err := sim.CreateAgent(NewAgent{Name: "Fresh", Account: models.AccountClaudeCode,
			Model: sim.Models()[0], Task: "Tidy the notes"})
		if err != nil {
			t.Error(err)
			return
		}
		hue = agent.Hue
	}); err != nil {
		t.Fatal(err)
	}
	if len(used) < len(hues) && used[hue] {
		t.Errorf("the new agent reused %s", hue)
	}
}

func TestRetentionKeepsOnlyRecentData(t *testing.T) {
	sim, engine, c, s := setup(t, ":memory:", 1)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	c.ms += 31 * 86_400_000
	if err := engine.RunRetention(context.Background()); err != nil {
		t.Fatal(err)
	}
	rows, err := s.Log(context.Background(), store.LogQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 0 || len(engine.Snapshot().Log) != 0 {
		t.Errorf("%d rows stored, %d in memory", len(rows), len(engine.Snapshot().Log))
	}
}

type goldenAgent struct {
	Name      string  `json:"name"`
	State     string  `json:"state"`
	Task      string  `json:"task"`
	Desk      int     `json:"desk"`
	Progress  float64 `json:"progress"`
	Rate      float64 `json:"rate"`
	Elapsed   int64   `json:"elapsed"`
	TokensIn  int64   `json:"tin"`
	TokensOut int64   `json:"tout"`
	Hue       string  `json:"hue"`
	Skin      string  `json:"skin"`
	Hair      string  `json:"hair"`
	Top       string  `json:"top"`
	Feed      int     `json:"feed"`
	Queued    int     `json:"queued"`
}

type goldenFrame struct {
	Tick     int           `json:"tick"`
	Agents   []goldenAgent `json:"agents"`
	Messages int           `json:"messages"`
	LastText string        `json:"lastText"`
	Log      int           `json:"log"`
}

func TestMatchesThePrototype(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatalf("%v (run `make golden` to create it)", err)
	}
	var golden []goldenFrame
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatal(err)
	}

	sim, engine, c, _ := setup(t, ":memory:", goldenSeed)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	tick := 0
	for _, frame := range golden {
		advance(t, sim, c, frame.Tick-tick)
		tick = frame.Tick
		snapshot := engine.Snapshot()
		if len(snapshot.Agents) != len(frame.Agents) {
			t.Fatalf("tick %d: %d agents, prototype has %d",
				tick, len(snapshot.Agents), len(frame.Agents))
		}
		for index, want := range frame.Agents {
			agent := snapshot.Agents[index]
			got := goldenAgent{
				Name: agent.Name, State: string(agent.State), Task: agent.Task, Desk: agent.Desk,
				Progress: agent.Progress, Rate: agent.Rate, Elapsed: agent.Elapsed,
				TokensIn: agent.TokensIn, TokensOut: agent.TokensOut, Hue: agent.Hue,
				Skin: agent.Skin, Hair: agent.Hair, Feed: len(agent.Feed), Queued: len(agent.Queued),
			}
			if len(agent.Feed) > 0 {
				got.Top = agent.Feed[0].Tool + "|" + agent.Feed[0].Summary
			}
			if got != want {
				t.Fatalf("tick %d, %s:\n got  %+v\n want %+v", tick, want.Name, got, want)
			}
		}
		if got := len(snapshot.Messages); got != frame.Messages {
			t.Fatalf("tick %d: %d messages, prototype has %d", tick, got, frame.Messages)
		}
		if got := snapshot.Messages[len(snapshot.Messages)-1].Text; got != frame.LastText {
			t.Fatalf("tick %d: last message %q, prototype has %q", tick, got, frame.LastText)
		}
		if got := len(snapshot.Log); got != frame.Log {
			t.Fatalf("tick %d: %d log rows, prototype has %d", tick, got, frame.Log)
		}
	}
}

// Helpers sit at the free desks nearest their lead, measured on the office's real desk grid.
func TestHelpersSitNearestTheirLead(t *testing.T) {
	sim, engine, _, _ := setup(t, ":memory:", 1)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	var desks []int
	if err := engine.Do(func() {
		lead := engine.AgentByName("Quill")
		for index := range 3 {
			helper := sim.AddSubagent(lead, "Helper"+strconv.Itoa(index), "Check the tests", sim.Models()[0])
			if helper == nil {
				t.Errorf("helper %d was refused", index)
				return
			}
			desks = append(desks, helper.Desk)
		}
	}); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(desks, []int{11, 15, 14}) {
		t.Errorf("desks = %v, want [11 15 14]", desks)
	}
}
