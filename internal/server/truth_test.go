// SPDX-License-Identifier: Apache-2.0

package server

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
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
