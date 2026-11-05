// SPDX-License-Identifier: Apache-2.0

package codex

import (
	"strings"
	"testing"
	"time"

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
