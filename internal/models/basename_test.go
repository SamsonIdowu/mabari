// SPDX-License-Identifier: Apache-2.0

package models

import (
	"testing"
	"time"
)

// A folder in an agent's file list is named as a folder, never as nothing.
func TestBaseName(t *testing.T) {
	for path, want := range map[string]string{
		"src/app.ts":                "app.ts",
		"app.ts":                    "app.ts",
		"test/":                     "test/",
		"docs/":                     "docs/",
		"src/billing/":              "billing/",
		"db/migrations/0042_orders": "0042_orders",
		"":                          "",
		"/":                         "",
		"//":                        "",
	} {
		if got := BaseName(path); got != want {
			t.Errorf("BaseName(%q) = %q, want %q", path, got, want)
		}
	}
}

// A speech bubble about a folder names the folder, and one with nothing to name says "files".
func TestBubblesNameFoldersAndNeverTrailOff(t *testing.T) {
	cases := []struct {
		state AgentState
		event Event
		want  string
	}{
		{StateReading, Event{Tool: "read_file", Summary: "test/"}, "Reading test/"},
		{StateReading, Event{Tool: "read_file", Summary: "src/app.ts"}, "Reading app.ts"},
		{StateEditing, Event{Tool: "edit_file", Summary: "docs/  +18 −6"}, "Editing docs/"},
		{StateEditing, Event{Tool: "edit_file", Summary: "/  +3 −0"}, "Editing code"},
		{StateReading, Event{Tool: "read_file", Summary: ""}, "Reading files"},
	}
	for _, tc := range cases {
		a := &LiveAgent{SessionState: SessionState{State: tc.state}, Feed: []Event{tc.event}}
		a.Refresh(time.UnixMilli(1000))
		if a.Bubble != tc.want {
			t.Errorf("%s with %q: bubble = %q, want %q", tc.state, tc.event.Summary, a.Bubble, tc.want)
		}
	}
}
