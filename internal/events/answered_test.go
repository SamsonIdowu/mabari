// SPDX-License-Identifier: Apache-2.0

package events

import (
	"context"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

func newEngine(t *testing.T) *Engine {
	t.Helper()
	ctx := context.Background()
	s, err := store.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	engine, err := New(ctx, s, nil)
	if err != nil {
		t.Fatal(err)
	}
	return engine
}

// A reply goes with the instructions that were waiting for one, and only those.
func TestAnsweredPairsTheReplyWithWhatWasAsked(t *testing.T) {
	engine := newEngine(t)
	agent := &models.LiveAgent{Agent: models.Agent{ID: "a1", Name: "Juniper"}}
	_ = engine.Do(func() {
		engine.AddAgent(agent)
		// A reply to the person's own terminal prompt isn't an answer to anything from Mabari.
		if engine.Answered(agent, "Hello from the terminal") {
			t.Error("answered with nothing asked")
		}
		engine.Queue(agent, "Add a test")
		engine.NextQueued(agent)
		engine.Delivered(agent, "And update the docs")
		if !engine.Answered(agent, "  Done: test added, docs updated.  ") {
			t.Error("not answered")
		}
		// A later reply doesn't overwrite one already given.
		engine.Answered(agent, "Something else")
	})
	if len(agent.Asked) != 2 {
		t.Fatalf("asked = %+v", agent.Asked)
	}
	for _, instruction := range agent.Asked {
		if instruction.Reply != "Done: test added, docs updated." || instruction.RepliedAt == 0 {
			t.Errorf("%q got %q", instruction.Text, instruction.Reply)
		}
	}
	rows, err := engine.Store().Log(context.Background(), store.LogQuery{Search: "docs"})
	if err != nil || len(rows) != 1 || rows[0].Outcome != "Replied" {
		t.Errorf("log = %+v %v", rows, err)
	}
}

func TestAnAgentKeepsItsLatestRequestsAndLongRepliesAreCut(t *testing.T) {
	engine := newEngine(t)
	agent := &models.LiveAgent{Agent: models.Agent{ID: "a1", Name: "Juniper"}}
	_ = engine.Do(func() {
		engine.AddAgent(agent)
		for range models.AskedKept + 3 {
			engine.Delivered(agent, "Do a thing")
		}
		engine.Answered(agent, strings.Repeat("é", models.ReplyLimit+50))
	})
	if len(agent.Asked) != models.AskedKept {
		t.Errorf("kept %d", len(agent.Asked))
	}
	reply := agent.Asked[0].Reply
	if !strings.HasSuffix(reply, "(The rest is in the agent's own session.)") ||
		!strings.HasPrefix(reply, strings.Repeat("é", models.ReplyLimit)) {
		t.Errorf("reply was not cut cleanly: %d runes", len([]rune(reply)))
	}
}
