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
		// The start of a name only counts where a project is plainly named; here the name word
		// still makes Lad the clear fit, and the whole message goes.
		"fix the flaky test in Lad": {ProjectID: "lad", Text: "fix the flaky test in Lad", Why: "it mentions Lad Project All"},
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

// Cases that used to be read as naming a project.
func TestOrdinaryWordsDontNameAProject(t *testing.T) {
	projects := []*models.Project{
		{ID: "tools", Name: "Tools"}, {ID: "infra", Name: "Infra"}, {ID: "mw", Name: "mabari-web"},
		{ID: "web", Name: "Web"}, {ID: "staging", Name: "Staging Tools"}, {ID: "admin", Name: "Shop Admin"},
		{ID: "shop", Name: "Shop"},
	}
	in := Office{Projects: projects}
	for _, text := range []string{
		"Tools need updating before release",
		"Infra costs went up, what happened?",
		"mabari-web is slow on startup, why?",
		"Web-sockets drop on reconnect, fix it",
		"deploy the API to staging",
	} {
		if project, body, _ := namedProject(text, open(projects)); project != nil {
			t.Errorf("%q named %s with %q", text, project.Name, body)
		}
	}
	// A whole name is a name, whichever project was made first.
	for _, text := range []string{"in Shop: fix the login", "fix the login in Shop"} {
		if reply := AnswerIn(text, in, now); reply.Route == nil || reply.Route.ProjectID != "shop" {
			t.Errorf("%q: %+v", text, reply.Route)
		}
	}
	// A longer project name beats an agent whose name starts it.
	shop := agent("Shop", models.StateIdle)
	if reply := AnswerIn("tell Shop Admin to fix login", Office{Agents: []*models.LiveAgent{shop}, Projects: projects}, now); reply.Route == nil ||
		reply.Route.ProjectID != "admin" || reply.Route.Text != "fix login" {
		t.Errorf("tell Shop Admin: %+v %+v", reply.Route, reply.Send)
	}
	// Small talk never becomes work, even with only one project.
	one := Office{Projects: projects[:1]}
	for _, text := range []string{"ok", "nice", "good morning", "what?", "are you there?", "did the tests pass?"} {
		if reply := AnswerIn(text, one, now); reply.Route != nil || reply.Dispatch {
			t.Errorf("%q was handed over: %+v", text, reply.Route)
		}
	}
}

// One shared everyday word isn't enough to pick a project.
func TestOneWordIsNotAFit(t *testing.T) {
	alpha, beta := "alpha", "beta"
	readme := agent("Rune", models.StateIdle)
	readme.Task, readme.Project = "Update the README", &alpha
	other := agent("Bolt", models.StateIdle)
	other.Task, other.Project = "Sort the queue", &beta
	in := Office{Agents: []*models.LiveAgent{readme, other}, Projects: []*models.Project{{ID: alpha, Name: "Alpha"}, {ID: beta, Name: "Beta"}}}
	if reply := AnswerIn("update the billing code", in, now); reply.Kind != KindPickProject {
		t.Errorf("one word picked %+v", reply.Route)
	}
	if reply := AnswerIn("update the README install steps", in, now); reply.Route == nil || reply.Route.ProjectID != alpha {
		t.Errorf("two words: %+v", reply)
	}
}
