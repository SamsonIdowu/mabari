// SPDX-License-Identifier: Apache-2.0

package models

import (
	"testing"
	"time"
)

// A real agent has been here since it arrived. The demo keeps its own office time.
func TestElapsedIsRealForRealAgents(t *testing.T) {
	now := time.UnixMilli(1_000_000_000)
	real := &LiveAgent{}
	real.Source, real.CreatedAt = "claude", now.Add(-15*time.Minute).UnixMilli()
	real.Refresh(now)
	if real.Elapsed != 15*60 {
		t.Errorf("real agent: %d", real.Elapsed)
	}
	demo := &LiveAgent{}
	demo.Source, demo.CreatedAt, demo.Elapsed = SourceDemo, now.UnixMilli(), 700
	demo.Refresh(now)
	if demo.Elapsed != 700 {
		t.Errorf("demo agent: %d", demo.Elapsed)
	}
}

// Agents in the plan who haven't arrived hold the percentage down: the lead finishing alone is a
// third of a team of three, not all of it.
func TestAPlannedAgentThatHasNotArrivedCounts(t *testing.T) {
	lead := &LiveAgent{}
	lead.State, lead.Progress = StateDone, 1
	project := &Project{Planned: 2}
	status, progress := ProjectState(project, []*LiveAgent{lead})
	if status != ProjectReady || progress < 0.33 || progress > 0.34 {
		t.Errorf("status %q, progress %v", status, progress)
	}
	project.Planned = 0
	if _, progress := ProjectState(project, []*LiveAgent{lead}); progress != 1 {
		t.Errorf("with everyone here: %v", progress)
	}
}
