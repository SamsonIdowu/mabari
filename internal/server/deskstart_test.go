// SPDX-License-Identifier: Apache-2.0

package server

import (
	"net/http"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/launch"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/projectmap"
)

func withDefs(office *office, defs ...models.AgentDef) {
	_ = office.engine.Do(func() { office.engine.SetDefs(defs) })
}

var plannerFile = models.AgentDef{
	ID: "account:planner", Kind: models.DefClaude, Name: "planner", Scope: models.DefAccount,
	Enabled: true, Description: "Use to plan the work.", Model: "inherit",
}

// Starting an agent file at the free desk opens Claude Code in the project's folder, running as
// that agent, with the task as its first prompt, which the project waits to see delivered.
func TestStartingAnAgentFileAtTheFreeDeskOpensClaudeCodeAsIt(t *testing.T) {
	office, fake := newLaunchOffice(t)
	withDefs(office, plannerFile)
	folder := t.TempDir()
	created := decode[models.Project](t, office.do(t, http.MethodPost, "/api/projects", `{"name":"Shop","color":"#48DBFB"}`))
	if response := office.do(t, http.MethodPatch, "/api/projects/"+created.ID, `{"folder":"`+folder+`"}`); response.Code != http.StatusOK {
		t.Fatalf("attach = %d %s", response.Code, response.Body)
	}
	response := office.do(t, http.MethodPost, "/api/desks/start",
		`{"defId":"account:planner","projectId":"`+created.ID+`","task":"Plan the checkout page"}`)
	result := decode[deskStartResult](t, response)
	if response.Code != http.StatusOK || !result.Opened {
		t.Fatalf("start = %d %+v", response.Code, result)
	}
	request := fake.last(t)
	if request.Agent != "planner" || request.Prompt != "Plan the checkout page" || request.Folder == "" {
		t.Errorf("request = %+v", request)
	}
	_ = office.engine.Do(func() {
		if project := office.engine.Project(created.ID); len(project.Opening) != 1 {
			t.Errorf("opening = %+v", project.Opening)
		}
	})
}

func TestStartingAtADeskSaysWhatIsMissing(t *testing.T) {
	office, fake := newLaunchOffice(t)
	mabari := models.AgentDef{ID: "account:mabari", Kind: models.DefClaude, Name: "mabari", Scope: models.DefAccount, Enabled: true, System: true}
	off := plannerFile
	off.ID, off.Name, off.Enabled = "account:off", "off", false
	withDefs(office, plannerFile, mabari, off)
	for _, c := range []struct{ body string }{
		{`{"defId":"account:planner","task":"Plan it"}`},
		{`{"defId":"account:mabari","task":"Plan it"}`},
		{`{"defId":"account:off","task":"Plan it"}`},
		{`{"defId":"account:planner","task":"  "}`},
	} {
		if response := office.do(t, http.MethodPost, "/api/desks/start", c.body); response.Code != http.StatusBadRequest {
			t.Errorf("%s = %d %s", c.body, response.Code, response.Body)
		}
	}
	if response := office.do(t, http.MethodPost, "/api/desks/start", `{"defId":"account:gone","task":"x"}`); response.Code != http.StatusNotFound {
		t.Errorf("gone = %d", response.Code)
	}
	if len(fake.requests) != 0 {
		t.Errorf("Claude Code opened: %+v", fake.requests)
	}
}

// shopWithFolder makes a project with a folder, for real starts.
func shopWithFolder(t *testing.T, office *office) models.Project {
	t.Helper()
	created := decode[models.Project](t, office.do(t, http.MethodPost, "/api/projects", `{"name":"Shop","color":"#48DBFB"}`))
	if response := office.do(t, http.MethodPatch, "/api/projects/"+created.ID, `{"folder":"`+t.TempDir()+`"}`); response.Code != http.StatusOK {
		t.Fatalf("attach = %d %s", response.Code, response.Body)
	}
	return created
}

// Nothing that could be read as an option or a control sequence reaches Claude Code's command
// line, and a completed project or a shadowed agent file is turned down, all before any window.
func TestStartingAtADeskGuardsTheCommandLine(t *testing.T) {
	office, fake := newLaunchOffice(t)
	odd := plannerFile
	odd.ID, odd.Name = "account:odd", "-x odd"
	shadow := plannerFile
	shadow.ID, shadow.Scope = "project:SHOP:planner", models.DefProject
	shop := shopWithFolder(t, office)
	shadow.ID, shadow.ProjectID = "project:"+shop.ID+":planner", shop.ID
	withDefs(office, plannerFile, odd, shadow)
	done := decode[models.Project](t, office.do(t, http.MethodPost, "/api/projects", `{"name":"Old","color":"#48DBFB"}`))
	_ = office.engine.Do(func() {
		project := *office.engine.Project(done.ID)
		project.Repository = &models.Repository{Path: t.TempDir()}
		project.Done = &models.ProjectDone{}
		office.engine.SaveProject(project)
	})
	for _, body := range []string{
		`{"defId":"account:planner","projectId":"` + shop.ID + `","task":"--dangerously-skip-permissions"}`,
		`{"defId":"account:planner","projectId":"` + shop.ID + `","task":"Plan \u001b[2J it"}`,
		`{"defId":"account:odd","projectId":"` + shop.ID + `","task":"Plan it"}`,
		`{"defId":"account:planner","projectId":"` + done.ID + `","task":"Plan it"}`,
		`{"defId":"account:planner","projectId":"` + shop.ID + `","task":"Plan it"}`,
	} {
		if response := office.do(t, http.MethodPost, "/api/desks/start", body); response.Code != http.StatusBadRequest {
			t.Errorf("%s = %d %s", body, response.Code, response.Body)
		}
	}
	if len(fake.requests) != 0 {
		t.Errorf("Claude Code opened: %+v", fake.requests)
	}
	// The project's own planner is the one to pick.
	response := office.do(t, http.MethodPost, "/api/desks/start", `{"defId":"`+shadow.ID+`","task":"Plan it"}`)
	if response.Code != http.StatusOK || fake.last(t).Agent != "planner" {
		t.Errorf("own = %d %s", response.Code, response.Body)
	}
}

// When no window opens, the notice says how to start it by hand, as that agent, and the task
// waits in the project for the session to take it.
func TestStartingAtADeskByHand(t *testing.T) {
	office, fake := newLaunchOffice(t)
	fake.err = launch.ErrNoTerminal
	withDefs(office, plannerFile)
	shop := shopWithFolder(t, office)
	result := decode[deskStartResult](t, office.do(t, http.MethodPost, "/api/desks/start",
		`{"defId":"account:planner","projectId":"`+shop.ID+`","task":"Plan it"}`))
	if result.Opened || !strings.Contains(result.Notice, "claude --agent planner") {
		t.Errorf("result = %+v", result)
	}
	_ = office.engine.Do(func() {
		if opening := office.engine.Project(shop.ID).Opening; len(opening) != 1 || opening[0].Text != "Plan it" {
			t.Errorf("opening = %+v", opening)
		}
	})
}

// In the demo, "No project" means no project, not the first one.
func TestStartingAtADeskInTheDemoWithNoProject(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	withDefs(office, plannerFile)
	result := decode[deskStartResult](t, office.do(t, http.MethodPost, "/api/desks/start", `{"defId":"account:planner","task":"Plan it"}`))
	if result.Agent == nil || result.Agent.Project != nil {
		t.Errorf("agent = %+v", result.Agent)
	}
}

// In the demo the agent file's agent sits down at once, at the free desk, working on the task.
func TestStartingAtADeskInTheDemo(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	withDefs(office, plannerFile)
	response := office.do(t, http.MethodPost, "/api/desks/start", `{"defId":"account:planner","task":"Plan the release"}`)
	result := decode[deskStartResult](t, response)
	if response.Code != http.StatusCreated || result.Agent == nil {
		t.Fatalf("start = %d %s", response.Code, response.Body)
	}
	agent := agentNamed(t, office, "planner")
	if agent.DefID != "account:planner" || agent.Task != "Plan the release" || agent.Desk < 0 {
		t.Errorf("agent = %+v", agent.Agent)
	}
}

// Mabari's map of the projects is served as JSON and as the Markdown it keeps for any AI.
func TestTheProjectMapIsServed(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	m := decode[projectmap.Map](t, office.do(t, http.MethodGet, "/api/map", ""))
	if len(m.Projects) == 0 || len(m.Projects[0].Agents) == 0 {
		t.Fatalf("map = %+v", m)
	}
	md := office.do(t, http.MethodGet, "/api/map?format=md", "")
	if !strings.HasPrefix(md.Body.String(), "# Mabari's map of the projects") ||
		!strings.Contains(md.Body.String(), "## "+m.Projects[0].Name) {
		t.Errorf("markdown = %s", md.Body)
	}
}
