// SPDX-License-Identifier: Apache-2.0

package vee

import (
	"strings"
	"testing"
	"time"
)

// Asked about the projects, Mabari answers from its map: every open project in a line.
func TestMabariKnowsEveryProject(t *testing.T) {
	reply := AnswerIn("what projects do we have?", inProjects(""), time.UnixMilli(0))
	if reply.Kind != KindStatus || !strings.Contains(reply.Text, "You have 2 projects.") ||
		!strings.Contains(reply.Text, "Experience and Quality: 0 working") ||
		!strings.Contains(reply.Text, "Lad Project All:") || strings.Contains(reply.Text, "Old site") {
		t.Errorf("reply = %+v", reply)
	}
}

// Asked about one project's tasks, by name or with it picked on Home, Mabari says who works
// there and on what.
func TestMabariKnowsTheTasksInAProject(t *testing.T) {
	for _, ask := range []struct {
		text, view string
	}{
		{"what tasks are there in Lad Project All?", ""},
		{"what's being done?", "lad"},
	} {
		reply := AnswerIn(ask.text, inProjects(ask.view), time.UnixMilli(0))
		if reply.Project == nil || reply.Project.ID != "lad" || !strings.HasPrefix(reply.Text, "Lad Project All:") {
			t.Errorf("%q = %+v", ask.text, reply)
		}
	}
}
