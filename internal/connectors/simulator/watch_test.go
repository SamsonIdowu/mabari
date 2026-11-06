// SPDX-License-Identifier: Apache-2.0

package simulator

import (
	"testing"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
)

// firedIn reads what is waiting for the subscriber. A page that falls a thousand messages behind is
// dropped and its feed closed, which a long run of ticks can do, so a closed feed ends the read
// rather than being read for ever.
func firedIn(sub *events.Subscription) []models.WatchFired {
	var out []models.WatchFired
	for {
		select {
		case message, open := <-sub.C:
			if !open {
				return out
			}
			if message.Type == models.MsgWatchFired {
				out = append(out, *message.Fired)
			}
		default:
			return out
		}
	}
}

// quietFor runs ticks and reports what fired meanwhile, listening all the way, so no run of ticks
// can outgrow what a subscriber holds.
func quietFor(t *testing.T, engine *events.Engine, sim *Simulator, c *clock, ticks int) []models.WatchFired {
	t.Helper()
	sub := engine.Subscribe(events.Resume{}).Sub
	defer engine.Unsubscribe(sub)
	var fired []models.WatchFired
	for range ticks {
		advance(t, sim, c, 1)
		fired = append(fired, firedIn(sub)...)
	}
	return fired
}

// The demo office is where watches are seen: one set on a working agent fires, once, as the agent
// really finishes its work, and the instruction it carries lands on the next agent the way any
// instruction does, which for an idle one is starting on it.
func TestAWatchInTheDemoFiresWhenAnAgentFinishesAndTellsTheNextOne(t *testing.T) {
	sim, engine, c, _ := setup(t, ":memory:", 1)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	sub := engine.Subscribe(events.Resume{}).Sub
	var set events.WatchSet
	if err := engine.Do(func() {
		bolt, pixel := engine.AgentByName("Bolt"), engine.AgentByName("Pixel")
		// Nearly done, so a few ticks finish it.
		bolt.Progress = 0.9995
		engine.Touch(bolt)
		var err error
		set, err = engine.SetWatch(events.WatchRequest{
			Kind: models.WatchAgent, Target: bolt.ID, ThenAgent: pixel.ID, ThenText: "Write up the failures",
		})
		if err != nil {
			t.Fatal(err)
		}
	}); err != nil {
		t.Fatal(err)
	}
	if set.Watch == nil || set.Already != "" {
		t.Fatalf("set = %+v", set)
	}
	if pixel := agentSnapshot(engine, "Pixel"); pixel.State != models.StateIdle || len(pixel.Asked) != 0 {
		t.Fatalf("Pixel before: %s, asked %+v", pixel.State, pixel.Asked)
	}
	firedIn(sub)
	advance(t, sim, c, 3)
	if bolt := agentSnapshot(engine, "Bolt"); bolt.State != models.StateDone {
		t.Fatalf("Bolt is %s, not done", bolt.State)
	}
	fired := firedIn(sub)
	if len(fired) != 1 || fired[0].Outcome != models.WatchDone || fired[0].AgentID != set.Watch.Target ||
		fired[0].Notice != "Bolt is done" {
		t.Fatalf("fired = %+v", fired)
	}
	if want := "Bolt is done: Run the full test suite and report failures. I told Pixel “Write up the failures”."; fired[0].Text != want {
		t.Errorf("text = %q, want %q", fired[0].Text, want)
	}
	// Pixel took it the way it takes anything from you, and started on it.
	pixel := agentSnapshot(engine, "Pixel")
	if len(pixel.Asked) != 1 || pixel.Asked[0].Text != "Write up the failures" || pixel.State == models.StateIdle {
		t.Errorf("Pixel after: %s, asked %+v", pixel.State, pixel.Asked)
	}
	if watches := engine.Snapshot().Watches; len(watches) != 0 {
		t.Errorf("a watch that fired stays: %+v", watches)
	}
	// Once: the rest of the demo, and Bolt idling and picking up new work, tells nobody anything.
	if more := quietFor(t, engine, sim, c, 120); len(more) != 0 {
		t.Errorf("fired again: %+v", more)
	}
}

// What is already finished in the demo, or stopped, has nothing to wait for.
func TestWatchingTheDemosFinishedAndStoppedAgents(t *testing.T) {
	sim, engine, _, _ := setup(t, ":memory:", 1)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]models.WatchOutcome{"Rune": models.WatchDone, "Mori": models.WatchFailed} {
		var set events.WatchSet
		if err := engine.Do(func() {
			var err error
			set, err = engine.SetWatch(events.WatchRequest{Kind: models.WatchAgent, Target: engine.AgentByName(name).ID})
			if err != nil {
				t.Fatal(err)
			}
		}); err != nil {
			t.Fatal(err)
		}
		if set.Already != want || set.Watch != nil {
			t.Errorf("%s: %+v", name, set)
		}
	}
}

// Watches on the demo's agents go with the demo: they can't outlive agents that no longer exist.
func TestWatchesGoWhenTheDemoEnds(t *testing.T) {
	sim, engine, _, _ := setup(t, ":memory:", 1)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	sub := engine.Subscribe(events.Resume{}).Sub
	if err := engine.Do(func() {
		for _, name := range []string{"Ledger", "Scout"} {
			if _, err := engine.SetWatch(events.WatchRequest{Kind: models.WatchAgent, Target: engine.AgentByName(name).ID}); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := engine.SetWatch(events.WatchRequest{Kind: models.WatchProject, Target: "checkout"}); err != nil {
			t.Fatal(err)
		}
	}); err != nil {
		t.Fatal(err)
	}
	if got := len(engine.Snapshot().Watches); got != 3 {
		t.Fatalf("%d watches", got)
	}
	firedIn(sub)
	if err := engine.Do(sim.StopDemo); err != nil {
		t.Fatal(err)
	}
	if watches := engine.Snapshot().Watches; len(watches) != 0 {
		t.Errorf("after the demo: %+v", watches)
	}
	if fired := firedIn(sub); len(fired) != 0 {
		t.Errorf("watches fired as the demo ended: %+v", fired)
	}
}
