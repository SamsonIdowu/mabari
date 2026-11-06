// SPDX-License-Identifier: Apache-2.0

package simulator

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"regexp"
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
	sim := New(engine, Mulberry32(seed), 0)
	// Long enough for the golden test; TestTheDemoTurnsItselfOff checks the real length's effect.
	sim.SetDemoLength(24 * time.Hour)
	// The demo's question is the port's own, not the prototype's, and it stops an agent, which would
	// move every random draw the golden test follows. The tests of it turn it on.
	sim.SetDemoQuestion(0)
	return sim, engine, c, s
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

// The demo never outlives Mabari: a restart ends it, takes the simulated agents and the fake
// connections away, and keeps every real agent.
func TestARestartEndsTheDemo(t *testing.T) {
	_, engine, _ := restartedDemo(t, func(_ *Simulator, engine *events.Engine) {
		mine := &models.LiveAgent{}
		mine.Name, mine.Source, mine.Provider = "Juniper", "claude", models.ProviderClaude
		mine.State, mine.Desk = models.StateEditing, 20
		engine.AddAgent(mine)
	})
	snapshot := engine.Snapshot()
	if snapshot.Demo || snapshot.DemoEndsAt != 0 {
		t.Errorf("demo = %v, ends %d", snapshot.Demo, snapshot.DemoEndsAt)
	}
	if len(snapshot.Agents) != 1 || snapshot.Agents[0].Name != "Juniper" {
		t.Fatalf("agents = %+v", snapshot.Agents)
	}
	if len(snapshot.Projects) != 0 {
		t.Errorf("demo projects stayed: %+v", snapshot.Projects)
	}
	for _, account := range snapshot.Accounts {
		if account.Status != models.AccountOff {
			t.Errorf("%s is still %s after the demo", account.Kind, account.Status)
		}
	}
	if active, _ := engine.Store().Meta(context.Background(), store.MetaDemo); active != "0" {
		t.Errorf("demo flag = %q", active)
	}
}

// The demo turns itself off after its time, and stopping it keeps real agents and projects.
func TestTheDemoTurnsItselfOff(t *testing.T) {
	sim, engine, c, _ := setup(t, ":memory:", 1)
	sim.SetDemoLength(10 * time.Second)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	if ends := engine.Snapshot().DemoEndsAt; ends != c.ms+10_000 {
		t.Errorf("ends at %d, want %d", ends, c.ms+10_000)
	}
	_ = engine.Do(func() {
		// A real agent placed in one of the demo's projects stays, and moves out of it.
		checkout := "checkout"
		placed := &models.LiveAgent{}
		placed.Name, placed.Source, placed.Project, placed.Desk = "Hazel", "hub", &checkout, 21
		engine.AddAgent(placed)
		// A project made while the demo ran, with only simulated agents, is the demo's too.
		engine.SaveProject(models.Project{ID: "made-in-demo", Name: "Made in the demo"})
		// A real agent, and the real project it works in, stay.
		work := engine.SaveProject(models.Project{ID: "mine", Name: "My real work"})
		mine := &models.LiveAgent{}
		mine.Name, mine.Source, mine.Provider = "Juniper", "codex", models.ProviderOpenAI
		mine.State, mine.Desk, mine.Project = models.StateEditing, 20, &work.ID
		engine.AddAgent(mine)
	})
	advance(t, sim, c, 12)
	snapshot := engine.Snapshot()
	if snapshot.Demo || len(snapshot.Agents) != 2 || snapshot.Agents[1].Name != "Juniper" {
		t.Fatalf("demo = %v, agents = %+v", snapshot.Demo, snapshot.Agents)
	}
	if hazel := snapshot.Agents[0]; hazel.Project != nil {
		t.Errorf("Hazel is still in %v", *hazel.Project)
	}
	if len(snapshot.Projects) != 1 || snapshot.Projects[0].ID != "mine" {
		t.Errorf("projects = %+v", snapshot.Projects)
	}
	if snapshot.Log[0].Message != "The demo office turned itself off" {
		t.Errorf("log = %+v", snapshot.Log[0])
	}
	// Nothing simulated keeps running once the demo is off.
	advance(t, sim, c, 30)
	if after := engine.Snapshot(); len(after.Agents) != 2 || after.Agents[1].State != models.StateEditing {
		t.Errorf("after: %+v", after.Agents)
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

// The port also logs an agent finishing a task, or stopping with an error, which the prototype
// doesn't, because the "While you were away" recap is built from those rows. The golden test
// counts the rest. A row is one of those when it is a session whose outcome names it.
func prototypeLogRows(log []models.LogEntry) int {
	count := 0
	for _, row := range log {
		if row.Type == models.LogSession && (row.Outcome == models.OutcomeFinished || row.Outcome == models.OutcomeError) {
			continue
		}
		count++
	}
	return count
}

// The port knowingly differs from the prototype in what agents say to each other, in two ways,
// and the golden test sets both aside so everything else is still checked against the prototype.
//
//   - The prototype names a folder as nothing, which makes lines like "touches . Over to you"
//     (FIRST-7); the port names it, "touches test/.".
//   - The prototype counts "give me about 15 min" in office time, which runs several times faster
//     than the clock; the port tells real minutes (FIRST-8).
var (
	folderNames = regexp.MustCompile(`\b(?:test|docs)/`)
	minuteWords = regexp.MustCompile(`about \d+ min\b`)
)

func withoutFolders(text string) string { return folderNames.ReplaceAllString(text, "") }

func withoutMinutes(text string) string { return minuteWords.ReplaceAllString(text, "about N min") }

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
				if agent.Feed[0].Tool == "message" {
					got.Top = withoutMinutes(withoutFolders(got.Top))
					want.Top = withoutMinutes(want.Top)
				}
			}
			// Subagents are contractors, unlike in the prototype: off duty they leave the floor,
			// and back on duty they take the free desk nearest their lead.
			if agent.Lead != nil {
				if (agent.Desk == models.OffFloor) == agent.State.OnDuty() {
					t.Fatalf("tick %d, %s: %s at desk %d", tick, want.Name, agent.State, agent.Desk)
				}
				got.Desk = want.Desk
			}
			if got != want {
				t.Fatalf("tick %d, %s:\n got  %+v\n want %+v", tick, want.Name, got, want)
			}
		}
		if got := len(snapshot.Messages); got != frame.Messages {
			t.Fatalf("tick %d: %d messages, prototype has %d", tick, got, frame.Messages)
		}
		if got := withoutMinutes(withoutFolders(snapshot.Messages[len(snapshot.Messages)-1].Text)); got != withoutMinutes(frame.LastText) {
			t.Fatalf("tick %d: last message %q, prototype has %q", tick, got, frame.LastText)
		}
		if got := prototypeLogRows(snapshot.Log); got != frame.Log {
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

// An agent waits on one approval at a time. A stop, or a second request, settles the earlier one.
func TestNoApprovalIsLeftBehind(t *testing.T) {
	sim, engine, _, _ := setup(t, ":memory:", 1)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	_ = engine.Do(func() {
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

// Interrupt pauses an agent; Continue puts it back in exactly the state it was in, with the rest
// of its step still to run.
func TestContinueResumesTheExactState(t *testing.T) {
	sim, engine, c, _ := setup(t, ":memory:", 3)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	var ledger *models.LiveAgent
	_ = engine.Do(func() {
		ledger = engine.AgentByName("Ledger")
		ledger.State = models.StateRunning
		sim.runtimeOf(ledger).stateLeft = 100
		sim.Interrupt(ledger)
	})
	if ledger.State != models.StatePaused || ledger.PausedFrom != models.StateRunning {
		t.Fatalf("after interrupt: %v from %v", ledger.State, ledger.PausedFrom)
	}
	advance(t, sim, c, 30)
	_ = engine.Do(func() {
		if ledger.State != models.StatePaused {
			t.Fatalf("a paused agent moved on: %v", ledger.State)
		}
		sim.Continue(ledger)
	})
	if ledger.State != models.StateRunning || ledger.PausedFrom != "" {
		t.Errorf("after continue: %v from %q", ledger.State, ledger.PausedFrom)
	}
	if left := sim.runtimeOf(ledger).stateLeft; left != 100 {
		t.Errorf("step left = %v, want the 100 it had", left)
	}
}

// Ending the demo keeps a real agent's waiting instructions, approval and steps in the database,
// and the demo never made a real agent ask for approval or talk.
func TestEndingTheDemoKeepsRealAgentsRecords(t *testing.T) {
	sim, engine, c, s := setup(t, ":memory:", 1)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	var mine *models.LiveAgent
	_ = engine.Do(func() {
		mine = &models.LiveAgent{}
		mine.ID, mine.Name, mine.Source, mine.Provider = "cc-real", "Shop", "claude", models.ProviderClaude
		mine.State, mine.Desk = models.StateEditing, 20
		engine.AddAgent(mine)
		engine.AddEvent(mine, "Edit", "Edit cart.ts", nil)
		engine.Queue(mine, "Also add a test")
		engine.Converse(mine.ID, models.ConversationItem{Kind: models.ConversationUser, Text: "Fix the cart"})
	})
	advance(t, sim, c, 120)
	if got := engine.Snapshot().Messages; slices.ContainsFunc(got, func(m models.Message) bool {
		return m.From == "cc-real" || slices.Contains(m.To, "cc-real")
	}) {
		t.Error("the demo made the real agent talk")
	}
	_ = engine.Do(sim.StopDemo)
	ctx := context.Background()
	if waiting, _ := s.WaitingInstructions(ctx, "cc-real"); len(waiting) != 1 {
		t.Errorf("waiting instructions = %+v", waiting)
	}
	if events, _ := s.Events(ctx, "cc-real", 10, 0); len(events) == 0 || events[0].Summary != "Edit cart.ts" {
		t.Errorf("events = %+v", events)
	}
	if items, _, _ := s.Conversation(ctx, "cc-real", 0, 10); len(items) != 1 || items[0].Text != "Fix the cart" {
		t.Errorf("conversation = %+v", items)
	}
	// The next step's id carries on instead of repeating one.
	_ = engine.Do(func() {
		event := engine.AddEvent(mine, "Read", "Read cart.ts", nil)
		if event.ID == mine.Feed[1].ID {
			t.Errorf("repeated id %s", event.ID)
		}
	})
	// A tick that arrives after the end does nothing.
	advance(t, sim, c, 10)
	if after := engine.Snapshot(); len(after.Agents) != 1 || after.Agents[0].State != models.StateEditing {
		t.Errorf("after: %+v", after.Agents)
	}
}

// The demo only shows its pretend sign ins; the stored accounts stay as they really are.
func TestTheDemoOnlyShowsItsSignIns(t *testing.T) {
	sim, engine, _, _ := setup(t, ":memory:", 1)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	_ = engine.Do(func() {
		for _, account := range engine.Accounts() {
			if (account.Kind == models.AccountCodex || account.Kind == models.AccountClaudeCode) &&
				account.Status != models.AccountConnected {
				t.Errorf("%s isn't shown as connected in the demo", account.Kind)
			}
		}
		for _, account := range engine.StoredAccounts() {
			if account.Status != models.AccountOff {
				t.Errorf("%s was stored as %s", account.Kind, account.Status)
			}
		}
		sim.StopDemo()
		for _, account := range engine.Accounts() {
			if account.Status != models.AccountOff {
				t.Errorf("%s is %s after the demo", account.Kind, account.Status)
			}
		}
	})
}
