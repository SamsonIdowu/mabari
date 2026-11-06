// SPDX-License-Identifier: Apache-2.0

package server

import (
	"net/http"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/models"
)

func report(t *testing.T, o *office, token, state string) {
	t.Helper()
	body := `{"agent":"card-bot","name":"Card Bot","state":"` + state + `","task":"Tidy up"}`
	if response := hubCall(t, o, token, http.MethodPost, "/hub/v1/events", body); response.Code != http.StatusOK {
		t.Fatalf("report %s = %d %s", state, response.Code, response.Body)
	}
}

// The agent's card comes from the server: its role, and the tasks it finished today, counted from
// the states it reported.
func TestTheAgentCardHasTheNumbersTheServerCounted(t *testing.T) {
	o, _ := newKeyOffice(t)
	token := decode[struct {
		Token string `json:"token"`
	}](t, o.do(t, http.MethodPost, "/api/accounts/hub/token", "")).Token
	report(t, o, token, "idle")
	report(t, o, token, "running")
	report(t, o, token, "done")
	report(t, o, token, "done")
	report(t, o, token, "thinking")
	report(t, o, token, "done")

	card := decode[models.AgentCard](t, o.do(t, http.MethodGet, "/api/agents/hub-card-bot/card", ""))
	if card.Name != "Card Bot" || card.Role != "Custom AI agent" || card.FinishedToday != 2 {
		t.Errorf("card = %+v, want Card Bot, Custom AI agent and 2 finished", card)
	}
	if card.WorkedSeconds < 0 || card.CostKnown || card.CostBasis != "estimate" {
		t.Errorf("worked %d, cost known %v, basis %q", card.WorkedSeconds, card.CostKnown, card.CostBasis)
	}

	missing := o.do(t, http.MethodGet, "/api/agents/nobody/card", "")
	if missing.Code != http.StatusNotFound || !strings.Contains(missing.Body.String(), "no such agent") {
		t.Errorf("unknown agent = %d %s", missing.Code, missing.Body)
	}
}

// The demo's agents have cards with real counters too, so the card can be seen in the demo.
func TestTheDemoAgentsHaveCards(t *testing.T) {
	o := newOffice(t)
	snapshot := o.demo(t)
	if len(snapshot.Agents) == 0 {
		t.Fatal("no demo agents")
	}
	for _, agent := range snapshot.Agents {
		card := decode[models.AgentCard](t, o.do(t, http.MethodGet, "/api/agents/"+agent.ID+"/card", ""))
		if card.ID != agent.ID || card.Role == "" || card.FinishedToday < 0 || card.WorkedSeconds < 0 {
			t.Errorf("%s: card = %+v", agent.Name, card)
		}
		if agent.TokensIn+agent.TokensOut > 0 && !card.CostKnown {
			t.Errorf("%s has tokens but no cost on its card", agent.Name)
		}
	}
}
