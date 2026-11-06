// SPDX-License-Identifier: Apache-2.0

package simulator

import (
	"context"
	"slices"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

func demoOffice(t *testing.T) (*Simulator, *events.Engine) {
	t.Helper()
	s, err := store.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	engine, err := events.New(context.Background(), s, nil)
	if err != nil {
		t.Fatal(err)
	}
	sim := New(engine, Mulberry32(7), 0)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	return sim, engine
}

func threadOf(t *testing.T, engine *events.Engine, name string) []models.ConversationItem {
	t.Helper()
	var id string
	_ = engine.Do(func() { id = engine.AgentByName(name).ID })
	items, _, err := engine.Store().Conversation(context.Background(), id, 0, 200)
	if err != nil {
		t.Fatal(err)
	}
	return items
}

func TestEveryDemoAgentHasAConversation(t *testing.T) {
	_, engine := demoOffice(t)
	var names []string
	_ = engine.Do(func() {
		for _, agent := range engine.Agents() {
			names = append(names, agent.Name)
		}
	})
	if len(names) == 0 {
		t.Fatal("no demo agents")
	}
	for _, name := range names {
		items := threadOf(t, engine, name)
		if len(items) < 2 || items[0].Kind != models.ConversationUser || items[1].Kind != models.ConversationAssistant {
			t.Errorf("%s: %+v", name, items)
		}
	}
}

func TestADemoInstructionJoinsTheConversation(t *testing.T) {
	sim, engine := demoOffice(t)
	_ = engine.Do(func() {
		agent := engine.AgentByName("Rune")
		agent.State = models.StateIdle
		sim.Instruct(agent, "Fix the header")
	})
	items := threadOf(t, engine, "Rune")
	said := slices.IndexFunc(items, func(item models.ConversationItem) bool { return item.Text == "Fix the header" })
	if said < 0 || said+1 >= len(items) || items[said+1].Kind != models.ConversationAssistant {
		t.Fatalf("conversation = %+v", items)
	}
}

// The panel's session controls can be seen in the demo, for agents on Claude Code only, and its
// command never names a session that exists.
func TestDemoClaudeAgentsHaveAPretendSession(t *testing.T) {
	_, engine := demoOffice(t)
	_ = engine.Do(func() {
		for _, agent := range engine.Agents() {
			switch {
			case agent.Provider == models.ProviderClaude && (agent.Session == nil || agent.Session.Resume == ""):
				t.Errorf("%s: no session", agent.Name)
			case agent.Provider != models.ProviderClaude && agent.Session != nil:
				t.Errorf("%s: session %+v", agent.Name, agent.Session)
			}
		}
	})
}

func TestEndingTheDemoRemovesItsConversations(t *testing.T) {
	sim, engine := demoOffice(t)
	var id string
	_ = engine.Do(func() { id = engine.AgentByName("Rune").ID })
	_ = engine.Do(sim.StopDemo)
	items, _, err := engine.Store().Conversation(context.Background(), id, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("left behind: %+v", items)
	}
}
