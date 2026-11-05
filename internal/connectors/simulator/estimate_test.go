// SPDX-License-Identifier: Apache-2.0

package simulator

import (
	"math"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
)

// secondsLeft reads an agent's estimate the way the page does: from the snapshot.
func secondsLeft(engine *events.Engine, name string) (int64, *models.LiveAgent) {
	for _, agent := range engine.Snapshot().Agents {
		if agent.Name == name && agent.Estimate != nil {
			copied := agent
			return agent.Estimate.SecondsLeft, &copied
		}
	}
	return 0, nil
}

func stateOf(engine *events.Engine, name string) models.AgentState {
	for _, agent := range engine.Snapshot().Agents {
		if agent.Name == name {
			return agent.State
		}
	}
	return ""
}

// A demo minute is a minute (FIRST-8). The demo's agents work through their steps several times
// faster than the clock, and their estimates used to count in that faster time, so "~17m" was
// "~8m" a minute and a half later. With the clock advanced a second at a time, an estimate now
// falls by about a second per second.
func TestDemoEstimatesFallAtTheClocksPace(t *testing.T) {
	const window = 60
	var ratios []float64
	for seed := uint32(1); seed <= 12; seed++ {
		sim, engine, c, _ := setup(t, ":memory:", seed)
		if err := sim.LoadDemo(); err != nil {
			t.Fatal(err)
		}
		before := map[string]int64{}
		task := map[string]string{}
		for _, agent := range engine.Snapshot().Agents {
			if agent.Estimate != nil {
				before[agent.Name], task[agent.Name] = agent.Estimate.SecondsLeft, agent.Task
			}
		}
		if len(before) < 4 {
			t.Fatalf("seed %d: only %d agents have an estimate", seed, len(before))
		}
		advance(t, sim, c, window)
		for name, was := range before {
			now, agent := secondsLeft(engine, name)
			if agent == nil || agent.Task != task[name] {
				continue // It finished or moved on to other work in the window.
			}
			fell := float64(was-now) / window
			ratios = append(ratios, fell)
			if fell < 0.5 || fell > 1.5 {
				t.Errorf("seed %d, %s: the estimate fell %.2f s per second (%d to %d)", seed, name, fell, was, now)
			}
		}
	}
	if len(ratios) < 30 {
		t.Fatalf("only %d estimates were measured", len(ratios))
	}
	var sum float64
	for _, ratio := range ratios {
		sum += ratio
	}
	mean := sum / float64(len(ratios))
	t.Logf("%d estimates fell %.3f s per second on average", len(ratios), mean)
	if mean < 0.9 || mean > 1.15 {
		t.Errorf("on average the estimates fell %.2f s per second, want about 1", mean)
	}
}

// In one step, with nothing else changing, an estimate falls by the same amount each second, and
// by close to one second.
func TestAnEstimateFallsSteadilyWithinAStep(t *testing.T) {
	sim, engine, c, _ := setup(t, ":memory:", 1)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	if err := engine.Do(func() {
		ledger := engine.AgentByName("Ledger")
		ledger.State = models.StateEditing
		sim.runtimeOf(ledger).stateLeft = waitForever
	}); err != nil {
		t.Fatal(err)
	}
	advance(t, sim, c, 1)
	first, _ := secondsLeft(engine, "Ledger")
	advance(t, sim, c, 40)
	last, _ := secondsLeft(engine, "Ledger")
	if fell := float64(first-last) / 40; fell < 0.95 || fell > 1.25 {
		t.Errorf("Ledger's estimate fell %.2f s per second (%d to %d)", fell, first, last)
	}
}

// What an agent says it will take is what it takes: the estimate when a task starts is about how
// long the demo agent then spends on it.
func TestAFreshTaskTakesAboutAsLongAsItSaid(t *testing.T) {
	for seed := uint32(1); seed <= 10; seed++ {
		sim, engine, c, _ := setup(t, ":memory:", seed)
		if err := sim.LoadDemo(); err != nil {
			t.Fatal(err)
		}
		if err := engine.Do(func() { sim.Instruct(engine.AgentByName("Pixel"), "Write the changelog for 2.4") }); err != nil {
			t.Fatal(err)
		}
		advance(t, sim, c, 1)
		said, _ := secondsLeft(engine, "Pixel")
		if said == 0 {
			t.Fatalf("seed %d: Pixel gave no estimate", seed)
		}
		took := int64(1)
		for ; took < 3000; took++ {
			if stateOf(engine, "Pixel") == models.StateDone {
				break
			}
			advance(t, sim, c, 1)
		}
		if ratio := float64(took) / float64(said); ratio < 0.7 || ratio > 1.4 {
			t.Errorf("seed %d: said %d s and took %d s", seed, said, took)
		}
	}
}

// The finish time the page shows ("done around") doesn't move more than a little between ticks
// unless the work itself changes: someone finishes, or picks up something new.
func TestDoneAroundDoesNotJump(t *testing.T) {
	compared := 0
	for seed := uint32(1); seed <= 6; seed++ {
		sim, engine, c, _ := setup(t, ":memory:", seed)
		if err := sim.LoadDemo(); err != nil {
			t.Fatal(err)
		}
		type reading struct {
			finish int64
			at     map[string]string
		}
		read := func() reading {
			out := reading{at: map[string]string{}}
			var estimates []*models.Estimate
			for _, agent := range engine.Snapshot().Agents {
				if agent.Estimate != nil {
					estimates = append(estimates, agent.Estimate)
					out.at[agent.Name] = agent.Task
				}
			}
			if latest := models.LatestFinish(estimates...); latest != nil {
				out.finish = latest.FinishAt
			}
			return out
		}
		previous := read()
		for range 540 {
			advance(t, sim, c, 1)
			current := read()
			same := len(previous.at) == len(current.at)
			for name, task := range previous.at {
				same = same && current.at[name] == task
			}
			if same && previous.finish != 0 {
				compared++
				if jump := math.Abs(float64(current.finish - previous.finish)); jump > 1500 {
					t.Errorf("seed %d, second %d: done around moved by %.1f s with the same work", seed, c.ms-goldenStart, jump/1000)
				}
			}
			previous = current
		}
	}
	if compared < 1000 {
		t.Errorf("only %d ticks were compared", compared)
	}
}

// Real agents are untouched: no scale, so a rate means progress per real second, as before.
func TestRealAgentsEstimatesAreUnchanged(t *testing.T) {
	real := &models.LiveAgent{}
	real.State, real.Progress, real.Rate = models.StateEditing, 0.5, 0.001
	if got := real.RatePerSecond(); got != 0.001 {
		t.Errorf("a real agent's rate per second = %v", got)
	}
	now := time.UnixMilli(goldenStart)
	if estimate := real.EstimateAt(now); estimate == nil || estimate.SecondsLeft != 500 {
		t.Errorf("estimate = %+v", estimate)
	}
	demo := *real
	demo.RateScale = demoPace
	if estimate := demo.EstimateAt(now); estimate == nil || estimate.SecondsLeft >= 500 || estimate.SecondsLeft < 80 {
		t.Errorf("a demo agent at pace %.1f: estimate = %+v", demoPace, estimate)
	}
}
