// SPDX-License-Identifier: Apache-2.0

package simulator

import (
	"testing"
	"time"
)

// The demo runs for the length it announces (NEW-1). One tester saw it end after ten minutes and
// another after about twenty. Its length is DemoLength, ten minutes, and the end time the banner
// shows is the timer's own: the page reads it from the snapshot. Loading the demo again, as
// pressing "Explore a demo office" a second time does, starts the ten minutes afresh and moves
// the banner's time with it, which is how a second run can last twenty minutes from the first.
func TestTheDemoEndsWhenItSaysItWill(t *testing.T) {
	if DemoLength != 10*time.Minute {
		t.Fatalf("the demo runs for %v, and the page tells people ten minutes", DemoLength)
	}
	sim, engine, c, _ := setup(t, ":memory:", 1)
	sim.SetDemoLength(DemoLength)
	start := c.ms
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	announced := engine.Snapshot().DemoEndsAt
	if announced != start+DemoLength.Milliseconds() {
		t.Fatalf("the demo says it ends at +%v, not +%v", time.Duration(announced-start)*time.Millisecond, DemoLength)
	}
	// Right up to the announced second it is still running, and its end time hasn't moved.
	advance(t, sim, c, int(DemoLength/time.Second)-1)
	if snapshot := engine.Snapshot(); !snapshot.Demo || snapshot.DemoEndsAt != announced {
		t.Fatalf("at %v: demo %v, ends at %d (announced %d)", time.Duration(c.ms-start)*time.Millisecond, snapshot.Demo, snapshot.DemoEndsAt, announced)
	}
	// And at it, it is over, and says nothing more about ending.
	advance(t, sim, c, 1)
	snapshot := engine.Snapshot()
	if snapshot.Demo || snapshot.DemoEndsAt != 0 || c.ms != announced {
		t.Fatalf("at the announced time (%d, now %d): demo %v, ends at %d", announced, c.ms, snapshot.Demo, snapshot.DemoEndsAt)
	}
	for _, agent := range snapshot.Agents {
		if agent.Source == Source {
			t.Errorf("%s is still in the office", agent.Name)
		}
	}
}

// Loading the demo a second time restarts the ten minutes, and the end time the page shows is the
// new one.
func TestLoadingTheDemoAgainRestartsItsTime(t *testing.T) {
	sim, engine, c, _ := setup(t, ":memory:", 1)
	sim.SetDemoLength(DemoLength)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	first := engine.Snapshot().DemoEndsAt
	advance(t, sim, c, 8*60)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	second := engine.Snapshot().DemoEndsAt
	if second != c.ms+DemoLength.Milliseconds() || second-first != 8*60*1000 {
		t.Errorf("first ends at %d, second at %d, now %d", first, second, c.ms)
	}
	// It is still running when the first time would have come.
	advance(t, sim, c, 2*60+5)
	if !engine.Snapshot().Demo {
		t.Error("the demo ended at its first time, though it was loaded again")
	}
	advance(t, sim, c, 8*60)
	if engine.Snapshot().Demo {
		t.Error("the demo outlived its second time")
	}
}
