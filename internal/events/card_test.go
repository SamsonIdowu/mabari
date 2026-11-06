// SPDX-License-Identifier: Apache-2.0

package events

import (
	"context"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

// clock is a time the test moves by hand, on a day in the middle of the afternoon so that no
// test crosses midnight.
type clock struct{ now time.Time }

func (c *clock) read() time.Time { return c.now }

func (c *clock) pass(d time.Duration) { c.now = c.now.Add(d) }

func engineAt(t *testing.T, c *clock) *Engine {
	t.Helper()
	ctx := context.Background()
	s, err := store.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	engine, err := New(ctx, s, c.read)
	if err != nil {
		t.Fatal(err)
	}
	return engine
}

func work(t *testing.T, engine *Engine, agent *models.LiveAgent, state models.AgentState) {
	t.Helper()
	if err := engine.Do(func() {
		agent.State = state
		engine.Touch(agent)
	}); err != nil {
		t.Fatal(err)
	}
}

// The engine keeps each agent's day from the states it sees, whatever connector reports them, and
// the card reads it: tasks finished today and the time worked, with the live stretch included.
func TestTheCardCountsTheDaysTasksAndTime(t *testing.T) {
	c := &clock{time.Date(2026, time.November, 6, 14, 0, 0, 0, time.Local)}
	engine := engineAt(t, c)
	agent := &models.LiveAgent{Agent: models.Agent{ID: "a1", Name: "Atlas", Provider: models.ProviderCustom,
		Account: models.AccountHub}}
	agent.State = models.StateIdle
	_ = engine.Do(func() { engine.AddAgent(agent) })

	c.pass(time.Minute)
	work(t, engine, agent, models.StateEditing)
	c.pass(10 * time.Minute)
	work(t, engine, agent, models.StateDone)
	c.pass(time.Minute)
	work(t, engine, agent, models.StateThinking)
	c.pass(5 * time.Minute)

	card, ok := engine.Card("a1")
	if !ok {
		t.Fatal("no card")
	}
	// One task done, 10 minutes of editing, and the 5 so far of the second task.
	if card.FinishedToday != 1 || card.WorkedSeconds != 15*60 {
		t.Errorf("finished %d, worked %d s; want 1 and 900", card.FinishedToday, card.WorkedSeconds)
	}
	if card.Role != "Custom AI agent" || card.Name != "Atlas" {
		t.Errorf("card = %+v", card)
	}
	if _, ok := engine.Card("nobody"); ok {
		t.Error("a card for an agent that isn't there")
	}
}

// The day is saved with the agent, so a restart keeps it, and the time the office was off is not
// counted as work.
func TestTheDaySurvivesARestart(t *testing.T) {
	c := &clock{time.Date(2026, time.November, 6, 14, 0, 0, 0, time.Local)}
	ctx := context.Background()
	s, err := store.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	first, err := New(ctx, s, c.read)
	if err != nil {
		t.Fatal(err)
	}
	agent := &models.LiveAgent{Agent: models.Agent{ID: "a1", Name: "Atlas"}}
	agent.State = models.StateIdle
	_ = first.Do(func() { first.AddAgent(agent) })
	c.pass(time.Minute)
	work(t, first, agent, models.StateEditing)
	c.pass(4 * time.Minute)
	work(t, first, agent, models.StateDone)

	// The office is off for an hour with the agent still shown as it was left, then starts again.
	c.pass(time.Hour)
	second, err := New(ctx, s, c.read)
	if err != nil {
		t.Fatal(err)
	}
	card, ok := second.Card("a1")
	if !ok || card.FinishedToday != 1 || card.WorkedSeconds != 4*60 {
		t.Errorf("after a restart: %+v (found %v), want 1 task and 240 s", card, ok)
	}
}
