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
	ledger.Account = models.AccountClaudeCode
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
		{"greeting", "hello", "wave", KindPlain, "2 of your 5 agents are working"},
		{"thanks", "thanks Vee", "bow", KindPlain, "Any time."},
		{"needs", "Who needs me?", "point", KindNeeds, "2 things need you."},
		{"when", "When will everything be done?", "nod", KindWhen, "around"},
		{"eta as a word", "what's the eta", "nod", KindWhen, "will be last."},
		{"project", "Start a new project", "shrug", KindPlain, "later stage"},
		{"office", "show me the floor", "point", KindOffice, "office floor"},
		{"status", "What's happening?", "point", KindStatus, "2 agents are working and 2 need you."},
		{"who is", "who is around", "point", KindStatus, "2 agents"},
		{"anything else", "the invoice rounding is wrong", "shrug", KindDispatch, "dispatcher"},
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
		if reply.Kind != KindDispatch {
			t.Errorf("%q: got %q %q", text, reply.Kind, reply.Text)
		}
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
		says              string
	}{
		{"tell Pixel to add Tests", "id-pixel", "add Tests", models.ModeInstruct, "Sent to Pixel."},
		{"please tell pixel add tests", "id-pixel", "add tests", models.ModeInstruct, "Sent to Pixel."},
		{"Tell Ledger to add tests", "id-ledger", "add tests", models.ModeInstruct, "next checkpoint"},
		{"ask Ledger how it is going", "id-ledger", "how it is going", models.ModeQuery, "won't be interrupted"},
		{"tell Atlas scribe to rest", "id-atlas scribe", "rest", models.ModeInstruct, "Sent to Atlas scribe."},
	}
	for _, test := range tests {
		reply := Answer(test.text, office(), now)
		if reply.Send == nil || reply.Send.AgentID != test.agent || reply.Send.Text != test.body ||
			reply.Send.Mode != test.mode || !strings.Contains(reply.Text, test.says) {
			t.Errorf("%q: got %+v, %q", test.text, reply.Send, reply.Text)
		}
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
	if got := Dispatched("Ledger", "it is already on this.", nil, now).Text; got != "Done. I sent it to Ledger. It is already on this." {
		t.Errorf("got %q", got)
	}
	if got := Dispatched("", "", nil, now).Text; !strings.Contains(got, "no agent free") {
		t.Errorf("got %q", got)
	}
}
