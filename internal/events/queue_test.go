// SPDX-License-Identifier: Apache-2.0

package events

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

func logRow(t *testing.T, engine *Engine, text string) models.LogEntry {
	t.Helper()
	rows, err := engine.Store().Log(context.Background(), store.LogQuery{Search: text})
	if err != nil || len(rows) != 1 {
		t.Fatalf("log for %q = %+v %v", text, rows, err)
	}
	return rows[0]
}

// A queued instruction can be taken back before its checkpoint, and then never arrives.
func TestUnqueueTakesBackAWaitingInstruction(t *testing.T) {
	engine := newEngine(t)
	agent := &models.LiveAgent{Agent: models.Agent{ID: "a1", Name: "Ledger"}}
	var first, second models.Instruction
	_ = engine.Do(func() {
		engine.AddAgent(agent)
		engine.Queue(agent, "Add a test")
		engine.Queue(agent, "Update the docs")
		first, second = agent.Queued[0], agent.Queued[1]
		if holder, ok := engine.Unqueue(first.ID); !ok || holder != "Ledger" {
			t.Errorf("unqueue = %q %v", holder, ok)
		}
		if _, ok := engine.Unqueue(first.ID); ok {
			t.Error("removed twice")
		}
		next, _ := engine.NextQueued(agent)
		if next.ID != second.ID {
			t.Errorf("delivered %q", next.Text)
		}
		// Once delivered, it can't be taken back.
		if _, ok := engine.Unqueue(second.ID); ok {
			t.Error("took back a delivered instruction")
		}
	})
	if len(agent.Queued) != 0 {
		t.Errorf("queued = %+v", agent.Queued)
	}
	if row := logRow(t, engine, "Add a test"); row.Outcome != "Removed before delivery" || row.Chip != "" {
		t.Errorf("log = %+v", row)
	}
}

// A removed instruction stays removed after a restart.
func TestARemovedInstructionDoesNotComeBack(t *testing.T) {
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
	agent := &models.LiveAgent{Agent: models.Agent{ID: "a1", Name: "Ledger"}}
	_ = engine.Do(func() {
		engine.AddAgent(agent)
		engine.Queue(agent, "Keep me")
		engine.Queue(agent, "Drop me")
		engine.Unqueue(agent.Queued[1].ID)
	})
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
	reloaded := again.Agent("a1")
	if reloaded == nil || len(reloaded.Queued) != 1 || reloaded.Queued[0].Text != "Keep me" {
		t.Fatalf("after a restart: %+v", reloaded)
	}
}

// A prompt Mabari opened Claude Code with goes to the session that reports it as its first
// prompt, and only to that one.
func TestOpeningPromptsGoToTheSessionStartedWithThem(t *testing.T) {
	engine := newEngine(t)
	var audit, review models.Instruction
	_ = engine.Do(func() {
		engine.SaveProject(models.Project{ID: "p1", Name: "Shop"})
		audit = engine.Opening(engine.Project("p1"), "/ux-audit https://example.com")
		review = engine.Opening(engine.Project("p1"), "/review")
		// An opened prompt can't be taken back: Claude Code already has it.
		if _, ok := engine.Unqueue(audit.ID); ok {
			t.Error("took back a prompt Claude Code was opened with")
		}
		id := "p1"
		elsewhere := &models.LiveAgent{Agent: models.Agent{ID: "a0", Name: "Other"}}
		engine.AddAgent(elsewhere)
		if engine.TakeOpening(elsewhere, "/review") {
			t.Error("a session outside the project took a prompt")
		}
		byHand := &models.LiveAgent{Agent: models.Agent{ID: "a1", Name: "Shop", Project: &id}}
		engine.AddAgent(byHand)
		if engine.TakeOpening(byHand, "what does this repo do?") {
			t.Error("a session started by hand took a prompt")
		}
		second := &models.LiveAgent{Agent: models.Agent{ID: "a2", Name: "Shop 2", Project: &id}}
		engine.AddAgent(second)
		if !engine.TakeOpening(second, "  /review ") {
			t.Fatal("the session opened with /review didn't get it")
		}
		if len(second.Asked) != 1 || second.Asked[0].ID != review.ID || second.Asked[0].Status != models.InstructionDelivered {
			t.Errorf("asked = %+v", second.Asked)
		}
		if left := engine.Project("p1").Opening; len(left) != 1 || left[0].ID != audit.ID {
			t.Errorf("still opening: %+v", left)
		}
	})
	if row := logRow(t, engine, "/review"); row.Outcome != "Delivered when the session started" {
		t.Errorf("log = %+v", row)
	}
}

// A prompt left waiting too long for its session is dropped by the sweep.
func TestOldOpeningPromptsAreDropped(t *testing.T) {
	engine := newEngine(t)
	_ = engine.Do(func() {
		engine.SaveProject(models.Project{ID: "p1", Name: "Shop"})
		engine.Opening(engine.Project("p1"), "Stale")
		engine.Project("p1").Opening[0].Time -= models.OpeningKept + 1
		engine.Opening(engine.Project("p1"), "Fresh")
		engine.Sweep()
		if left := engine.Project("p1").Opening; len(left) != 1 || left[0].Text != "Fresh" {
			t.Errorf("opening = %+v", left)
		}
	})
	if row := logRow(t, engine, "Stale"); row.Outcome != "Claude Code never reported back" {
		t.Errorf("log = %+v", row)
	}
}

// An agent that leaves settles what it was still waiting for.
func TestRemovingAnAgentSettlesItsQueue(t *testing.T) {
	engine := newEngine(t)
	_ = engine.Do(func() {
		agent := &models.LiveAgent{Agent: models.Agent{ID: "a1", Name: "Ledger"}}
		engine.AddAgent(agent)
		engine.Queue(agent, "Orphan")
		engine.RemoveAgent("a1")
	})
	if row := logRow(t, engine, "Orphan"); row.Chip == "amber" {
		t.Errorf("log = %+v", row)
	}
}
