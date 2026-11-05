// SPDX-License-Identifier: Apache-2.0

package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/planner"
)

// An instruction to an agent paused on an approval is held, not answered "Got it", and is
// delivered once the approval is allowed (FIRST-2). The same goes through Home's chat, which says
// why it waits.
func TestAnInstructionToAnAgentWaitingOnAnApprovalIsHeldUntilItIsAllowed(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	atlas := agentNamed(t, office, "Atlas")
	if atlas.State != models.StateApproval || atlas.Approval == nil {
		t.Fatalf("Atlas is %s", atlas.State)
	}
	body := `{"text":"After the migration, also seed the test data","mode":"instruct","target":"` + atlas.ID + `"}`
	if response := office.do(t, http.MethodPost, "/api/messages", body); response.Code != http.StatusOK {
		t.Fatalf("send = %d", response.Code)
	}
	held := agentNamed(t, office, "Atlas")
	if len(held.Queued) != 1 || len(held.Asked) != 0 || held.Reply != "" || held.State != models.StateApproval {
		t.Fatalf("held: queued %d, asked %d, reply %q, state %s", len(held.Queued), len(held.Asked), held.Reply, held.State)
	}
	rows := decode[[]models.LogEntry](t, office.do(t, http.MethodGet, "/api/activity?q=seed%20the%20test", ""))
	if len(rows) != 1 || rows[0].Outcome != "Waiting for checkpoint" || rows[0].Chip != "amber" {
		t.Errorf("rows = %+v", rows)
	}

	path := "/api/approvals/" + held.Approval.ID + "/decision"
	if response := office.do(t, http.MethodPost, path, `{"decision":"allowed"}`); response.Code != http.StatusOK {
		t.Fatalf("allow = %d", response.Code)
	}
	after := agentNamed(t, office, "Atlas")
	if len(after.Queued) != 0 || len(after.Asked) != 1 || after.State == models.StateApproval ||
		after.Asked[0].Reply != "Got it: After the migration, also seed the test data." {
		t.Errorf("after allow: queued %d, asked %+v, state %s", len(after.Queued), after.Asked, after.State)
	}
	rows = decode[[]models.LogEntry](t, office.do(t, http.MethodGet, "/api/activity?q=seed%20the%20test", ""))
	if len(rows) != 1 || rows[0].Outcome != "Replied" {
		t.Errorf("rows after = %+v", rows)
	}
}

func TestHomeSaysAnAgentWaitingOnYouGetsTheMessageAfterYouDecide(t *testing.T) {
	office := newOffice(t)
	office.demo(t)
	result := askVee(t, office, `{"text":"tell Atlas to also seed the test data"}`)
	want := "Atlas is waiting for your approval, so it gets it once you decide."
	if !strings.Contains(result.Reply.Text, want) || result.Reply.Relay == nil {
		t.Errorf("reply = %q, relay %+v", result.Reply.Text, result.Reply.Relay)
	}
	if got := agentNamed(t, office, "Atlas"); len(got.Queued) != 1 || got.Reply != "" {
		t.Errorf("queued %d, reply %q", len(got.Queued), got.Reply)
	}
}

// With nothing connected, Home's reply to a task says where to start (SETUP-9).
func TestVeeSaysHowToGetAnAgentWhenThereIsNone(t *testing.T) {
	office := newOffice(t)
	result := askVee(t, office, `{"text":"build me a todo app"}`)
	for _, want := range []string{"no agent free", "Accounts", "New agent", "send this again"} {
		if !strings.Contains(result.Reply.Text, want) {
			t.Errorf("reply %q lacks %q", result.Reply.Text, want)
		}
	}
	if result.Message != nil {
		t.Errorf("a message was sent: %+v", result.Message)
	}
}

// The demo's Claude agent asks a question, and answering it through the API takes it down and
// lets the agent carry on (FIRST-11).
func TestAnsweringTheDemosQuestionThroughTheAPI(t *testing.T) {
	office := newOffice(t)
	office.simulator.SetDemoQuestion(time.Millisecond)
	office.demo(t)
	if err := office.engine.Do(func() { office.engine.AgentByName("Sage").Queued = []models.Instruction{} }); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)
	if err := office.simulator.Tick(); err != nil {
		t.Fatal(err)
	}
	sage := agentNamed(t, office, "Sage")
	if sage.Question == nil || len(sage.Question.Items) != 2 || sage.Provider != models.ProviderClaude {
		t.Fatalf("Sage's question = %+v", sage.Question)
	}
	// Home counts it among what needs you, and its agent isn't working.
	needs := askVee(t, office, `{"text":"who needs me?"}`)
	found := false
	for _, line := range needs.Reply.Lines {
		found = found || line.Name == "Sage" && line.QuestionID == sage.Question.ID
	}
	if !found {
		t.Errorf("Mabari doesn't list Sage's question: %+v", needs.Reply.Lines)
	}

	path := "/api/agents/" + sage.ID + "/answer"
	good := `{"questionId":"` + sage.Question.ID + `","answers":[{"picked":[0]},{"picked":[1]}]}`
	if response := office.do(t, http.MethodPost, path, `{"questionId":"`+sage.Question.ID+`","answers":[{"picked":[0]}]}`); response.Code != http.StatusBadRequest {
		t.Errorf("one answer for two questions = %d", response.Code)
	}
	if response := office.do(t, http.MethodPost, path, good); response.Code != http.StatusOK {
		t.Fatalf("answer = %d: %s", response.Code, response.Body)
	}
	after := agentNamed(t, office, "Sage")
	if after.Question != nil || !after.Working || after.Reply != "Thanks. Going with Cursor-based and Link headers." {
		t.Errorf("after: question %v, working %v, reply %q", after.Question, after.Working, after.Reply)
	}
	if response := office.do(t, http.MethodPost, path, good); response.Code != http.StatusConflict {
		t.Errorf("answering twice = %d", response.Code)
	}
}

// Loading the demo says when it ends, and that is the time the snapshot, and so the banner,
// shows: ten minutes from now (NEW-1).
func TestLoadingTheDemoSaysWhenItEnds(t *testing.T) {
	office := newOffice(t)
	before := time.Now()
	response := office.do(t, http.MethodPost, "/api/demo/load", "")
	if response.Code != http.StatusOK {
		t.Fatalf("load = %d", response.Code)
	}
	loaded := decode[struct {
		OK     bool  `json:"ok"`
		EndsAt int64 `json:"endsAt"`
	}](t, response)
	snapshot := decode[models.Snapshot](t, office.do(t, http.MethodGet, "/api/snapshot", ""))
	if !loaded.OK || loaded.EndsAt == 0 || loaded.EndsAt != snapshot.DemoEndsAt || !snapshot.Demo {
		t.Fatalf("load said it ends at %d, the snapshot at %d (demo %v)", loaded.EndsAt, snapshot.DemoEndsAt, snapshot.Demo)
	}
	left := time.UnixMilli(loaded.EndsAt).Sub(before)
	if left < 9*time.Minute+55*time.Second || left > 10*time.Minute+5*time.Second {
		t.Errorf("the demo ends in %v, and the page says ten minutes", left)
	}
}

// The planner names a project from accented and non-Latin letters (SETUP-11), the name fits what
// starting a project accepts, and a name with no plain letters still gets a folder.
func TestThePlannerKeepsAccentsAndOtherScripts(t *testing.T) {
	if planner.NameMax != maxProjectName {
		t.Fatalf("the planner's longest name is %d, the server's is %d", planner.NameMax, maxProjectName)
	}
	office := newOffice(t)
	office.demo(t)
	for brief, want := range map[string]string{
		"Café ordering für Zürich app":                      "Café Ordering Zürich",
		"Ünïcödé thing":                                     "Ünïcödé Thing",
		"做一个咖啡店的网站":                                         "做一个咖啡店的网站",
		"Internationalization documentation infrastructure": "Internationalization",
	} {
		reply := decode[planReply](t, office.do(t, http.MethodPost, "/api/planner", `{"said":["`+brief+`"]}`))
		if reply.Plan.Name != want || !strings.HasPrefix(reply.Plan.LeadTask, "Plan "+strings.ToLower(want)+",") {
			t.Errorf("%q: name %q, lead task %q, want %q", brief, reply.Plan.Name, reply.Plan.LeadTask, want)
		}
		plan, _ := json.Marshal(reply.Plan)
		body := `{"plan":` + string(plan) + `,"name":"` + reply.Plan.Name + `","mode":"go","brief":"x"}`
		if response := office.do(t, http.MethodPost, "/api/projects/start", body); response.Code != http.StatusCreated {
			t.Errorf("starting %q = %d %s", reply.Plan.Name, response.Code, response.Body)
		}
	}
	snapshot := decode[models.Snapshot](t, office.do(t, http.MethodGet, "/api/snapshot", ""))
	folders := map[string]string{}
	for _, project := range snapshot.Projects {
		if project.Repository != nil {
			folders[project.Name] = project.Repository.Path
		}
	}
	for name, folder := range map[string]string{
		"Café Ordering Zürich": "~/code/cafe-ordering-zurich",
		"做一个咖啡店的网站":            "~/code/project",
	} {
		if folders[name] != folder {
			t.Errorf("%q works in %q, want %q (%v)", name, folders[name], folder, folders)
		}
	}
}
