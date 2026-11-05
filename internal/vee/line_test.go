// SPDX-License-Identifier: Apache-2.0

package vee

import (
	"testing"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// A workflow sub-agent, one not started from an agent file, is labelled so in Mabari's lines, and
// counts as working without a progress rate, as Claude Code sessions have none.
func TestStatusLabelsWorkflowSubAgents(t *testing.T) {
	session := agent("Shop", models.StateEditing)
	session.Rate, session.Workflow = 0, true
	defined := agent("Ledger", models.StateEditing)
	reply := Answer("What's happening?", []*models.LiveAgent{session, defined}, now)
	if reply.Kind != KindStatus || len(reply.Lines) != 2 {
		t.Fatalf("reply = %+v", reply)
	}
	labels := map[string]string{}
	for _, line := range reply.Lines {
		labels[line.Name] = line.Label
	}
	if labels["Shop"] != "workflow sub-agent" || labels["Ledger"] != "" {
		t.Errorf("labels = %v", labels)
	}
}
