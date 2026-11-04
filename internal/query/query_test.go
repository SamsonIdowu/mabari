// SPDX-License-Identifier: Apache-2.0

package query

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
)

func TestAskUsesOnlyTheLog(t *testing.T) {
	agent := &models.LiveAgent{}
	agent.ID, agent.Name, agent.Task, agent.State, agent.Rate = "a", "Ledger", "Fix totals", models.StateEditing, 0.001
	agent.Progress = 0.5
	agent.Feed = []models.Event{
		{ID: "e4", Tool: "edit_file", Summary: "src/a.ts  +1 −1"},
		{ID: "e3", Tool: "run_shell", Summary: "npm test"},
		{ID: "e2", Tool: "read_file", Summary: "src/a.ts"},
		{ID: "e1", Tool: "read_file", Summary: "src/b.ts"},
	}
	answer := Ask(agent, "How is it going?", "gpt-5-mini", time.Now())
	if answer.Reads != 2 || answer.Edits != 1 || answer.Runs != 1 || answer.State != "Editing" {
		t.Errorf("answer = %+v", answer)
	}
	if answer.LatestTool != "edit_file" || !strings.HasPrefix(answer.Estimate, "About 8 min left") {
		t.Errorf("answer = %+v", answer)
	}
	if !slices.Equal(answer.Events, []string{"e4", "e3"}) {
		t.Errorf("events = %v", answer.Events)
	}
}

func TestAskWithAnEmptyFeed(t *testing.T) {
	agent := &models.LiveAgent{}
	agent.State = models.StateIdle
	answer := Ask(agent, "Anything?", "m", time.Now())
	if len(answer.Events) != 0 || answer.Estimate != "No task right now" {
		t.Errorf("answer = %+v", answer)
	}
}

func TestShort(t *testing.T) {
	agent := &models.LiveAgent{}
	agent.State = models.StateDone
	if got := Short(agent, time.Now()); got != "Done. Finished." {
		t.Errorf("Short = %q", got)
	}
}
