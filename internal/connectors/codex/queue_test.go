// SPDX-License-Identifier: Apache-2.0

package codex

import (
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
)

// A turn that waits on your approval can't read a message, so the message waits for the decision
// instead of being reported delivered at once (FIRST-2). It is handed to Codex after the decision,
// whichever way it goes.
func TestAMessageWaitsForAnApprovalThenReachesCodex(t *testing.T) {
	for _, decision := range []string{models.DecisionAllowed, models.DecisionDenied} {
		t.Run(decision, func(t *testing.T) {
			engine := newEngine(t)
			c := New(engine, "1.0")
			engine.AddConnector(Source, c)
			f := startFake(t, c, true)
			seated(t, engine, c)
			eventually(t, func() bool { return f.called("turn/start") != nil })
			f.notify("turn/started", map[string]any{"threadId": "thr_1", "turn": map[string]string{"id": "turn_1"}})
			time.Sleep(20 * time.Millisecond)
			f.request(99, "item/commandExecution/requestApproval", map[string]any{
				"threadId": "thr_1", "turnId": "turn_1", "itemId": "i2", "command": "git push --force", "cwd": "/home/me/shop",
			})
			var id string
			eventually(t, func() bool {
				_ = engine.Do(func() {
					if agent := engine.Agent("cx-1"); agent.Approval != nil {
						id = agent.Approval.ID
					}
				})
				return id != ""
			})

			_ = engine.Do(func() { c.Instruct(engine.Agent("cx-1"), "After the push, also tag the release") })
			var queued, asked int
			_ = engine.Do(func() {
				agent := engine.Agent("cx-1")
				queued, asked = len(agent.Queued), len(agent.Asked)
			})
			if queued != 1 || asked != 0 {
				t.Fatalf("waiting on approval: %d queued, %d delivered", queued, asked)
			}
			time.Sleep(50 * time.Millisecond)
			if f.called("turn/steer") != nil {
				t.Fatal("Codex was given the message while it waited on the approval")
			}

			_ = engine.Do(func() { engine.Decide(id, decision) })
			eventually(t, func() bool { return f.called("turn/steer") != nil })
			if steer := f.called("turn/steer"); !strings.Contains(string(steer.Params), "also tag the release") {
				t.Errorf("steer = %s", steer.Params)
			}
			_ = engine.Do(func() {
				agent := engine.Agent("cx-1")
				queued, asked = len(agent.Queued), len(agent.Asked)
			})
			if queued != 0 || asked != 1 {
				t.Errorf("after the decision: %d queued, %d delivered", queued, asked)
			}
		})
	}
}

// A message to a Codex agent that isn't waiting on you still goes straight in, as before.
func TestAMessageToABusyCodexAgentIsStillImmediate(t *testing.T) {
	engine := newEngine(t)
	c := New(engine, "1.0")
	engine.AddConnector(Source, c)
	f := startFake(t, c, true)
	seated(t, engine, c)
	eventually(t, func() bool { return f.called("turn/start") != nil })
	f.notify("turn/started", map[string]any{"threadId": "thr_1", "turn": map[string]string{"id": "turn_1"}})
	time.Sleep(20 * time.Millisecond)
	_ = engine.Do(func() { c.Instruct(engine.Agent("cx-1"), "Also update the README") })
	eventually(t, func() bool { return f.called("turn/steer") != nil })
	_ = engine.Do(func() {
		if agent := engine.Agent("cx-1"); len(agent.Queued) != 0 || len(agent.Asked) != 1 {
			t.Errorf("%d queued, %d delivered", len(agent.Queued), len(agent.Asked))
		}
	})
}

// waitingOnApproval seats an agent, starts its turn, and has Codex ask to run a command. It returns
// the id of the approval card.
func waitingOnApproval(t *testing.T) (*events.Engine, *Connector, *fakeServer, string) {
	t.Helper()
	engine := newEngine(t)
	c := New(engine, "1.0")
	engine.AddConnector(Source, c)
	f := startFake(t, c, true)
	seated(t, engine, c)
	eventually(t, func() bool { return f.called("turn/start") != nil })
	f.notify("turn/started", map[string]any{"threadId": "thr_1", "turn": map[string]string{"id": "turn_1"}})
	time.Sleep(20 * time.Millisecond)
	f.request(99, "item/commandExecution/requestApproval", map[string]any{
		"threadId": "thr_1", "turnId": "turn_1", "itemId": "i2", "command": "git push --force", "cwd": "/home/me/shop",
	})
	var id string
	eventually(t, func() bool {
		_ = engine.Do(func() {
			if agent := engine.Agent("cx-1"); agent.Approval != nil {
				id = agent.Approval.ID
			}
		})
		return id != ""
	})
	return engine, c, f, id
}

func count(f *fakeServer, method string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, call := range f.calls {
		if call.Method == method {
			n++
		}
	}
	return n
}

// REV-1: after a Deny, Codex carries on with its turn, so the agent is no longer waiting on you. It
// used to stay in the approval state with no card, still counted as needing you, and a message sent
// then was queued for a decision that would never come.
func TestAMessageAfterADenyIsDeliveredAtOnce(t *testing.T) {
	engine, c, f, id := waitingOnApproval(t)
	_ = engine.Do(func() { engine.Decide(id, models.DecisionDenied) })
	_ = engine.Do(func() {
		agent := engine.Agent("cx-1")
		if agent.State == models.StateApproval || agent.State.NeedsMe() {
			t.Errorf("after the deny the agent is %q and still needs you", agent.State)
		}
		if agent.Approval != nil {
			t.Error("the approval card is still there")
		}
	})
	_ = engine.Do(func() { c.Instruct(engine.Agent("cx-1"), "Skip the push and tag the release instead") })
	eventually(t, func() bool { return f.called("turn/steer") != nil })
	if steer := f.called("turn/steer"); !strings.Contains(string(steer.Params), "tag the release") {
		t.Errorf("steer = %s", steer.Params)
	}
	_ = engine.Do(func() {
		if agent := engine.Agent("cx-1"); len(agent.Queued) != 0 || len(agent.Asked) != 1 {
			t.Errorf("%d queued, %d delivered", len(agent.Queued), len(agent.Asked))
		}
	})
}

// The page is told, not left showing an agent waiting on an approval that has been decided: what
// it hears about the agent after a Deny does not say it is still in the approval state.
func TestThePageHearsAnAgentCarryOnAfterADeny(t *testing.T) {
	engine, _, _, id := waitingOnApproval(t)
	joined := engine.Subscribe(events.Resume{})
	t.Cleanup(func() { engine.Unsubscribe(joined.Sub) })
	_ = engine.Do(func() { engine.Decide(id, models.DecisionDenied) })
	var last models.AgentState
	for drained := false; !drained; {
		select {
		case message := <-joined.Sub.C:
			if message.Agent != nil && message.Agent.ID == "cx-1" {
				last = message.Agent.State
			}
		default:
			drained = true
		}
	}
	if last == "" || last == models.StateApproval || last.NeedsMe() {
		t.Errorf("the last state the page was told after the Deny is %q", last)
	}
}

// The same holds after an Allow, and a message sent while the card is still open waits for it.
func TestAMessageSentBeforeADecisionIsNeverLeftWaiting(t *testing.T) {
	for _, decision := range []string{models.DecisionAllowed, models.DecisionDenied} {
		t.Run(decision, func(t *testing.T) {
			engine, c, f, id := waitingOnApproval(t)
			_ = engine.Do(func() { c.Instruct(engine.Agent("cx-1"), "first, while the card is open") })
			_ = engine.Do(func() {
				if agent := engine.Agent("cx-1"); len(agent.Queued) != 1 {
					t.Fatalf("%d queued while the card is open, want 1", len(agent.Queued))
				}
			})
			_ = engine.Do(func() { engine.Decide(id, decision) })
			eventually(t, func() bool { return count(f, "turn/steer") == 1 })
			_ = engine.Do(func() { c.Instruct(engine.Agent("cx-1"), "second, after the decision") })
			eventually(t, func() bool { return count(f, "turn/steer") == 2 })
			_ = engine.Do(func() {
				if agent := engine.Agent("cx-1"); len(agent.Queued) != 0 || len(agent.Asked) != 2 {
					t.Errorf("%d queued, %d delivered", len(agent.Queued), len(agent.Asked))
				}
			})
		})
	}
}

// Whatever is still waiting when the turn completes goes in then, as the next turn, oldest first,
// one turn at a time.
func TestWhatWaitsIsDeliveredWhenTheTurnCompletes(t *testing.T) {
	engine := newEngine(t)
	c := New(engine, "1.0")
	engine.AddConnector(Source, c)
	f := startFake(t, c, true)
	seated(t, engine, c)
	eventually(t, func() bool { return f.called("turn/start") != nil })
	f.notify("turn/started", map[string]any{"threadId": "thr_1", "turn": map[string]string{"id": "turn_1"}})
	time.Sleep(20 * time.Millisecond)
	_ = engine.Do(func() {
		agent := engine.Agent("cx-1")
		engine.Queue(agent, "first thing")
		engine.Queue(agent, "second thing")
	})
	f.notify("turn/completed", map[string]any{"threadId": "thr_1", "turn": map[string]any{"id": "turn_1", "status": "completed"}})
	eventually(t, func() bool { return count(f, "turn/start") == 2 })
	time.Sleep(50 * time.Millisecond)
	if got := count(f, "turn/start"); got != 2 {
		t.Fatalf("%d turns started at once, want one at a time", got)
	}
	var last message
	f.mu.Lock()
	for _, call := range f.calls {
		if call.Method == "turn/start" {
			last = call
		}
	}
	f.mu.Unlock()
	if !strings.Contains(string(last.Params), "first thing") {
		t.Errorf("the new turn was given %s, want the oldest message", last.Params)
	}
	_ = engine.Do(func() {
		if agent := engine.Agent("cx-1"); len(agent.Queued) != 1 || agent.State != models.StateThinking {
			t.Errorf("%d queued, state %q: the newer message should wait for this turn", len(agent.Queued), agent.State)
		}
	})
	// Its turn ends too, and the rest goes in.
	f.notify("turn/completed", map[string]any{"threadId": "thr_1", "turn": map[string]any{"id": "turn_1", "status": "completed"}})
	eventually(t, func() bool { return count(f, "turn/start") == 3 })
	_ = engine.Do(func() {
		if agent := engine.Agent("cx-1"); len(agent.Queued) != 0 || len(agent.Asked) != 2 {
			t.Errorf("%d queued, %d delivered", len(agent.Queued), len(agent.Asked))
		}
	})
}

// A turn that was interrupted or failed hands on what waited too, so nothing stays queued for an
// agent that will never reach a checkpoint.
func TestWhatWaitsIsDeliveredWhenTheTurnEndsInAnyWay(t *testing.T) {
	for _, status := range []string{"interrupted", "failed"} {
		t.Run(status, func(t *testing.T) {
			engine := newEngine(t)
			c := New(engine, "1.0")
			engine.AddConnector(Source, c)
			f := startFake(t, c, true)
			seated(t, engine, c)
			eventually(t, func() bool { return f.called("turn/start") != nil })
			f.notify("turn/started", map[string]any{"threadId": "thr_1", "turn": map[string]string{"id": "turn_1"}})
			time.Sleep(20 * time.Millisecond)
			_ = engine.Do(func() { engine.Queue(engine.Agent("cx-1"), "carry on") })
			f.notify("turn/completed", map[string]any{"threadId": "thr_1", "turn": map[string]any{
				"id": "turn_1", "status": status, "error": map[string]string{"message": "it broke"},
			}})
			eventually(t, func() bool { return count(f, "turn/start") == 2 })
		})
	}
}
