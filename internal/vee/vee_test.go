// SPDX-License-Identifier: Apache-2.0

package vee

import (
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
)

var now = time.UnixMilli(1_800_000_000_000)

func agent(name string, state models.AgentState) *models.LiveAgent {
	a := &models.LiveAgent{}
	a.ID, a.Name, a.Hue, a.Task = "id-"+strings.ToLower(name), name, "#123456", "Do "+name+"'s work"
	a.State, a.Progress, a.Rate = state, 0.5, 0.002
	return a
}

func office() []*models.LiveAgent {
	atlas := agent("Atlas", models.StateApproval)
	atlas.Approval = &models.Approval{
		ID: "ap-1", Type: models.ApprovalCommand, Detail: models.ApprovalDetail{Cmd: "npm run db:migrate"},
	}
	scribe := agent("Atlas scribe", models.StateEditing)
	ledger := agent("Ledger", models.StateEditing)
	ledger.Account, ledger.Provider = models.AccountClaudeCode, models.ProviderClaude
	mori := agent("Mori", models.StateError)
	mori.Error = "Lost the connection"
	return []*models.LiveAgent{atlas, scribe, ledger, mori, agent("Pixel", models.StateIdle)}
}

func TestRules(t *testing.T) {
	tests := []struct {
		name, text, gesture string
		kind                Kind
		contains            string
	}{
		{"gesture", "Can you do a little dance?", "dance", KindPlain, "Don't mind if I do."},
		{"gesture by label", "shake head please", "shake", KindPlain, "Nope"},
		{"star jump stays a jump", "star jump", "jump", KindPlain, "Wheee!"},
		{"short gesture", "wave", "wave", KindPlain, "Hello there!"},
		{"greeting", "hello", "wave", KindPlain, "2 of your 5 agents are working"},
		{"thanks", "thanks Mabari", "bow", KindPlain, "Any time."},
		{"needs", "Who needs me?", "point", KindNeeds, "2 things need you."},
		{"when", "When will everything be done?", "nod", KindWhen, "around"},
		{"eta as a word", "what's the eta", "nod", KindWhen, "will be last."},
		{"how long", "how long until it's all done", "nod", KindWhen, "will be last."},
		{"finish", "will they finish soon?", "nod", KindWhen, "will be last."},
		{"new agent for", "add an agent for the docs", "point", KindNewAgent, ""},
		{"project", "Start a new project", "shrug", KindPlain, "later stage"},
		{"new agent", "Create a new agent", "point", KindNewAgent, ""},
		{"improve", "improve the code reviewer", "nod", KindImprove, ""},
		{"builder", "open my agents", "point", KindBuilder, "agent builder"},
		{"office", "show me the floor", "point", KindOffice, "office floor"},
		{"status", "What's happening?", "point", KindStatus, "2 agents are working and 2 need you."},
		{"catch me up", "catch me up", "point", KindStatus, "2 agents are working"},
		{"who is", "who is around", "point", KindStatus, "2 agents"},
		{"a named agent", "What is Ledger doing?", "point", KindPlain, "Ledger (Claude) is editing: Do Ledger's work."},
		{"no replies yet", "What did Claude say?", "shrug", KindPlain, "No AI replies yet."},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			reply := Answer(test.text, office(), now)
			if reply.Gesture != test.gesture || reply.Kind != test.kind ||
				!strings.Contains(reply.Text, test.contains) {
				t.Errorf("got %q %q %q", reply.Gesture, reply.Kind, reply.Text)
			}
			if reply.Send != nil {
				t.Errorf("should not pass a message on: %+v", reply.Send)
			}
		})
	}
}

func TestSubstringsAreNotWords(t *testing.T) {
	for _, text := range []string{"the endpoint is slow", "elbow room", "what are they up to", "metadata looks odd"} {
		reply := Answer(text, office(), now)
		if !reply.Dispatch {
			t.Errorf("%q: got %q %q", text, reply.Kind, reply.Text)
		}
	}
}

// Everything that isn't a question about the office is a task for the dispatcher, even when it
// shares words with one.
func TestTasksAreDispatched(t *testing.T) {
	for _, text := range []string{
		"update the README",
		"finish the login page",
		"Point the API to staging",
		"wave the new flag through to production",
		"the invoice rounding is wrong",
		"add a status column to the agents table",
		"hey can you fix the flaky test in checkout",
		"add a new agent endpoint to the API",
		"show the error message when login fails",
		"make the approvals page faster",
	} {
		reply := Answer(text, office(), now)
		if !reply.Dispatch || reply.Send != nil {
			t.Errorf("%q: got %q %q", text, reply.Kind, reply.Text)
		}
	}
}

// Gestures only run for short asks, or "can you" with a short ask after it.
func TestGesturesNeedAShortAsk(t *testing.T) {
	for text, gesture := range map[string]string{
		"dance":                 "dance",
		"do a spin":             "spin",
		"can you take a bow":    "bow",
		"could you wave at me?": "wave",
		"give me a wink":        "wink",
	} {
		if reply := Answer(text, office(), now); reply.Gesture != gesture || reply.Dispatch {
			t.Errorf("%q: got %q dispatch=%v", text, reply.Gesture, reply.Dispatch)
		}
	}
	if reply := Answer("can you point the checkout API to staging", office(), now); !reply.Dispatch {
		t.Errorf("a long can-you ask played %q", reply.Gesture)
	}
}

func TestIsQuestion(t *testing.T) {
	for text, want := range map[string]bool{
		"what's happening":          true,
		"Is Ledger done":            true,
		"eta":                       true,
		"anything need me":          true,
		"the build is broken?":      true,
		"update the status page":    false,
		"status":                    true,
		"finish the login page":     false,
		"have Rune check the state": false,
	} {
		if got := IsQuestion(text); got != want {
			t.Errorf("%q: got %v", text, got)
		}
	}
}

func TestLatestReplies(t *testing.T) {
	agents := office()
	ledger, pixel := agents[2], agents[4]
	ledger.Asked = []models.Instruction{{ID: "i1", Text: "add tests", Reply: "Added 4 tests.", RepliedAt: 10}}
	pixel.Provider = models.ProviderOpenAI
	pixel.Account = models.AccountCodex
	pixel.Asked = []models.Instruction{{ID: "i2", Text: "fix css", Reply: "Fixed the header spacing.", RepliedAt: 20}}
	reply := Answer("what did the AI say?", agents, now)
	if reply.Kind != KindReplies || len(reply.Lines) != 2 {
		t.Fatalf("got %+v", reply)
	}
	if line := reply.Lines[0]; line.Name != "Pixel" || line.AI != "ChatGPT" || line.Reply != "Fixed the header spacing." {
		t.Errorf("newest first: %+v", line)
	}
	if got := Answer("how is Ledger doing?", agents, now).Text; !strings.Contains(got, "Its last reply: Added 4 tests.") {
		t.Errorf("got %q", got)
	}
}

func TestMessagesBeatGestures(t *testing.T) {
	reply := Answer("Tell Ledger to fix the endpoint and dance", office(), now)
	if reply.Send == nil || reply.Send.AgentID != "id-ledger" || reply.Send.Text != "fix the endpoint and dance" {
		t.Fatalf("got %+v", reply.Send)
	}
	if reply.Send.Mode != models.ModeInstruct {
		t.Errorf("mode = %q", reply.Send.Mode)
	}
}

func TestPassingMessagesOn(t *testing.T) {
	tests := []struct {
		text, agent, body string
		mode              models.InstructionMode
	}{
		{"tell Pixel to add Tests", "id-pixel", "add Tests", models.ModeInstruct},
		{"please tell pixel add tests", "id-pixel", "add tests", models.ModeInstruct},
		{"Tell Ledger to add tests", "id-ledger", "add tests", models.ModeInstruct},
		{"ask Ledger how it is going", "id-ledger", "how it is going", models.ModeQuery},
		{"tell Atlas scribe to rest", "id-atlas scribe", "rest", models.ModeInstruct},
	}
	for _, test := range tests {
		reply := Answer(test.text, office(), now)
		if reply.Send == nil || reply.Send.AgentID != test.agent || reply.Send.Text != test.body ||
			reply.Send.Mode != test.mode || reply.Dispatch {
			t.Errorf("%q: got %+v, %q", test.text, reply.Send, reply.Text)
		}
	}
}

func TestPassed(t *testing.T) {
	agents := office()
	ledger := agents[2]
	reply := Passed(ledger, Where{InstructionID: "ins-1", Queued: true}, agents, now)
	if !strings.Contains(reply.Text, "It's mid step, so it gets it at its next checkpoint.") ||
		reply.Relay == nil || reply.Relay.AgentID != "id-ledger" || reply.Relay.InstructionID != "ins-1" {
		t.Errorf("got %q %+v", reply.Text, reply.Relay)
	}
	if got := Passed(ledger, Where{InstructionID: "ins-2"}, agents, now).Text; got != "Sent to Ledger. I'll tell you what it says." {
		t.Errorf("got %q", got)
	}
	if reply := Passed(ledger, Where{}, agents, now); reply.Relay != nil || !strings.Contains(reply.Text, "couldn't take that") {
		t.Errorf("got %q %+v", reply.Text, reply.Relay)
	}
}

func TestUnknownAgent(t *testing.T) {
	reply := Answer("tell Nobody to work", office(), now)
	if reply.Send != nil || !strings.Contains(reply.Text, "I couldn't find an agent called nobody. Try one of: Atlas") {
		t.Errorf("got %+v, %q", reply.Send, reply.Text)
	}
}

func TestTellMeIsAQuestion(t *testing.T) {
	if reply := Answer("tell me what's happening", office(), now); reply.Kind != KindStatus {
		t.Errorf("got %q %q", reply.Kind, reply.Text)
	}
}

func TestNeedsListsApprovalsAndErrors(t *testing.T) {
	reply := Answer("anything blocked", office(), now)
	if len(reply.Lines) != 2 {
		t.Fatalf("lines = %+v", reply.Lines)
	}
	if line := reply.Lines[0]; line.Summary != "npm run db:migrate" || line.ApprovalID != "ap-1" {
		t.Errorf("approval line = %+v", line)
	}
	if line := reply.Lines[1]; line.Summary != "Lost the connection" || line.ApprovalID != "" {
		t.Errorf("error line = %+v", line)
	}
}

// An agent asking you a question needs you, and isn't counted as working while it waits.
func TestNeedsListsAWaitingQuestion(t *testing.T) {
	agents := office()
	ledger := agents[2]
	ledger.Question = &models.Question{ID: "q-1", Items: []models.QuestionItem{
		{Question: "Which database?", Options: []models.QuestionOption{{Label: "Postgres"}}},
		{Question: "Which checks?", Options: []models.QuestionOption{{Label: "Lint"}}},
	}}
	reply := Answer("who needs me?", agents, now)
	if reply.Text != "3 things need you." || reply.Working != 1 || len(reply.Lines) != 3 {
		t.Fatalf("reply = %q, %d working, lines %+v", reply.Text, reply.Working, reply.Lines)
	}
	line := reply.Lines[1]
	if line.Name != "Ledger" || line.QuestionID != "q-1" || line.ApprovalID != "" ||
		line.Summary != "is asking you: Which database? (and 1 more question)" {
		t.Errorf("question line = %+v", line)
	}
}

func TestEmptyOffice(t *testing.T) {
	if reply := Answer("what's happening", nil, now); reply.Kind != KindEmpty {
		t.Errorf("got %+v", reply)
	}
	if reply := Answer("when", nil, now); !strings.Contains(reply.Text, "nothing to wait for") {
		t.Errorf("got %q", reply.Text)
	}
	if reply := Answer("who needs me", nil, now); !strings.Contains(reply.Text, "Nothing needs you") {
		t.Errorf("got %q", reply.Text)
	}
}

func TestDispatched(t *testing.T) {
	ledger := office()[2]
	ledger.Provider = models.ProviderClaude
	reply := Dispatched(ledger, "it is already working on checkout.", Where{InstructionID: "ins-1"}, nil, now)
	if want := "On it, sent to Ledger (Claude). It is already working on checkout. I'll read you the reply the moment it lands."; reply.Text != want {
		t.Errorf("got %q", reply.Text)
	}
	if reply.Relay == nil || reply.Relay.Agent != "Ledger" || reply.Relay.AI != "Claude" {
		t.Errorf("relay = %+v", reply.Relay)
	}
	if got := Dispatched(ledger, "", Where{InstructionID: "ins-1"}, nil, now).Text; got != "On it, sent to Ledger (Claude). I'll read you the reply the moment it lands." {
		t.Errorf("got %q", got)
	}
	if got := Dispatched(nil, "", Where{}, nil, now).Text; !strings.Contains(got, "no agent free") {
		t.Errorf("got %q", got)
	}
}

func TestBuilderRequests(t *testing.T) {
	if reply := Answer("Improve the code-reviewer agent", office(), now); reply.Kind != KindImprove || reply.Target != "code-reviewer" {
		t.Errorf("improve: %+v", reply)
	}
	if reply := Answer("create an agent that reviews pull requests for security", office(), now); reply.Kind != KindNewAgent ||
		reply.Target != "reviews pull requests for security" {
		t.Errorf("create: %q %q", reply.Kind, reply.Target)
	}
}
