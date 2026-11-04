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
	// Delivered at the checkpoint, then answered, so the log says it was replied to.
	if rows[0].Outcome != "Replied" || rows[0].Chip != "ok" {
		t.Errorf("row = %+v", rows[0])
	}
	asked := sage().Asked
	if len(asked) != 1 || asked[0].Text != "Also add a changelog entry when you finish" ||
		!strings.HasPrefix(asked[0].Reply, "Got it.") || asked[0].RepliedAt == 0 {
		t.Errorf("asked = %+v", asked)
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

// Retention follows the setting: data just inside the window stays, and stored events, log rows
// and the feeds in memory all lose what is older.
func TestRetentionKeepsOnlyRecentData(t *testing.T) {
	ctx := context.Background()
	for _, days := range []int{7, 30, 90, 365} {
		t.Run(strconv.Itoa(days), func(t *testing.T) {
			sim, engine, c, s := setup(t, ":memory:", 1)
			if err := sim.LoadDemo(); err != nil {
				t.Fatal(err)
			}
			if err := engine.Do(func() {
				settings := engine.Settings()
				settings.RetentionDays = days
				engine.SaveSettings(settings)
			}); err != nil {
				t.Fatal(err)
			}
			counts := func() (stored, events, feeds int) {
				rows, err := s.Log(ctx, store.LogQuery{})
				if err != nil {
					t.Fatal(err)
				}
				for _, agent := range engine.Snapshot().Agents {
					found, err := s.Events(ctx, agent.ID, 1000, 0)
					if err != nil {
						t.Fatal(err)
					}
					events += len(found)
					feeds += len(agent.Feed)
				}
				return len(rows), events, feeds
			}
			const day = 86_400_000
			c.ms += int64(days-1) * day
			if err := engine.RunRetention(ctx); err != nil {
				t.Fatal(err)
			}
			if stored, events, feeds := counts(); stored == 0 || events == 0 || feeds == 0 {
				t.Fatalf("inside the window: %d log, %d events, %d in feeds", stored, events, feeds)
			}
			c.ms += 2 * day
			if err := engine.Do(func() {
				engine.Log("Mori", models.LogInstruction, "Fresh row", "Sent", "")
				engine.AddEvent(engine.AgentByName("Mori"), "read", "Fresh event", nil)
			}); err != nil {
				t.Fatal(err)
			}
			if err := engine.RunRetention(ctx); err != nil {
				t.Fatal(err)
			}
			if stored, events, feeds := counts(); stored != 1 || events != 1 || feeds != 1 {
				t.Errorf("after the window: %d log, %d events, %d in feeds, want 1 each", stored, events, feeds)
			}
			if got := engine.Snapshot().Log; len(got) != 1 {
				t.Errorf("%d log rows in memory", len(got))
			}
		})
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

func pendingFor(t *testing.T, engine *events.Engine, agentID string) []models.Approval {
	t.Helper()
	pending, err := engine.Store().Approvals(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	var mine []models.Approval
	for _, approval := range pending {
		if approval.Agent == agentID {
			mine = append(mine, approval)
		}
	}
	return mine
}

// An agent waits on one approval at a time. A stop, or a second request, settles the earlier one,
// and a restart restores the newest.
func TestNoApprovalIsLeftBehind(t *testing.T) {
	sim, engine, _ := restartedDemo(t, func(_ *Simulator, engine *events.Engine) {
		atlas := engine.AgentByName("Atlas")
		engine.RequestApproval(atlas, models.Approval{Type: models.ApprovalCommand,
			Title: "Run a command", Detail: models.ApprovalDetail{Cmd: "npm test"}})
	})
	var atlas *models.LiveAgent
	if err := engine.Do(func() { atlas = engine.AgentByName("Atlas") }); err != nil {
		t.Fatal(err)
	}
	pending := pendingFor(t, engine, atlas.ID)
	if len(pending) != 1 || atlas.Approval == nil || atlas.Approval.ID != pending[0].ID ||
		atlas.Approval.Detail.Cmd != "npm test" {
		t.Fatalf("pending = %+v, restored = %+v", pending, atlas.Approval)
	}
	if err := engine.Do(func() { sim.StopAgent(atlas) }); err != nil {
		t.Fatal(err)
	}
	if left := pendingFor(t, engine, atlas.ID); len(left) != 0 || atlas.Approval != nil {
		t.Errorf("after stop: pending = %+v", left)
	}
	rows, err := engine.Store().Log(context.Background(), store.LogQuery{Type: models.LogApproval})
	if err != nil {
		t.Fatal(err)
	}
	if rows[0].Outcome != "Cancelled" {
		t.Errorf("newest row = %+v", rows[0])
	}
}

// Plan first: the lead posts its plan, and the team starts only once it is allowed. A denied
// plan brings nobody in.
func TestATeamWaitsForItsPlan(t *testing.T) {
	for _, allow := range []bool{true, false} {
		sim, engine, c, _ := setup(t, ":memory:", 1)
		if err := sim.LoadDemo(); err != nil {
			t.Fatal(err)
		}
		var lead *models.LiveAgent
		if err := engine.Do(func() {
			created, err := sim.CreateAgent(NewAgent{Name: "Juniper", Account: models.AccountClaudeCode,
				Model: "claude-sonnet-4-5", Task: "Plan the shop", Project: "checkout"})
			if err != nil {
				t.Fatal(err)
			}
			lead = created
			sim.StartTeam(lead, []PlannedMember{{Name: "Orion", Task: "Build the shop"}, {Name: "Maple", Task: "Test it"}},
				true, "Coffee shop", []string{"Read the files", "Orion (builder): Build the shop"})
		}); err != nil {
			t.Fatal(err)
		}
		advance(t, sim, c, 6)
		var approval *models.Approval
		_ = engine.Do(func() { approval = lead.Approval })
		if approval == nil || approval.Type != models.ApprovalPlan || len(approval.Detail.Steps) != 2 {
			t.Fatalf("approval = %+v", approval)
		}
		if engine.Snapshot().Agents[len(engine.Snapshot().Agents)-1].Name == "Orion" {
			t.Fatal("the team started before the plan was approved")
		}
		decision := models.DecisionDenied
		if allow {
			decision = models.DecisionAllowed
		}
		decide(t, engine, approval.ID, decision)
		advance(t, sim, c, 6)
		helpers := 0
		for _, agent := range engine.Snapshot().Agents {
			if agent.Lead != nil && *agent.Lead == lead.ID {
				helpers++
			}
		}
		if allow && helpers != 2 || !allow && helpers != 0 {
			t.Errorf("allow=%v: %d helpers", allow, helpers)
		}
	}
}

// An instruction sent mid step reaches the agent at its next checkpoint within a few seconds,
// whatever step comes next, so Mabari can relay the reply quickly.
func TestAnInstructionMidStepLandsWithinSeconds(t *testing.T) {
	for seed := uint32(1); seed <= 20; seed++ {
		sim, engine, c, _ := setup(t, ":memory:", seed)
		if err := sim.LoadDemo(); err != nil {
			t.Fatal(err)
		}
		var ledger *models.LiveAgent
		_ = engine.Do(func() {
			for _, agent := range engine.Agents() {
				if agent.Name == "Ledger" {
					ledger = agent
				}
			}
			sim.Instruct(ledger, "Also round the totals to whole cents")
		})
		if len(ledger.Queued) != 1 {
			t.Fatalf("seed %d: Ledger should be mid step: %v %+v", seed, ledger.State, ledger.Queued)
		}
		advance(t, sim, c, 3)
		var asked []models.Instruction
		_ = engine.Do(func() { asked = engine.Agent(ledger.ID).Asked })
		if len(asked) == 0 || asked[len(asked)-1].Reply == "" {
			t.Errorf("seed %d: not answered after 3 ticks: %+v", seed, asked)
		}
	}
}
