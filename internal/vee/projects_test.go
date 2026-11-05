// SPDX-License-Identifier: Apache-2.0

package vee

import (
	"testing"

	"github.com/SamsonIdowu/mabari/internal/dispatch"
	"github.com/SamsonIdowu/mabari/internal/models"
)

func projects() []*models.Project {
	return []*models.Project{
		{ID: "eq", Name: "Experience and Quality", Repository: &models.Repository{Path: "~/code/experience-quality"}},
		{ID: "lad", Name: "Lad Project All", Instructions: "Payments service in Go"},
		{ID: "old", Name: "Old site", Done: &models.ProjectDone{}},
	}
}

func inProjects(view string) Office {
	agents := office()
	shop := "lad"
	agents[2].Project = &shop // Ledger works on Lad Project All.
	return Office{Agents: agents, Projects: projects(), InView: view, Router: dispatch.Rules{}}
}

func TestNamingAProject(t *testing.T) {
	for text, want := range map[string]Route{
		"send /ux-audit https://github.com/wazuh/experience-quality/issues/130 to Experience and Quality": {
			ProjectID: "eq", Text: "/ux-audit https://github.com/wazuh/experience-quality/issues/130"},
		"/ux-audit https://x.io/A?b=C in experience and quality": {ProjectID: "eq", Text: "/ux-audit https://x.io/A?b=C"},
		"in Lad Project All: run the tests":                      {ProjectID: "lad", Text: "run the tests"},
		"for the lad project, fix the login":                     {ProjectID: "lad", Text: "fix the login"},
		"Lad: fix the login":                                     {ProjectID: "lad", Text: "fix the login"},
		"@Experience and Quality check the build":                {ProjectID: "eq", Text: "check the build"},
		"tell Experience and Quality to run /ux-audit #130":      {ProjectID: "eq", Text: "run /ux-audit #130"},
		"please ask the Lad project what's left":                 {ProjectID: "lad", Text: "what's left"},
		"fix the flaky test in Lad":                              {ProjectID: "lad", Text: "fix the flaky test"},
	} {
		reply := AnswerIn(text, inProjects(""), now)
		if reply.Route == nil || *reply.Route != want {
			t.Errorf("%q: route = %+v", text, reply.Route)
		}
	}
}

func TestNotEverythingNamesAProject(t *testing.T) {
	for _, text := range []string{
		// An agent's name wins: Ledger is an agent.
		"tell Ledger to add a test",
		// A description, not a task.
		"a bug in Lad",
		// A finished project takes nothing.
		"send this to Old site",
	} {
		if reply := AnswerIn(text, inProjects(""), now); reply.Route != nil && reply.Route.ProjectID != "lad" ||
			reply.Route != nil && text != "a bug in Lad" && reply.Route.Text != text {
			t.Errorf("%q: route = %+v", text, reply.Route)
		}
	}
	if reply := AnswerIn("tell Ledger to add a test", inProjects(""), now); reply.Send == nil || reply.Route != nil {
		t.Errorf("an agent lost to a project: %+v", reply)
	}
	if reply := AnswerIn("tell Nowhere to add a test", inProjects(""), now); reply.Text !=
		"I couldn't find an agent or project called nowhere. Try one of: Atlas, Atlas scribe, Ledger, Mori, Experience and Quality, Lad Project All." {
		t.Errorf("unknown = %q", reply.Text)
	}
}

func TestMabariChoosesOrAsks(t *testing.T) {
	// The project picked next to the chat box takes anything not addressed elsewhere.
	if reply := AnswerIn("fix the build", inProjects("eq"), now); reply.Route == nil || reply.Route.ProjectID != "eq" {
		t.Errorf("in view: %+v", reply.Route)
	}
	// A question about the office is still Mabari's to answer.
	if reply := AnswerIn("what needs me?", inProjects("eq"), now); reply.Route != nil || reply.Kind != KindNeeds {
		t.Errorf("question: %+v", reply)
	}
	// Mabari's map: the folder, the instructions, and what the agents there are doing.
	for text, want := range map[string]string{
		"open the experience quality dashboard": "eq",
		"the payments service is slow":          "lad",
		"Ledger needs to look at the totals":    "",
	} {
		reply := AnswerIn(text, inProjects(""), now)
		got := ""
		if reply.Route != nil {
			got = reply.Route.ProjectID
		}
		if got != want || want != "" && reply.Route.Why == "" {
			t.Errorf("%q: route = %+v", text, reply.Route)
		}
	}
	// When nothing fits, it asks, and offers only open projects.
	reply := AnswerIn("make it faster", inProjects(""), now)
	if reply.Kind != KindPickProject || reply.Target != "make it faster" || len(reply.Projects) != 2 || reply.Route != nil {
		t.Fatalf("ask = %+v", reply)
	}
	// Choosing "any project" leaves it to the dispatcher, as before projects.
	if reply := AnswerIn("make it faster", inProjects(AnyProject), now); !reply.Dispatch {
		t.Errorf("any = %+v", reply)
	}
	// With no projects, nothing changes.
	if reply := Answer("make it faster", office(), now); !reply.Dispatch {
		t.Errorf("no projects = %+v", reply)
	}
}
