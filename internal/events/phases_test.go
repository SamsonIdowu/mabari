// SPDX-License-Identifier: Apache-2.0

package events

import (
	"context"
	"math"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

func (c *clock) advance(d time.Duration) { c.now = c.now.Add(d) }
func (c *clock) millis() int64           { return c.now.UnixMilli() }
func startOfTest() *clock                { return &clock{now: time.UnixMilli(1_800_000_000_000)} }

// phases reads back what was recorded, as "name:minutes:phase" with minutes since the start.
func phases(t *testing.T, engine *Engine, from int64) []string {
	t.Helper()
	changes, err := engine.Store().StateChanges(context.Background(), 0, math.MaxInt64)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, change := range changes {
		out = append(out, change.Agent+":"+strconv.FormatInt((change.Time-from)/60000, 10)+":"+string(change.Phase))
	}
	return out
}

func logged(t *testing.T, engine *Engine, query store.LogQuery) []models.LogEntry {
	t.Helper()
	rows, err := engine.Store().Log(context.Background(), query)
	if err != nil {
		t.Fatal(err)
	}
	return rows
}

func agentNamed(name string, state models.AgentState) *models.LiveAgent {
	agent := &models.LiveAgent{Agent: models.Agent{ID: "id-" + strings.ToLower(name), Name: name}}
	agent.State, agent.Task = state, "Task of "+name
	return agent
}

// Only a change of phase is written down: moving from reading to editing is still work.
func TestPhasesAreRecordedWhenTheyChange(t *testing.T) {
	c := startOfTest()
	start := c.millis()
	engine := engineAt(t, c)
	atlas := agentNamed("Atlas", models.StateReading)
	_ = engine.Do(func() { engine.AddAgent(atlas) })
	for _, step := range []struct {
		after time.Duration
		to    models.AgentState
	}{
		{10 * time.Minute, models.StateEditing},  // still work
		{5 * time.Minute, models.StateApproval},  // waits on you
		{20 * time.Minute, models.StateThinking}, // you decided
		{15 * time.Minute, models.StateDone},
	} {
		c.advance(step.after)
		_ = engine.Do(func() { atlas.State = step.to; engine.Touch(atlas) })
	}
	want := []string{"Atlas:0:working", "Atlas:15:approval", "Atlas:35:working", "Atlas:50:done"}
	if got := phases(t, engine, start); strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("phases = %v, want %v", got, want)
	}
}

// A question puts the agent in its own phase, whatever state it was in when it asked.
func TestAQuestionIsAPhaseOfItsOwn(t *testing.T) {
	c := startOfTest()
	start := c.millis()
	engine := engineAt(t, c)
	atlas := agentNamed("Atlas", models.StateEditing)
	_ = engine.Do(func() { engine.AddAgent(atlas) })
	c.advance(4 * time.Minute)
	_ = engine.Do(func() { atlas.Question = &models.Question{ID: "q"}; engine.Touch(atlas) })
	c.advance(6 * time.Minute)
	_ = engine.Do(func() { atlas.Question = nil; engine.Touch(atlas) })
	want := "Atlas:0:working Atlas:4:question Atlas:10:working"
	if got := strings.Join(phases(t, engine, start), " "); got != want {
		t.Errorf("phases = %s, want %s", got, want)
	}
}

// Nothing says "finished" or "stopped" in the log today, so this does, for every connector.
func TestFinishingAndErroringAreLogged(t *testing.T) {
	c := startOfTest()
	engine := engineAt(t, c)
	// One already done when first seen finished nothing in front of us. One already in error too.
	resting := agentNamed("Rune", models.StateDone)
	broken := agentNamed("Mori", models.StateError)
	working := agentNamed("Atlas", models.StateEditing)
	_ = engine.Do(func() {
		engine.AddAgent(resting)
		engine.AddAgent(broken)
		engine.AddAgent(working)
	})
	if rows := logged(t, engine, store.LogQuery{Type: models.LogSession}); len(rows) != 0 {
		t.Fatalf("agents first seen done or in error were announced: %+v", rows)
	}

	c.advance(time.Minute)
	_ = engine.Do(func() {
		working.State, working.Progress = models.StateDone, 1
		engine.Touch(working)
	})
	finished := logged(t, engine, store.LogQuery{Outcome: models.OutcomeFinished})
	if len(finished) != 1 || finished[0].Agent != "Atlas" || finished[0].Message != "Finished: Task of Atlas" ||
		finished[0].Chip != "ok" || finished[0].Type != models.LogSession {
		t.Errorf("finished = %+v", finished)
	}

	// Staying done, or touching the agent again, says nothing more.
	_ = engine.Do(func() { engine.Touch(working) })
	if rows := logged(t, engine, store.LogQuery{Outcome: models.OutcomeFinished}); len(rows) != 1 {
		t.Errorf("finished twice: %+v", rows)
	}

	_ = engine.Do(func() {
		working.State, working.Error = models.StateError, "Lost the connection"
		engine.Touch(working)
	})
	failed := logged(t, engine, store.LogQuery{Outcome: models.OutcomeError})
	if len(failed) != 1 || failed[0].Message != "Stopped by an error: Lost the connection" || failed[0].Chip != "red" {
		t.Errorf("errors = %+v", failed)
	}
}

// Subagents are helpers inside a lead's task: they don't get lanes or finish announcements.
func TestSubagentsAreNotTracked(t *testing.T) {
	c := startOfTest()
	engine := engineAt(t, c)
	lead := agentNamed("Atlas", models.StateEditing)
	helper := agentNamed("Atlas scribe", models.StateEditing)
	helper.Lead = &lead.ID
	_ = engine.Do(func() { engine.AddAgent(lead); engine.AddAgent(helper) })
	c.advance(time.Minute)
	_ = engine.Do(func() { helper.State = models.StateDone; engine.Touch(helper) })
	for _, line := range phases(t, engine, c.millis()) {
		if strings.HasPrefix(line, "Atlas scribe") {
			t.Errorf("a subagent was recorded: %s", line)
		}
	}
	if rows := logged(t, engine, store.LogQuery{Type: models.LogSession}); len(rows) != 0 {
		t.Errorf("a subagent finishing was announced: %+v", rows)
	}
}

// An agent that leaves stops its block, so the timeline doesn't show it working for ever.
func TestAnAgentThatLeavesIsClosed(t *testing.T) {
	c := startOfTest()
	start := c.millis()
	engine := engineAt(t, c)
	atlas := agentNamed("Atlas", models.StateEditing)
	_ = engine.Do(func() { engine.AddAgent(atlas) })
	c.advance(9 * time.Minute)
	_ = engine.Do(func() { engine.RemoveAgent(atlas.ID) })
	if got := strings.Join(phases(t, engine, start), " "); got != "Atlas:0:working Atlas:9:off" {
		t.Errorf("phases = %s", got)
	}
}

// After a restart, what was happening when the server stopped is closed at the last moment it was
// known to be running, not stretched across the time it was down.
func TestARestartClosesWhatWasOpenAtTheLastMomentAlive(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "mabari.db")
	c := startOfTest()
	start := c.millis()

	first, err := store.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	engine, err := New(ctx, first, c.read)
	if err != nil {
		t.Fatal(err)
	}
	atlas := agentNamed("Atlas", models.StateEditing)
	done := agentNamed("Rune", models.StateDone)
	_ = engine.Do(func() { engine.AddAgent(atlas); engine.AddAgent(done) })
	c.advance(20 * time.Minute)
	_ = engine.Do(engine.noteAlive)
	_ = first.Close()

	// Three hours pass with Mabari stopped.
	c.advance(3 * time.Hour)
	second, err := store.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = second.Close() })
	reopened, err := New(ctx, second, c.read)
	if err != nil {
		t.Fatal(err)
	}
	want := "Atlas:0:working Rune:0:done Atlas:20:off Atlas:200:working"
	if got := strings.Join(phases(t, reopened, start), " "); got != want {
		t.Errorf("phases = %s, want %s", got, want)
	}
	// Coming back is not news: nothing finished or failed while it was away.
	if rows := logged(t, reopened, store.LogQuery{Type: models.LogSession}); len(rows) != 0 {
		t.Errorf("restarting announced: %+v", rows)
	}
}

// An agent that left while the server was down is closed too, at the last time it was alive.
func TestAnAgentGoneAfterARestartIsClosed(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "mabari.db")
	c := startOfTest()
	start := c.millis()
	first, err := store.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	engine, err := New(ctx, first, c.read)
	if err != nil {
		t.Fatal(err)
	}
	atlas := agentNamed("Atlas", models.StateEditing)
	_ = engine.Do(func() { engine.AddAgent(atlas) })
	c.advance(7 * time.Minute)
	_ = engine.Do(engine.noteAlive)
	// The agent's row is removed behind the engine's back, as a crash between saves could leave it.
	if err := first.DeleteAgent(ctx, atlas.ID); err != nil {
		t.Fatal(err)
	}
	_ = first.Close()
	c.advance(time.Hour)
	second, err := store.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = second.Close() })
	reopened, err := New(ctx, second, c.read)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(phases(t, reopened, start), " "); got != "Atlas:0:working Atlas:7:off" {
		t.Errorf("phases = %s", got)
	}
}
