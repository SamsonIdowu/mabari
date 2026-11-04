// SPDX-License-Identifier: Apache-2.0

package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/planner"
)

type planReply struct {
	Plan  planner.Plan `json:"plan"`
	Reply string       `json:"reply"`
}

func TestThePlannerAnswersEachMessage(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	first := decode[planReply](t, office.do(t, http.MethodPost, "/api/planner",
		`{"said":["Build a landing page for our coffee shop"],"files":[{"name":"brief.md","text":"Online ordering"}]}`))
	if first.Plan.Name != "Landing Page Coffee" || first.Plan.LeadName == "" || first.Plan.Minutes != 65 ||
		!strings.HasPrefix(first.Reply, "I read 1 file. Here's a team for it.") {
		t.Fatalf("first = %+v", first)
	}
	// Demo agents' names are taken, so the plan picks others.
	if first.Plan.LeadName == "Ledger" || first.Plan.LeadName == "Scout" {
		t.Errorf("lead = %s", first.Plan.LeadName)
	}
	previous, _ := json.Marshal(first.Plan)
	second := decode[planReply](t, office.do(t, http.MethodPost, "/api/planner",
		`{"said":["Build a landing page for our coffee shop","call it Bean, no tests"],"previous":`+string(previous)+`}`))
	if second.Plan.Name != "Bean" || len(second.Plan.Members) != 1 || !strings.HasPrefix(second.Reply, "Updated.") {
		t.Errorf("second = %+v", second)
	}
	if response := office.do(t, http.MethodPost, "/api/planner", `{"said":[]}`); response.Code != http.StatusBadRequest {
		t.Errorf("empty = %d", response.Code)
	}
	big := `{"said":["x"],"files":[{"name":"a","text":"` + strings.Repeat("a", maxAttachedText+1) + `"}]}`
	if response := office.do(t, http.MethodPost, "/api/planner", big); response.Code != http.StatusBadRequest {
		t.Errorf("a large file = %d", response.Code)
	}
}

func startJSON(t *testing.T, office *office, extra string) *planReply {
	t.Helper()
	reply := decode[planReply](t, office.do(t, http.MethodPost, "/api/planner", `{"said":["Build a coffee shop site"]}`))
	plan, _ := json.Marshal(reply.Plan)
	body := `{"plan":` + string(plan) + `,"name":"Coffee shop","instructions":"Use TypeScript","files":["brief.md"],` + extra + `}`
	response := office.do(t, http.MethodPost, "/api/projects/start", body)
	if response.Code != http.StatusCreated {
		t.Fatalf("start = %d %s", response.Code, response.Body)
	}
	return &reply
}

func TestStartingAProjectSeatsItsLead(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	reply := startJSON(t, office, `"folder":"~/code/coffee","mode":"go","brief":"Build a coffee shop site"`)
	snapshot := decode[models.Snapshot](t, office.do(t, http.MethodGet, "/api/snapshot", ""))
	var project *models.Project
	for index := range snapshot.Projects {
		if snapshot.Projects[index].Name == "Coffee shop" {
			project = &snapshot.Projects[index]
		}
	}
	if project == nil || project.Instructions != "Use TypeScript" || project.Repository == nil ||
		project.Repository.Path != "~/code/coffee" || strings.Join(project.Files, ",") != "brief.md" {
		t.Fatalf("project = %+v", project)
	}
	var lead *models.LiveAgent
	for index := range snapshot.Agents {
		if snapshot.Agents[index].Name == reply.Plan.LeadName {
			lead = &snapshot.Agents[index]
		}
	}
	if lead == nil || lead.Project == nil || *lead.Project != project.ID || lead.Folder != "~/code/coffee" {
		t.Fatalf("lead = %+v", lead)
	}
	recent := decode[[]string](t, office.do(t, http.MethodGet, "/api/folders/recent", ""))
	if len(recent) == 0 || recent[0] != "~/code/coffee" {
		t.Errorf("recent = %v", recent)
	}
}

func TestStartRefusesBadInput(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	reply := decode[planReply](t, office.do(t, http.MethodPost, "/api/planner", `{"said":["Build it"]}`))
	plan, _ := json.Marshal(reply.Plan)
	for name, body := range map[string]string{
		"no name":    `{"plan":` + string(plan) + `,"name":" ","mode":"go"}`,
		"bad mode":   `{"plan":` + string(plan) + `,"name":"X","mode":"later"}`,
		"bad url":    `{"plan":` + string(plan) + `,"name":"X","mode":"go","folder":"https://x.dev/a;rm -rf ~"}`,
		"bad branch": `{"plan":` + string(plan) + `,"name":"X","mode":"go","folder":"https://github.com/a/b","branch":"--upload-pack=x"}`,
		"relative":   `{"plan":` + string(plan) + `,"name":"X","mode":"go","folder":"code/shop"}`,
		"long name":  `{"plan":` + string(plan) + `,"name":"` + strings.Repeat("x", 40) + `","mode":"go"}`,
	} {
		if response := office.do(t, http.MethodPost, "/api/projects/start", body); response.Code != http.StatusBadRequest {
			t.Errorf("%s = %d", name, response.Code)
		}
	}
}

// Outside the demo, Claude Code sessions start in the person's terminal, so starting a project
// makes it and says how, without pretending to start agents.
func TestARealClaudeProjectWaitsForItsSession(t *testing.T) {
	office := newOffice(t)
	_ = office.engine.Do(func() {
		for _, account := range office.engine.Accounts() {
			if account.Kind == models.AccountClaudeCode {
				account.Status = models.AccountConnected
				office.engine.SetAccount(account)
			}
		}
	})
	reply := decode[planReply](t, office.do(t, http.MethodPost, "/api/planner", `{"said":["Build a coffee shop site"]}`))
	plan, _ := json.Marshal(reply.Plan)
	response := office.do(t, http.MethodPost, "/api/projects/start",
		`{"plan":`+string(plan)+`,"name":"Coffee shop","mode":"go","folder":"~/code/coffee"}`)
	result := decode[map[string]any](t, response)
	if response.Code != http.StatusCreated || !strings.Contains(result["notice"].(string), "Run claude in ~/code/coffee") {
		t.Fatalf("start = %d %v", response.Code, result)
	}
	if snapshot := decode[models.Snapshot](t, office.do(t, http.MethodGet, "/api/snapshot", "")); len(snapshot.Agents) != 0 {
		t.Errorf("agents = %d", len(snapshot.Agents))
	}
}

func TestStartNeedsAConnectedAccountOutsideTheDemo(t *testing.T) {
	office := newOffice(t)
	reply := decode[planReply](t, office.do(t, http.MethodPost, "/api/planner", `{"said":["Build it, use codex"]}`))
	plan, _ := json.Marshal(reply.Plan)
	response := office.do(t, http.MethodPost, "/api/projects/start", `{"plan":`+string(plan)+`,"name":"X","mode":"go"}`)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "Connect ChatGPT (Codex) first") {
		t.Errorf("start = %d %s", response.Code, response.Body)
	}
}

func TestFolderChecks(t *testing.T) {
	office := newOffice(t)
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "package.json"), []byte("{}"), 0o600)
	check := func(body string) folderCheck {
		return decode[folderCheck](t, office.do(t, http.MethodPost, "/api/folders/check", body))
	}
	if got := check(`{"path":"` + dir + `/"}`); got.Error != "" || got.Scan == nil || got.Scan.Lang != "TypeScript" {
		t.Errorf("folder = %+v", got)
	}
	if got := check(`{"path":"code/shop"}`); !strings.Contains(got.Error, "full path") {
		t.Errorf("relative = %+v", got)
	}
	if got := check(`{"path":"https://github.com/you/coffee-shop.git","allowUrl":true}`); !got.URL || got.Name != "coffee-shop" {
		t.Errorf("url = %+v", got)
	}
	if got := check(`{"path":"https://github.com/you/shop"}`); got.Error == "" {
		t.Error("a URL was accepted where only folders are")
	}
	if got := check(`{"path":"` + dir + `/missing"}`); !strings.Contains(got.Error, "no folder") {
		t.Errorf("missing = %+v", got)
	}
}
