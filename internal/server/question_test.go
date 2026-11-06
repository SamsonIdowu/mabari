// SPDX-License-Identifier: Apache-2.0

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/connectors/claudecode"
	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
)

const askHook = `{"session_id":"00000000-0000-4000-8000-000000000001","cwd":"/tmp/shop","hook_event_name":"PreToolUse","tool_name":"AskUserQuestion",
"tool_input":{"questions":[{"question":"Which database?","header":"Database","multiSelect":false,
"options":[{"label":"Postgres","description":"A server"},{"label":"SQLite","description":"One file"}]},
{"question":"Which checks?","header":"Checks","multiSelect":true,
"options":[{"label":"Lint","description":""},{"label":"Tests","description":""}]}]}}`

// The person answers Claude's question in Mabari, and the hook hands the answers to Claude.
func TestAnsweringAQuestionThroughTheAPI(t *testing.T) {
	o := newClaudeOffice(t)
	o.do(t, http.MethodPost, "/api/accounts/claude/connect", `{"confirm":true}`)
	token, _ := o.vault.Get(claudecode.TokenName)
	// A page is open, so Mabari asks rather than leaving it to Claude Code.
	joined := o.engine.Subscribe(events.Resume{})
	defer o.engine.Unsubscribe(joined.Sub)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- o.hook(t, token, "PreToolUse", askHook) }()

	var question models.Question
	for range 400 {
		agent := decode[models.LiveAgent](t, o.do(t, http.MethodGet, "/api/agents/cc-00000000-0000-4000-8000-000000000001", ""))
		if agent.Question != nil {
			question = *agent.Question
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if question.ID == "" || len(question.Items) != 2 || question.Items[0].Options[1].Label != "SQLite" {
		t.Fatalf("question = %+v", question)
	}
	answer := func(agent, body string) *httptest.ResponseRecorder {
		return o.do(t, http.MethodPost, "/api/agents/"+agent+"/answer", body)
	}
	good := `{"questionId":"` + question.ID + `","answers":[{"picked":[1]},{"picked":[0,1],"other":"Types"}]}`
	cases := []struct {
		name, agent, body string
		code              int
	}{
		{"unknown agent", "cc-nobody", good, http.StatusNotFound},
		{"wrong question id", "cc-00000000-0000-4000-8000-000000000001", `{"questionId":"question-x","answers":[{"picked":[1]},{"picked":[0]}]}`, http.StatusConflict},
		{"no question id", "cc-00000000-0000-4000-8000-000000000001", `{"answers":[{"picked":[1]}]}`, http.StatusBadRequest},
		{"too few answers", "cc-00000000-0000-4000-8000-000000000001", `{"questionId":"` + question.ID + `","answers":[{"picked":[1]}]}`, http.StatusBadRequest},
		{"no such option", "cc-00000000-0000-4000-8000-000000000001", `{"questionId":"` + question.ID + `","answers":[{"picked":[7]},{"picked":[0]}]}`, http.StatusBadRequest},
		{"two for one", "cc-00000000-0000-4000-8000-000000000001", `{"questionId":"` + question.ID + `","answers":[{"picked":[0,1]},{"picked":[0]}]}`, http.StatusBadRequest},
		{"empty answer", "cc-00000000-0000-4000-8000-000000000001", `{"questionId":"` + question.ID + `","answers":[{"other":" "},{"picked":[0]}]}`, http.StatusBadRequest},
		{"words too long", "cc-00000000-0000-4000-8000-000000000001", `{"questionId":"` + question.ID + `","answers":[{"other":"` + strings.Repeat("a", models.AnswerOtherMax+1) + `"},{"picked":[0]}]}`, http.StatusBadRequest},
		{"unknown field", "cc-00000000-0000-4000-8000-000000000001", `{"questionId":"` + question.ID + `","answers":[{"picked":[1]},{"picked":[0]}],"approve":true}`, http.StatusBadRequest},
		{"five answers", "cc-00000000-0000-4000-8000-000000000001", `{"questionId":"` + question.ID + `","answers":[{},{},{},{},{}]}`, http.StatusBadRequest},
	}
	for _, test := range cases {
		if response := answer(test.agent, test.body); response.Code != test.code {
			t.Errorf("%s = %d %s", test.name, response.Code, response.Body)
		}
	}
	if response := answer("cc-00000000-0000-4000-8000-000000000001", good); response.Code != http.StatusOK {
		t.Fatalf("answer = %d %s", response.Code, response.Body)
	}
	// A second tab answering the same question is told it has gone.
	if response := answer("cc-00000000-0000-4000-8000-000000000001", good); response.Code != http.StatusConflict {
		t.Errorf("second answer = %d", response.Code)
	}
	response := <-done
	if response.Code != http.StatusOK {
		t.Fatalf("hook = %d", response.Code)
	}
	if response.Header().Get(claudecode.SignatureHeader) == "" {
		t.Error("the reply isn't signed")
	}
	var reply struct {
		Specific struct {
			Decision string `json:"permissionDecision"`
			Input    struct {
				Questions []models.QuestionItem `json:"questions"`
				Answers   map[string]string     `json:"answers"`
			} `json:"updatedInput"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &reply); err != nil {
		t.Fatalf("reply = %s", response.Body)
	}
	answers := reply.Specific.Input.Answers
	if reply.Specific.Decision != "allow" || len(reply.Specific.Input.Questions) != 2 ||
		answers["Which database?"] != "SQLite" || answers["Which checks?"] != "Lint, Tests, Types" {
		t.Errorf("reply = %s", response.Body)
	}
	agent := decode[models.LiveAgent](t, o.do(t, http.MethodGet, "/api/agents/cc-00000000-0000-4000-8000-000000000001", ""))
	if agent.Question != nil {
		t.Error("the question is still showing")
	}
}
