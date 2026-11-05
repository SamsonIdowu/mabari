// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
)

// askInput is AskUserQuestion's input as Claude Code sends it, with one single-choice question
// and one that takes several.
func askInput() map[string]any {
	return map[string]any{
		"questions": []map[string]any{
			{"question": "Which database should the shop use?", "header": "Database", "multiSelect": false,
				"options": []map[string]any{
					{"label": "Postgres", "description": "Runs as its own server"},
					{"label": "SQLite", "description": "One file, no server"},
				}},
			{"question": "Which checks should run on every push?", "header": "Checks", "multiSelect": true,
				"options": []map[string]any{
					{"label": "Lint", "description": "Style"},
					{"label": "Tests", "description": "Unit tests"},
					{"label": "Types", "description": "Type check"},
				}},
		},
	}
}

// waitForQuestion waits for the agent's question to show, and returns it.
func waitForQuestion(t *testing.T, engine *events.Engine, id string) *models.Question {
	t.Helper()
	for range 400 {
		var question *models.Question
		_ = engine.Do(func() {
			if agent := engine.Agent(id); agent != nil && agent.Question != nil {
				copied := *agent.Question
				question = &copied
			}
		})
		if question != nil {
			return question
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("no question appeared")
	return nil
}

// asking runs an AskUserQuestion hook in the background while a page is open, and returns the
// channel its reply arrives on.
func asking(t *testing.T, c *Connector, engine *events.Engine, fields map[string]any) <-chan []byte {
	t.Helper()
	joined := engine.Subscribe(events.Resume{})
	t.Cleanup(func() { engine.Unsubscribe(joined.Sub) })
	done := make(chan []byte, 1)
	body := map[string]any{"tool_name": AskTool, "tool_input": askInput()}
	for key, value := range fields {
		body[key] = value
	}
	go func() { done <- hook(t, c, "PreToolUse", body) }()
	return done
}

type preToolReply struct {
	Specific struct {
		Event    string         `json:"hookEventName"`
		Decision string         `json:"permissionDecision"`
		Input    map[string]any `json:"updatedInput"`
	} `json:"hookSpecificOutput"`
}

func TestAnAnswerInMabariIsGivenToClaudeAsUpdatedInput(t *testing.T) {
	c, engine := newConnector(t)
	done := asking(t, c, engine, nil)
	question := waitForQuestion(t, engine, "cc-abc-123")
	if len(question.Items) != 2 || question.Items[0].Header != "Database" || !question.Items[1].MultiSelect ||
		question.Items[1].Options[2].Description != "Type check" {
		t.Errorf("question = %+v", question)
	}
	_ = engine.Do(func() {
		if agent := engine.Agent("cc-abc-123"); agent.Bubble != "Asking you a question" || agent.Working || agent.Approval != nil {
			t.Errorf("agent: bubble %q, working %v", agent.Bubble, agent.Working)
		}
	})
	answers := []models.QuestionAnswer{{Picked: []int{1}}, {Picked: []int{2, 0}, Other: "Docs build"}}
	var err error
	_ = engine.Do(func() { err = engine.AnswerQuestion("cc-abc-123", question.ID, answers) })
	if err != nil {
		t.Fatal(err)
	}
	var reply preToolReply
	raw := <-done
	if err := json.Unmarshal(raw, &reply); err != nil {
		t.Fatalf("reply = %s", raw)
	}
	if reply.Specific.Event != "PreToolUse" || reply.Specific.Decision != "allow" {
		t.Errorf("reply = %s", raw)
	}
	// updatedInput replaces the whole input, so the questions go back exactly as they came.
	sent, _ := json.Marshal(askInput()["questions"])
	echoed, _ := json.Marshal(reply.Specific.Input["questions"])
	if string(sent) != string(echoed) {
		t.Errorf("questions changed:\n%s\n%s", sent, echoed)
	}
	got, _ := reply.Specific.Input["answers"].(map[string]any)
	want := map[string]any{
		"Which database should the shop use?":    "SQLite",
		"Which checks should run on every push?": "Lint, Types, Docs build",
	}
	if len(got) != len(want) {
		t.Errorf("answers = %v", got)
	}
	for key, value := range want {
		if got[key] != value {
			t.Errorf("answers[%q] = %v, want %v", key, got[key], value)
		}
	}
	if agent := agentOf(t, engine); agent.Question != nil || !strings.Contains(agent.Feed[0].Summary, "answered") {
		t.Errorf("after: question %v, feed %+v", agent.Question, agent.Feed[0])
	}
}

func TestOnlyThatAgentsQuestionCanBeAnswered(t *testing.T) {
	c, engine := newConnector(t)
	c.SetWait(300 * time.Millisecond)
	hook(t, c, "SessionStart", map[string]any{"session_id": "other-1"})
	done := asking(t, c, engine, nil)
	question := waitForQuestion(t, engine, "cc-abc-123")
	good := []models.QuestionAnswer{{Picked: []int{0}}, {Picked: []int{1}}}
	cases := map[string]struct {
		agent, question string
		answers         []models.QuestionAnswer
		noQuestion      bool
	}{
		"wrong question id": {"cc-abc-123", "question-nope", good, true},
		"another agent":     {"cc-other-1", question.ID, good, true},
		"no such agent":     {"cc-nobody", question.ID, good, true},
		"too few answers":   {"cc-abc-123", question.ID, good[:1], false},
		"no such option":    {"cc-abc-123", question.ID, []models.QuestionAnswer{{Picked: []int{5}}, {Picked: []int{0}}}, false},
		"two for one":       {"cc-abc-123", question.ID, []models.QuestionAnswer{{Picked: []int{0, 1}}, {Picked: []int{0}}}, false},
	}
	for name, test := range cases {
		var err error
		_ = engine.Do(func() { err = engine.AnswerQuestion(test.agent, test.question, test.answers) })
		if err == nil || errors.Is(err, events.ErrNoQuestion) != test.noQuestion {
			t.Errorf("%s: %v", name, err)
		}
	}
	_ = engine.Do(func() {
		if engine.Agent("cc-abc-123").Question == nil {
			t.Error("a refused answer took the question down")
		}
	})
	// Nothing reached Claude, so it asks in its own window once the wait runs out.
	if reply := <-done; reply != nil {
		t.Errorf("reply = %s", reply)
	}
}

func TestNoAnswerInTimeLeavesClaudeCodesOwnPrompt(t *testing.T) {
	c, engine := newConnector(t)
	c.SetWait(30 * time.Millisecond)
	if reply := <-asking(t, c, engine, nil); reply != nil {
		t.Errorf("reply = %s", reply)
	}
	agent := agentOf(t, engine)
	if agent.Question != nil || agent.Feed[0].Summary != "Left to Claude Code's own prompt" {
		t.Errorf("question %+v, feed %+v", agent.Question, agent.Feed[0])
	}
	// A late answer finds nothing to answer.
	var err error
	_ = engine.Do(func() { err = engine.AnswerQuestion(agent.ID, "question-gone", nil) })
	if !errors.Is(err, events.ErrNoQuestion) {
		t.Errorf("late answer: %v", err)
	}
}

func TestAQuestionWithNobodyWatchingIsAskedInClaudeCode(t *testing.T) {
	c, engine := newConnector(t)
	if reply := hook(t, c, "PreToolUse", map[string]any{"tool_name": AskTool, "tool_input": askInput()}); reply != nil {
		t.Errorf("reply = %s", reply)
	}
	agent := agentOf(t, engine)
	if agent.Question != nil {
		t.Error("a question waits that nobody can see")
	}
	// The feed still says what it asked.
	if agent.Feed[0].Summary != "Ask you: Which database should the shop use?" {
		t.Errorf("feed = %+v", agent.Feed[0])
	}
}

// A question Mabari can't show faithfully is left to Claude Code at once.
func TestQuestionsMabariCantShowAreLeftToClaudeCode(t *testing.T) {
	c, engine := newConnector(t)
	joined := engine.Subscribe(events.Resume{})
	defer engine.Unsubscribe(joined.Sub)
	option := []map[string]any{{"label": "Yes"}}
	same := map[string]any{"question": "Same?", "options": option}
	inputs := map[string]any{
		"no questions":   map[string]any{"questions": []any{}},
		"same text":      map[string]any{"questions": []any{same, same}},
		"no options":     map[string]any{"questions": []any{map[string]any{"question": "Why?", "options": []any{}}}},
		"empty label":    map[string]any{"questions": []any{map[string]any{"question": "Why?", "options": []any{map[string]any{"label": " "}}}}},
		"five questions": map[string]any{"questions": []any{same, same, same, same, same}},
		"not an object":  "ask",
	}
	for name, input := range inputs {
		if reply := hook(t, c, "PreToolUse", map[string]any{"tool_name": AskTool, "tool_input": input}); reply != nil {
			t.Errorf("%s: reply = %s", name, reply)
		}
		if agent := agentOf(t, engine); agent.Question != nil {
			t.Errorf("%s was shown", name)
		}
	}
}

// What Mabari shows has secrets masked, but Claude gets its answers keyed by its own words.
func TestSecretsInAQuestionAreMaskedButTheAnswerKeyIsExact(t *testing.T) {
	c, engine := newConnector(t)
	secret := "Use the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 for the shop?"
	input := map[string]any{"questions": []map[string]any{{"question": secret,
		"options": []map[string]any{{"label": "Yes"}, {"label": "No"}}}}}
	joined := engine.Subscribe(events.Resume{})
	defer engine.Unsubscribe(joined.Sub)
	done := make(chan []byte, 1)
	go func() { done <- hook(t, c, "PreToolUse", map[string]any{"tool_name": AskTool, "tool_input": input}) }()
	question := waitForQuestion(t, engine, "cc-abc-123")
	if strings.Contains(question.Items[0].Question, "abcdefghijklmnop") {
		t.Errorf("shown = %q", question.Items[0].Question)
	}
	_ = engine.Do(func() {
		_ = engine.AnswerQuestion("cc-abc-123", question.ID, []models.QuestionAnswer{{Other: "Ask me later"}})
	})
	var reply preToolReply
	_ = json.Unmarshal(<-done, &reply)
	if got := reply.Specific.Input["answers"].(map[string]any)[secret]; got != "Ask me later" {
		t.Errorf("answers = %v", reply.Specific.Input["answers"])
	}
}

// A subagent's question is shown on the subagent, which is who asked.
func TestASubagentsQuestionIsShownOnTheSubagent(t *testing.T) {
	c, engine := newConnector(t)
	hook(t, c, "UserPromptSubmit", map[string]any{"prompt": "Plan the shop"})
	done := asking(t, c, engine, map[string]any{"agent_id": "h1", "agent_type": "Plan"})
	question := waitForQuestion(t, engine, "cc-abc-123-h1")
	_ = engine.Do(func() {
		if engine.Agent("cc-abc-123").Question != nil {
			t.Error("the lead shows its subagent's question")
		}
		if err := engine.AnswerQuestion("cc-abc-123", question.ID, []models.QuestionAnswer{{Picked: []int{0}}, {Picked: []int{0}}}); !errors.Is(err, events.ErrNoQuestion) {
			t.Errorf("answered through the lead: %v", err)
		}
		if err := engine.AnswerQuestion("cc-abc-123-h1", question.ID, []models.QuestionAnswer{{Picked: []int{0}}, {Picked: []int{0}}}); err != nil {
			t.Error(err)
		}
	})
	var reply preToolReply
	_ = json.Unmarshal(<-done, &reply)
	if reply.Specific.Input["answers"].(map[string]any)["Which database should the shop use?"] != "Postgres" {
		t.Errorf("reply = %+v", reply)
	}
}

// Ending the session takes the question down with the agent.
func TestASessionThatEndsTakesItsQuestionWithIt(t *testing.T) {
	c, engine := newConnector(t)
	c.SetWait(100 * time.Millisecond)
	done := asking(t, c, engine, nil)
	question := waitForQuestion(t, engine, "cc-abc-123")
	hook(t, c, "SessionEnd", map[string]any{"reason": "exit"})
	var err error
	_ = engine.Do(func() {
		err = engine.AnswerQuestion("cc-abc-123", question.ID, []models.QuestionAnswer{{Other: "x"}, {Other: "y"}})
	})
	if !errors.Is(err, events.ErrNoQuestion) {
		t.Errorf("answered after the session ended: %v", err)
	}
	if reply := <-done; reply != nil {
		t.Errorf("reply = %s", reply)
	}
}

// AskUserQuestion is never an approval: allowing it without answers would leave Claude with none.
func TestAQuestionIsNeverAnApproval(t *testing.T) {
	c, engine := newConnector(t)
	joined := engine.Subscribe(events.Resume{})
	defer engine.Unsubscribe(joined.Sub)
	_ = engine.Do(func() { engine.SetAutoApprove(true, "all") })
	if reply := hook(t, c, "PermissionRequest", map[string]any{"tool_name": AskTool, "tool_input": askInput()}); reply != nil {
		t.Errorf("reply = %s", reply)
	}
	if agent := agentOf(t, engine); agent != nil && agent.Approval != nil {
		t.Errorf("approval = %+v", agent.Approval)
	}
}

func TestOnlyQuestionsAndPermissionsWaitForThePerson(t *testing.T) {
	cases := []struct {
		event, body string
		want        bool
	}{
		{"PermissionRequest", `{}`, true},
		{"PreToolUse", `{"tool_name":"AskUserQuestion"}`, true},
		{"PreToolUse", `{"tool_name":"Bash"}`, false},
		{"PreToolUse", `not json`, false},
		{"PostToolUse", `{"tool_name":"AskUserQuestion"}`, false},
	}
	for _, test := range cases {
		if got := waitsForPerson(test.event, []byte(test.body)); got != test.want {
			t.Errorf("%s %s = %v", test.event, test.body, got)
		}
	}
}

// Stopping the agent in Mabari frees its waiting question at once, so Claude Code asks in its own
// window without sitting out the whole wait.
func TestStoppingAnAgentLetsGoOfItsQuestion(t *testing.T) {
	c, engine := newConnector(t)
	c.SetWait(10 * time.Second)
	askCheck = 10 * time.Millisecond
	t.Cleanup(func() { askCheck = time.Second })
	done := asking(t, c, engine, nil)
	waitForQuestion(t, engine, "cc-abc-123")
	_ = engine.Do(func() { c.StopAgent(engine.Agent("cc-abc-123")) })
	select {
	case reply := <-done:
		if reply != nil {
			t.Errorf("reply = %s", reply)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the hook still waits on a question nobody can see")
	}
}

// An agent already asking does not have its question replaced: the newer one is asked in
// Claude Code, so no hook waits on a question nobody can see.
func TestASecondQuestionIsLeftToClaudeCode(t *testing.T) {
	c, engine := newConnector(t)
	c.SetWait(10 * time.Second)
	hook(t, c, "UserPromptSubmit", map[string]any{"prompt": "Plan the shop"})
	joined := engine.Subscribe(events.Resume{})
	t.Cleanup(func() { engine.Unsubscribe(joined.Sub) })
	_ = engine.Do(func() {
		lead := engine.Agent("cc-abc-123")
		engine.Ask(lead, models.Question{Items: []models.QuestionItem{{Question: "First?"}}})
	})
	if reply := hook(t, c, "PreToolUse", map[string]any{"tool_name": AskTool, "tool_input": askInput()}); reply != nil {
		t.Errorf("a second question replaced the first: %s", reply)
	}
	_ = engine.Do(func() {
		lead := engine.Agent("cc-abc-123")
		if lead.Question == nil || lead.Question.Items[0].Question != "First?" {
			t.Errorf("question = %+v", lead.Question)
		}
		engine.DropQuestion(lead, lead.Question.ID)
	})
}

// An answer that reaches no waiting session is not reported as sent.
func TestAnAnswerNobodyHearsIsRefused(t *testing.T) {
	c, engine := newConnector(t)
	hook(t, c, "UserPromptSubmit", map[string]any{"prompt": "Plan the shop"})
	var err error
	_ = engine.Do(func() {
		lead := engine.Agent("cc-abc-123")
		question := engine.Ask(lead, models.Question{Items: []models.QuestionItem{{Question: "First?",
			Options: []models.QuestionOption{{Label: "Yes"}}}}})
		err = engine.AnswerQuestion(lead.ID, question.ID, []models.QuestionAnswer{{Picked: []int{0}}})
		if lead.Question != nil {
			t.Error("the question is still shown")
		}
	})
	if !errors.Is(err, events.ErrNoQuestion) {
		t.Errorf("err = %v", err)
	}
}

// Hooks attached before questions were answered in Mabari time out too soon to wait for one.
func TestOldHooksLeaveQuestionsToClaudeCode(t *testing.T) {
	dir := t.TempDir()
	old := `{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"/bin/mabari","args":["hook","PreToolUse"],"timeout":5}]}]}}`
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	if HookWaits(dir) {
		t.Error("a 5 second hook waits for answers")
	}
	c, engine := newConnector(t)
	c.ConfigDir = dir
	joined := engine.Subscribe(events.Resume{})
	t.Cleanup(func() { engine.Unsubscribe(joined.Sub) })
	if reply := hook(t, c, "PreToolUse", map[string]any{"tool_name": AskTool, "tool_input": askInput()}); reply != nil {
		t.Errorf("reply = %s", reply)
	}
	if agentOf(t, engine).Question != nil {
		t.Error("a question shows that the hook cannot wait for")
	}
	plan, err := PlanAttach(dir, Hook{Binary: "/bin/mabari", Port: 4317})
	if err != nil {
		t.Fatal(err)
	}
	if err := Apply(plan); err != nil {
		t.Fatal(err)
	}
	if !HookWaits(dir) {
		t.Error("attaching again did not update the hooks")
	}
}
