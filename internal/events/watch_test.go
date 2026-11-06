// SPDX-License-Identifier: Apache-2.0

package events

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

// told is a connector that only remembers what it was told, so a test can see which agent an
// instruction reached and that it came through Instruct, the one path every instruction takes.
type told struct {
	heard map[string][]string
}

func newTold() *told { return &told{heard: map[string][]string{}} }

func (c *told) Start() {}
func (c *told) Stop()  {}
func (c *told) Instruct(agent *models.LiveAgent, text string) {
	c.heard[agent.ID] = append(c.heard[agent.ID], text)
}
func (c *told) Decide(*models.LiveAgent, models.Approval) {}
func (c *told) Interrupt(*models.LiveAgent)               {}
func (c *told) Continue(*models.LiveAgent)                {}
func (c *told) StopAgent(*models.LiveAgent)               {}
func (c *told) Retry(*models.LiveAgent)                   {}
func (c *told) AddSubagent(*models.LiveAgent, string, string, string) *models.LiveAgent {
	return nil
}
func (c *told) Models() []string { return nil }

func watchOffice(t *testing.T) (*Engine, *told, *Subscription) {
	t.Helper()
	engine := newEngine(t)
	connector := newTold()
	engine.AddConnector("test", connector)
	return engine, connector, engine.Subscribe(Resume{}).Sub
}

func member(id, name string, state models.AgentState) *models.LiveAgent {
	agent := &models.LiveAgent{Agent: models.Agent{ID: id, Name: name, Source: "test"}}
	agent.State, agent.Task = state, "Task of "+name
	return agent
}

// drain returns every message waiting for the subscriber.
func drain(sub *Subscription) []models.ServerMessage {
	var out []models.ServerMessage
	for {
		select {
		case message, open := <-sub.C:
			if !open {
				return out
			}
			out = append(out, message)
		default:
			return out
		}
	}
}

func firedBy(messages []models.ServerMessage) []models.WatchFired {
	var out []models.WatchFired
	for _, message := range messages {
		if message.Type == models.MsgWatchFired {
			out = append(out, *message.Fired)
		}
	}
	return out
}

func mustWatch(t *testing.T, engine *Engine, request WatchRequest) WatchSet {
	t.Helper()
	var set WatchSet
	var err error
	_ = engine.Do(func() { set, err = engine.SetWatch(request) })
	if err != nil {
		t.Fatalf("SetWatch(%+v) = %v", request, err)
	}
	return set
}

func setState(engine *Engine, agent *models.LiveAgent, state models.AgentState) {
	_ = engine.Do(func() {
		agent.State = state
		engine.Touch(agent)
	})
}

// A watch on an agent fires once, when the agent is done, says so, and clears itself.
func TestAWatchFiresOnceWhenTheAgentIsDone(t *testing.T) {
	engine, _, sub := watchOffice(t)
	ledger := member("a1", "Ledger", models.StateEditing)
	_ = engine.Do(func() { engine.AddAgent(ledger) })
	set := mustWatch(t, engine, WatchRequest{Kind: models.WatchAgent, Target: "a1"})
	if set.Watch == nil || set.Already != "" {
		t.Fatalf("set = %+v", set)
	}
	drain(sub)

	// Still working: nothing yet.
	setState(engine, ledger, models.StateReading)
	if fired := firedBy(drain(sub)); len(fired) != 0 {
		t.Fatalf("fired while it worked: %+v", fired)
	}
	setState(engine, ledger, models.StateDone)
	fired := firedBy(drain(sub))
	if len(fired) != 1 || fired[0].Outcome != models.WatchDone || fired[0].AgentID != "a1" {
		t.Fatalf("fired = %+v", fired)
	}
	if fired[0].Text != "Ledger is done: Task of Ledger." {
		t.Errorf("text = %q", fired[0].Text)
	}
	// A notification names who, and nothing of the work.
	if fired[0].Notice != "Ledger is done" || strings.Contains(fired[0].Notice, "Task") {
		t.Errorf("notice = %q", fired[0].Notice)
	}
	var left []models.Watch
	_ = engine.Do(func() { left = engine.Watches() })
	if len(left) != 0 {
		t.Errorf("a watch that fired stays: %+v", left)
	}
	// Once only: being done again, after more work, doesn't fire it again.
	setState(engine, ledger, models.StateEditing)
	setState(engine, ledger, models.StateDone)
	if fired := firedBy(drain(sub)); len(fired) != 0 {
		t.Errorf("fired twice: %+v", fired)
	}
	row := logRow(t, engine, "Watch fired")
	if row.Agent != "Mabari" || row.Outcome != "Told you" || row.Chip != "ok" {
		t.Errorf("log = %+v", row)
	}
}

// An error ends a watch too, and says so. It is not red: a watch is calm.
func TestAWatchFiresWhenTheAgentStopsWithAnError(t *testing.T) {
	engine, _, sub := watchOffice(t)
	mori := member("a1", "Mori", models.StateRunning)
	_ = engine.Do(func() { engine.AddAgent(mori) })
	mustWatch(t, engine, WatchRequest{Kind: models.WatchAgent, Target: "a1"})
	drain(sub)
	_ = engine.Do(func() {
		mori.State, mori.Error = models.StateError, "Lost connection to the embedding service."
		engine.Touch(mori)
	})
	fired := firedBy(drain(sub))
	if len(fired) != 1 || fired[0].Outcome != models.WatchFailed {
		t.Fatalf("fired = %+v", fired)
	}
	if want := "Mori stopped with an error: Lost connection to the embedding service."; fired[0].Text != want {
		t.Errorf("text = %q, want %q", fired[0].Text, want)
	}
	if fired[0].Notice != "Mori stopped with an error" {
		t.Errorf("notice = %q", fired[0].Notice)
	}
	if row := logRow(t, engine, "Watch fired"); row.Chip == "red" {
		t.Errorf("a watch that ends in an error must stay calm: %+v", row)
	}
}

// If the thing has already finished, there is nothing to wait for, and no watch is made.
func TestWatchingFinishedWorkMakesNoWatch(t *testing.T) {
	engine, _, _ := watchOffice(t)
	done := member("a1", "Rune", models.StateDone)
	stopped := member("a2", "Mori", models.StateError)
	_ = engine.Do(func() {
		engine.AddAgent(done)
		engine.AddAgent(stopped)
	})
	if set := mustWatch(t, engine, WatchRequest{Kind: models.WatchAgent, Target: "a1"}); set.Already != models.WatchDone || set.Watch != nil {
		t.Errorf("a finished agent: %+v", set)
	}
	if set := mustWatch(t, engine, WatchRequest{Kind: models.WatchAgent, Target: "a2"}); set.Already != models.WatchFailed || set.Watch != nil {
		t.Errorf("an agent stopped by an error: %+v", set)
	}
	var watches []models.Watch
	_ = engine.Do(func() { watches = engine.Watches() })
	if len(watches) != 0 {
		t.Errorf("watches = %+v", watches)
	}
}

// Asking again changes nothing, and gives the one watch there is.
func TestWatchingTheSameThingTwiceKeepsOneWatch(t *testing.T) {
	engine, _, _ := watchOffice(t)
	_ = engine.Do(func() {
		engine.AddAgent(member("a1", "Ledger", models.StateEditing))
		engine.AddAgent(member("a2", "Quill", models.StateIdle))
	})
	first := mustWatch(t, engine, WatchRequest{Kind: models.WatchAgent, Target: "a1"})
	again := mustWatch(t, engine, WatchRequest{Kind: models.WatchAgent, Target: "a1"})
	if !again.Kept || again.Watch.ID != first.Watch.ID {
		t.Errorf("again = %+v", again)
	}
	// A watch that asks for an instruction replaces a plain one, and a plain request after it
	// doesn't take the instruction away.
	chain := mustWatch(t, engine, WatchRequest{Kind: models.WatchAgent, Target: "a1", ThenAgent: "a2", ThenText: "review it"})
	if chain.Watch.ID != first.Watch.ID || chain.Watch.Then == nil || chain.Watch.Then.AgentName != "Quill" {
		t.Errorf("chain = %+v", chain)
	}
	plain := mustWatch(t, engine, WatchRequest{Kind: models.WatchAgent, Target: "a1"})
	if !plain.Kept || plain.Watch.Then == nil {
		t.Errorf("a plain request dropped the instruction: %+v", plain)
	}
	var watches []models.Watch
	_ = engine.Do(func() { watches = engine.Watches() })
	if len(watches) != 1 {
		t.Errorf("watches = %+v", watches)
	}
}

// The instruction goes to the named agent through its connector's Instruct, once, when the work
// is done, and is logged.
func TestAWatchPassesItsInstructionOnWhenDone(t *testing.T) {
	engine, connector, sub := watchOffice(t)
	ledger, quill := member("a1", "Ledger", models.StateEditing), member("a2", "Quill", models.StateIdle)
	_ = engine.Do(func() {
		engine.AddAgent(ledger)
		engine.AddAgent(quill)
	})
	mustWatch(t, engine, WatchRequest{Kind: models.WatchAgent, Target: "a1", ThenAgent: "a2", ThenText: "  review it  "})
	drain(sub)
	setState(engine, quill, models.StateThinking)
	if len(connector.heard["a2"]) != 0 {
		t.Fatalf("told before it was done: %v", connector.heard)
	}
	setState(engine, ledger, models.StateDone)
	if got := connector.heard["a2"]; len(got) != 1 || got[0] != "review it" {
		t.Fatalf("Quill was told %v", got)
	}
	if len(connector.heard["a1"]) != 0 {
		t.Errorf("the watched agent was told %v", connector.heard["a1"])
	}
	fired := firedBy(drain(sub))
	if len(fired) != 1 || fired[0].Text != "Ledger is done: Task of Ledger. I told Quill “review it”." {
		t.Fatalf("fired = %+v", fired)
	}
	// What the instruction says stays out of a desktop notification.
	if fired[0].Notice != "Ledger is done" {
		t.Errorf("notice = %q", fired[0].Notice)
	}
	row := logRow(t, engine, "Watch fired")
	if row.Outcome != "Told you. Sent to Quill." || row.Chip != "ok" {
		t.Errorf("log = %+v", row)
	}
	// Once: Ledger being done again tells Quill nothing more.
	setState(engine, ledger, models.StateEditing)
	setState(engine, ledger, models.StateDone)
	if got := connector.heard["a2"]; len(got) != 1 {
		t.Errorf("told twice: %v", got)
	}
}

// An agent that ends in an error doesn't pass the instruction on, and the person is told so.
func TestAnErrorStopsTheInstructionAndSaysSo(t *testing.T) {
	engine, connector, sub := watchOffice(t)
	ledger, quill := member("a1", "Ledger", models.StateEditing), member("a2", "Quill", models.StateIdle)
	_ = engine.Do(func() {
		engine.AddAgent(ledger)
		engine.AddAgent(quill)
	})
	mustWatch(t, engine, WatchRequest{Kind: models.WatchAgent, Target: "a1", ThenAgent: "a2", ThenText: "review it"})
	drain(sub)
	_ = engine.Do(func() {
		ledger.State, ledger.Error = models.StateError, "Tests crashed"
		engine.Touch(ledger)
	})
	if len(connector.heard["a2"]) != 0 {
		t.Fatalf("Quill was told %v after an error", connector.heard["a2"])
	}
	fired := firedBy(drain(sub))
	want := "Ledger stopped with an error: Tests crashed. I didn't tell Quill “review it”."
	if len(fired) != 1 || fired[0].Text != want || fired[0].Outcome != models.WatchFailed {
		t.Fatalf("fired = %+v", fired)
	}
	if row := logRow(t, engine, "Watch fired"); row.Outcome != "Told you. Not sent to Quill: Ledger hit an error." {
		t.Errorf("log = %+v", row)
	}
}

// If the agent to tell has gone, it is not sent, and never to anyone else, even one that took the
// same name.
func TestAMissingTargetIsSaidAndNeverReplaced(t *testing.T) {
	engine, connector, sub := watchOffice(t)
	ledger, quill := member("a1", "Ledger", models.StateEditing), member("a2", "Quill", models.StateIdle)
	_ = engine.Do(func() {
		engine.AddAgent(ledger)
		engine.AddAgent(quill)
	})
	mustWatch(t, engine, WatchRequest{Kind: models.WatchAgent, Target: "a1", ThenAgent: "a2", ThenText: "review it"})
	_ = engine.Do(func() {
		engine.RemoveAgent("a2")
		// A new agent takes the name. It is not the one that was meant.
		engine.AddAgent(member("a3", "Quill", models.StateIdle))
	})
	drain(sub)
	setState(engine, ledger, models.StateDone)
	for id, heard := range connector.heard {
		t.Errorf("%s was told %v", id, heard)
	}
	fired := firedBy(drain(sub))
	want := "Ledger is done: Task of Ledger. Quill has left, so I didn't pass on “review it”."
	if len(fired) != 1 || fired[0].Text != want {
		t.Fatalf("fired = %+v", fired)
	}
	if row := logRow(t, engine, "Watch fired"); row.Outcome != "Told you. Not sent to Quill: it has left." {
		t.Errorf("log = %+v", row)
	}
}

// A watch for an agent that isn't there, or an instruction for one, is refused.
func TestSettingAWatchChecksWhoItIsFor(t *testing.T) {
	engine, _, _ := watchOffice(t)
	_ = engine.Do(func() { engine.AddAgent(member("a1", "Ledger", models.StateEditing)) })
	cases := []struct {
		name    string
		request WatchRequest
		want    error
	}{
		{"no such agent", WatchRequest{Kind: models.WatchAgent, Target: "nope"}, ErrWatchSubject},
		{"no such project", WatchRequest{Kind: models.WatchProject, Target: "nope"}, ErrWatchSubject},
		{"unknown kind", WatchRequest{Kind: "office", Target: "a1"}, ErrWatchKind},
		{"no one to tell", WatchRequest{Kind: models.WatchAgent, Target: "a1", ThenAgent: "nope", ThenText: "x"}, ErrWatchThenAgent},
		{"nothing to tell", WatchRequest{Kind: models.WatchAgent, Target: "a1", ThenAgent: "a1", ThenText: "  "}, ErrWatchThenText},
		{"too much to tell", WatchRequest{Kind: models.WatchAgent, Target: "a1", ThenAgent: "a1", ThenText: strings.Repeat("x", WatchTextMax+1)}, ErrWatchThenText},
		{"text with no one to tell", WatchRequest{Kind: models.WatchAgent, Target: "a1", ThenText: "review it"}, ErrWatchThenAgent},
	}
	for _, tc := range cases {
		var err error
		_ = engine.Do(func() { _, err = engine.SetWatch(tc.request) })
		if !errors.Is(err, tc.want) {
			t.Errorf("%s: err = %v, want %v", tc.name, err, tc.want)
		}
	}
	var watches []models.Watch
	_ = engine.Do(func() { watches = engine.Watches() })
	if len(watches) != 0 {
		t.Errorf("a refused watch was kept: %+v", watches)
	}
}

// Cancelling stops a watch, and cancelling only the instruction keeps the watch.
func TestCancellingAWatchAndItsInstruction(t *testing.T) {
	engine, connector, sub := watchOffice(t)
	ledger, quill := member("a1", "Ledger", models.StateEditing), member("a2", "Quill", models.StateIdle)
	_ = engine.Do(func() {
		engine.AddAgent(ledger)
		engine.AddAgent(quill)
	})
	set := mustWatch(t, engine, WatchRequest{Kind: models.WatchAgent, Target: "a1", ThenAgent: "a2", ThenText: "review it"})
	var err error
	var kept models.Watch
	_ = engine.Do(func() { kept, err = engine.CancelWatchThen(set.Watch.ID) })
	if err != nil || kept.Then != nil {
		t.Fatalf("cancel instruction = %+v %v", kept, err)
	}
	drain(sub)
	// The watch stays, so the person is still told, and Quill is not.
	setState(engine, ledger, models.StateDone)
	if len(connector.heard["a2"]) != 0 {
		t.Errorf("Quill was told %v after the instruction was cancelled", connector.heard["a2"])
	}
	if fired := firedBy(drain(sub)); len(fired) != 1 || strings.Contains(fired[0].Text, "Quill") {
		t.Errorf("fired = %+v", fired)
	}

	// Cancelling the whole watch means nothing fires at all.
	setState(engine, ledger, models.StateEditing)
	again := mustWatch(t, engine, WatchRequest{Kind: models.WatchAgent, Target: "a1", ThenAgent: "a2", ThenText: "review it"})
	_ = engine.Do(func() { _, err = engine.CancelWatch(again.Watch.ID) })
	if err != nil {
		t.Fatal(err)
	}
	drain(sub)
	setState(engine, ledger, models.StateDone)
	if len(connector.heard["a2"]) != 0 || len(firedBy(drain(sub))) != 0 {
		t.Error("a cancelled watch fired")
	}
	_ = engine.Do(func() { _, err = engine.CancelWatch(again.Watch.ID) })
	if !errors.Is(err, ErrNoWatch) {
		t.Errorf("cancelling twice = %v", err)
	}
}

// A watch clears itself, quietly, when its agent leaves, and with it the instruction it carried.
func TestAWatchClearsWhenItsAgentLeaves(t *testing.T) {
	engine, connector, sub := watchOffice(t)
	_ = engine.Do(func() {
		engine.AddAgent(member("a1", "Ledger", models.StateEditing))
		engine.AddAgent(member("a2", "Quill", models.StateIdle))
	})
	mustWatch(t, engine, WatchRequest{Kind: models.WatchAgent, Target: "a1", ThenAgent: "a2", ThenText: "review it"})
	drain(sub)
	_ = engine.Do(func() { engine.RemoveAgent("a1") })
	var left []models.Watch
	_ = engine.Do(func() { left = engine.Watches() })
	if len(left) != 0 {
		t.Errorf("watches = %+v", left)
	}
	messages := drain(sub)
	if len(firedBy(messages)) != 0 || len(connector.heard) != 0 {
		t.Errorf("a watch that was cleared fired: %+v %v", messages, connector.heard)
	}
	var sawWatches bool
	for _, message := range messages {
		if message.Type == models.MsgWatches && len(message.Watches) == 0 {
			sawWatches = true
		}
	}
	if !sawWatches {
		t.Error("pages were not told the watch was gone")
	}
}

// Watches live on the server, so they survive a restart and still fire after it.
func TestWatchesSurviveARestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "mabari.db")
	s, err := store.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	engine, err := New(ctx, s, nil)
	if err != nil {
		t.Fatal(err)
	}
	engine.AddConnector("test", newTold())
	_ = engine.Do(func() {
		engine.AddAgent(member("a1", "Ledger", models.StateEditing))
		engine.AddAgent(member("a2", "Quill", models.StateIdle))
	})
	mustWatch(t, engine, WatchRequest{Kind: models.WatchAgent, Target: "a1", ThenAgent: "a2", ThenText: "review it"})
	_ = s.Close()

	s, err = store.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	again, err := New(ctx, s, nil)
	if err != nil {
		t.Fatal(err)
	}
	connector := newTold()
	again.AddConnector("test", connector)
	sub := again.Subscribe(Resume{}).Sub
	snapshot := again.Snapshot()
	if len(snapshot.Watches) != 1 || snapshot.Watches[0].Then == nil || snapshot.Watches[0].Then.Text != "review it" {
		t.Fatalf("after a restart: %+v", snapshot.Watches)
	}
	ledger := again.Agent("a1")
	setState(again, ledger, models.StateDone)
	if got := connector.heard["a2"]; len(got) != 1 || got[0] != "review it" {
		t.Errorf("Quill was told %v", got)
	}
	if len(firedBy(drain(sub))) != 1 {
		t.Error("the watch did not fire after the restart")
	}
}

// A wipe takes the watches with everything else.
func TestAWipeClearsWatches(t *testing.T) {
	engine, _, _ := watchOffice(t)
	_ = engine.Do(func() { engine.AddAgent(member("a1", "Ledger", models.StateEditing)) })
	mustWatch(t, engine, WatchRequest{Kind: models.WatchAgent, Target: "a1"})
	_ = engine.Do(engine.Wipe)
	if watches := engine.Snapshot().Watches; len(watches) != 0 {
		t.Errorf("after a wipe: %+v", watches)
	}
}

// A real agent keeps its watch when the demo ends, and a demo agent's goes with it.
func TestAWatchOutlivesTheDemoEndingForARealAgent(t *testing.T) {
	engine, _, _ := watchOffice(t)
	kept, demo := member("a1", "Ledger", models.StateEditing), member("a2", "Scout", models.StateEditing)
	demo.Source = models.SourceDemo
	_ = engine.Do(func() {
		engine.AddAgent(kept)
		engine.AddAgent(demo)
	})
	mustWatch(t, engine, WatchRequest{Kind: models.WatchAgent, Target: "a1"})
	mustWatch(t, engine, WatchRequest{Kind: models.WatchAgent, Target: "a2"})
	_ = engine.Do(func() { engine.ClearDemo() })
	watches := engine.Snapshot().Watches
	if len(watches) != 1 || watches[0].Target != "a1" {
		t.Errorf("watches = %+v", watches)
	}
}

// A project's watch fires when every agent on it has finished: one working, waiting on you,
// asking or interrupted keeps it waiting, idle ones don't.
func TestAProjectWatchFiresWhenEveryAgentHasFinished(t *testing.T) {
	engine, connector, sub := watchOffice(t)
	project := "p1"
	one, two, idle := member("a1", "Ledger", models.StateEditing), member("a2", "Atlas", models.StateEditing), member("a3", "Pixel", models.StateIdle)
	for _, agent := range []*models.LiveAgent{one, two, idle} {
		agent.Project = &project
	}
	elsewhere := member("a4", "Scout", models.StateEditing)
	quill := member("a5", "Quill", models.StateIdle)
	_ = engine.Do(func() {
		engine.SaveProject(models.Project{ID: "p1", Name: "Checkout revamp"})
		for _, agent := range []*models.LiveAgent{one, two, idle, elsewhere, quill} {
			engine.AddAgent(agent)
		}
	})
	mustWatch(t, engine, WatchRequest{Kind: models.WatchProject, Target: "p1", ThenAgent: "a5", ThenText: "write the release notes"})
	drain(sub)

	setState(engine, one, models.StateDone)
	if len(firedBy(drain(sub))) != 0 {
		t.Fatal("fired while Atlas still worked")
	}
	// Waiting on you is not finished, and neither is a question.
	setState(engine, two, models.StateApproval)
	if len(firedBy(drain(sub))) != 0 {
		t.Fatal("fired while Atlas waited on an approval")
	}
	setState(engine, two, models.StatePaused)
	if len(firedBy(drain(sub))) != 0 {
		t.Fatal("fired while Atlas was interrupted")
	}
	// Another project's agent finishing means nothing here.
	setState(engine, elsewhere, models.StateDone)
	if len(firedBy(drain(sub))) != 0 {
		t.Fatal("fired for an agent on another project")
	}
	setState(engine, two, models.StateDone)
	fired := firedBy(drain(sub))
	if len(fired) != 1 || fired[0].Outcome != models.WatchDone || fired[0].ProjectID != "p1" {
		t.Fatalf("fired = %+v", fired)
	}
	if want := "Checkout revamp is done. Every agent on it has finished. I told Quill “write the release notes”."; fired[0].Text != want {
		t.Errorf("text = %q", fired[0].Text)
	}
	if fired[0].Notice != "Checkout revamp is done" {
		t.Errorf("notice = %q", fired[0].Notice)
	}
	if got := connector.heard["a5"]; len(got) != 1 {
		t.Errorf("Quill was told %v", got)
	}
}

// With every agent stopped and one of them by an error, the project's watch says so, and sends
// nothing.
func TestAProjectWatchWithAnErrorSaysSoAndSendsNothing(t *testing.T) {
	engine, connector, sub := watchOffice(t)
	project := "p1"
	good, bad := member("a1", "Ledger", models.StateEditing), member("a2", "Mori", models.StateEditing)
	good.Project, bad.Project = &project, &project
	quill := member("a3", "Quill", models.StateIdle)
	_ = engine.Do(func() {
		engine.SaveProject(models.Project{ID: "p1", Name: "Docs site"})
		for _, agent := range []*models.LiveAgent{good, bad, quill} {
			engine.AddAgent(agent)
		}
	})
	mustWatch(t, engine, WatchRequest{Kind: models.WatchProject, Target: "p1", ThenAgent: "a3", ThenText: "ship it"})
	drain(sub)
	setState(engine, bad, models.StateError)
	if len(firedBy(drain(sub))) != 0 {
		t.Fatal("fired while Ledger still worked")
	}
	setState(engine, good, models.StateDone)
	fired := firedBy(drain(sub))
	want := "Docs site has stopped. Mori stopped with an error. I didn't tell Quill “ship it”."
	if len(fired) != 1 || fired[0].Text != want || fired[0].Outcome != models.WatchFailed || fired[0].AgentID != "a2" {
		t.Fatalf("fired = %+v", fired)
	}
	if len(connector.heard) != 0 {
		t.Errorf("sent %v after an error", connector.heard)
	}
}

// A project whose agents are all done, or that was marked complete, has nothing left to wait for.
func TestWatchingAFinishedProjectMakesNoWatch(t *testing.T) {
	engine, _, _ := watchOffice(t)
	project := "p1"
	done := member("a1", "Ledger", models.StateDone)
	done.Project = &project
	_ = engine.Do(func() {
		engine.SaveProject(models.Project{ID: "p1", Name: "Checkout revamp"})
		engine.SaveProject(models.Project{ID: "p2", Name: "Landing page", Done: &models.ProjectDone{}})
		engine.AddAgent(done)
	})
	for _, target := range []string{"p1", "p2"} {
		if set := mustWatch(t, engine, WatchRequest{Kind: models.WatchProject, Target: target}); set.Already != models.WatchDone || set.Watch != nil {
			t.Errorf("%s: %+v", target, set)
		}
	}
	// A project with nobody on it has not started, so it is watched.
	_ = engine.Do(func() { engine.SaveProject(models.Project{ID: "p3", Name: "New thing"}) })
	if set := mustWatch(t, engine, WatchRequest{Kind: models.WatchProject, Target: "p3"}); set.Watch == nil {
		t.Errorf("an empty project: %+v", set)
	}
}

// A project that is deleted takes its watch with it.
func TestAProjectWatchClearsWhenTheProjectIsDeleted(t *testing.T) {
	engine, _, _ := watchOffice(t)
	_ = engine.Do(func() { engine.SaveProject(models.Project{ID: "p1", Name: "Checkout revamp"}) })
	mustWatch(t, engine, WatchRequest{Kind: models.WatchProject, Target: "p1"})
	_ = engine.Do(func() { engine.RemoveProject("p1") })
	if watches := engine.Snapshot().Watches; len(watches) != 0 {
		t.Errorf("watches = %+v", watches)
	}
}

// Only so many watches can wait.
func TestWatchesAreLimited(t *testing.T) {
	engine, _, _ := watchOffice(t)
	_ = engine.Do(func() {
		for index := range WatchesMax + 1 {
			engine.SaveProject(models.Project{ID: "p" + string(rune('A'+index/26)) + string(rune('a'+index%26)), Name: "P"})
		}
	})
	var err error
	_ = engine.Do(func() {
		for _, project := range engine.Projects() {
			if _, err = engine.SetWatch(WatchRequest{Kind: models.WatchProject, Target: project.ID}); err != nil {
				return
			}
		}
	})
	if !errors.Is(err, ErrWatchLimit) {
		t.Errorf("err = %v", err)
	}
	if got := len(engine.Snapshot().Watches); got != WatchesMax {
		t.Errorf("%d watches", got)
	}
}
