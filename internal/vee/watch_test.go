// SPDX-License-Identifier: Apache-2.0

package vee

import (
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// Asking to be told is a request for a watch, never an instruction for anyone.
func TestTellMeWhenSetsAWatchAndSendsNothing(t *testing.T) {
	cases := []struct {
		text string
		want WatchAsk
	}{
		{"tell me when Ledger is done", WatchAsk{Kind: models.WatchAgent, Target: "id-ledger", Name: "Ledger"}},
		{"Tell me when Ledger is done.", WatchAsk{Kind: models.WatchAgent, Target: "id-ledger", Name: "Ledger"}},
		{"tell me when ledger is finished", WatchAsk{Kind: models.WatchAgent, Target: "id-ledger", Name: "Ledger"}},
		{"let me know when Ledger finishes", WatchAsk{Kind: models.WatchAgent, Target: "id-ledger", Name: "Ledger"}},
		{"let me know once Ledger has finished", WatchAsk{Kind: models.WatchAgent, Target: "id-ledger", Name: "Ledger"}},
		{"please notify me as soon as Ledger is done", WatchAsk{Kind: models.WatchAgent, Target: "id-ledger", Name: "Ledger"}},
		{"ping me when the Ledger agent is done", WatchAsk{Kind: models.WatchAgent, Target: "id-ledger", Name: "Ledger"}},
		{"could you tell me when Ledger is done?", WatchAsk{Kind: models.WatchAgent, Target: "id-ledger", Name: "Ledger"}},
		{"tell me when Ledger will be done", WatchAsk{Kind: models.WatchAgent, Target: "id-ledger", Name: "Ledger"}},
		{"I want to know when Ledger is done", WatchAsk{Kind: models.WatchAgent, Target: "id-ledger", Name: "Ledger"}},
		{"tell me when Ledger is done, thanks", WatchAsk{Kind: models.WatchAgent, Target: "id-ledger", Name: "Ledger"}},
		{"tell me when Ledger is done, then tell me", WatchAsk{Kind: models.WatchAgent, Target: "id-ledger", Name: "Ledger"}},
		// The whole name, so Atlas scribe is not Atlas.
		{"tell me when Atlas scribe is done", WatchAsk{Kind: models.WatchAgent, Target: "id-atlas scribe", Name: "Atlas scribe"}},
		{"tell me when Atlas is done", WatchAsk{Kind: models.WatchAgent, Target: "id-atlas", Name: "Atlas"}},
		{"let me know when Experience and Quality finishes", WatchAsk{Kind: models.WatchProject, Target: "eq", Name: "Experience and Quality"}},
		{"let me know when the Lad Project All project is done", WatchAsk{Kind: models.WatchProject, Target: "lad", Name: "Lad Project All"}},
		// The start of a project's name that no other project shares names it too.
		{"tell me when Lad is done", WatchAsk{Kind: models.WatchProject, Target: "lad", Name: "Lad Project All"}},
	}
	for _, tc := range cases {
		reply := AnswerIn(tc.text, inProjects(""), now)
		if reply.Watch == nil || *reply.Watch != tc.want {
			t.Errorf("%q: watch = %+v, want %+v", tc.text, reply.Watch, tc.want)
		}
		if reply.Send != nil || reply.Route != nil || reply.Dispatch {
			t.Errorf("%q was passed on as an instruction: %+v", tc.text, reply)
		}
	}
}

// "when Ledger is done, tell Quill to review it" is a watch that carries an instruction.
func TestWhenDoneTellChainsAnInstruction(t *testing.T) {
	cases := []struct {
		text string
		want WatchAsk
	}{
		{"when Ledger is done, tell Atlas to review it", WatchAsk{
			Kind: models.WatchAgent, Target: "id-ledger", Name: "Ledger",
			ThenAgent: "id-atlas", ThenName: "Atlas", ThenText: "review it"}},
		{"When Ledger finishes tell Atlas review the change", WatchAsk{
			Kind: models.WatchAgent, Target: "id-ledger", Name: "Ledger",
			ThenAgent: "id-atlas", ThenName: "Atlas", ThenText: "review the change"}},
		{"once Ledger is done, ask Atlas to run the tests", WatchAsk{
			Kind: models.WatchAgent, Target: "id-ledger", Name: "Ledger",
			ThenAgent: "id-atlas", ThenName: "Atlas", ThenText: "run the tests"}},
		{"after Ledger has finished, then please tell Atlas scribe to draft the notes", WatchAsk{
			Kind: models.WatchAgent, Target: "id-ledger", Name: "Ledger",
			ThenAgent: "id-atlas scribe", ThenName: "Atlas scribe", ThenText: "draft the notes"}},
		{"tell me when Ledger is done, then tell Atlas to review it", WatchAsk{
			Kind: models.WatchAgent, Target: "id-ledger", Name: "Ledger",
			ThenAgent: "id-atlas", ThenName: "Atlas", ThenText: "review it"}},
		{"when Experience and Quality is done, tell Ledger to write the release notes", WatchAsk{
			Kind: models.WatchProject, Target: "eq", Name: "Experience and Quality",
			ThenAgent: "id-ledger", ThenName: "Ledger", ThenText: "write the release notes"}},
	}
	for _, tc := range cases {
		reply := AnswerIn(tc.text, inProjects(""), now)
		if reply.Watch == nil || *reply.Watch != tc.want {
			t.Errorf("%q: watch = %+v, want %+v", tc.text, reply.Watch, tc.want)
		}
		if reply.Send != nil || reply.Route != nil || reply.Dispatch {
			t.Errorf("%q was passed on as an instruction: %+v", tc.text, reply)
		}
	}
}

// Everything that isn't a request to watch goes the way it always did, in particular "tell Ledger
// to …", which is an instruction, even one about being told.
func TestWatchPhrasesLeaveTheRestAlone(t *testing.T) {
	instructions := map[string]string{
		"tell Ledger to let me know when you're done":    "let me know when you're done",
		"tell Ledger to finish the tests":                "finish the tests",
		"tell Ledger when you're done, run the linter":   "when you're done, run the linter",
		"tell Ledger to tell me when the tests are done": "tell me when the tests are done",
	}
	for text, body := range instructions {
		reply := AnswerIn(text, inProjects(""), now)
		if reply.Watch != nil || reply.Send == nil || reply.Send.AgentID != "id-ledger" || reply.Send.Text != body {
			t.Errorf("%q: %+v send %+v", text, reply.Watch, reply.Send)
		}
	}
	// Questions about when something is done are answered as ever, with the estimate.
	for _, text := range []string{
		"when is Ledger done?", "when will everything be done?", "When will Ledger be done?",
		"tell me when is Ledger done", "how long until Ledger is done",
	} {
		reply := AnswerIn(text, inProjects(""), now)
		if reply.Watch != nil || reply.Send != nil || reply.Dispatch {
			t.Errorf("%q: %+v", text, reply)
		}
	}
	// "when X is done, run the tests" says nothing to tell anyone, so it is not a chain.
	if reply := AnswerIn("when Ledger is done run the tests", inProjects(""), now); reply.Watch != nil {
		t.Errorf("a chain with nobody to tell: %+v", reply.Watch)
	}
}

// What Mabari can't place, it asks about. It never sends the phrase to an agent.
func TestWatchPhrasesItCannotPlaceAreAskedAbout(t *testing.T) {
	cases := []struct{ text, says string }{
		{"tell me when it's done", "I can watch one agent or one project"},
		{"let me know when everything is done", "I can watch one agent or one project"},
		{"tell me when they finish", "I can watch one agent or one project"},
		{"tell me when Nobody is done", "I couldn't find an agent or project called Nobody"},
		{"let me know when Nobody finishes", "I couldn't find an agent or project called Nobody"},
		{"when Nobody is done, tell Ledger to start", "I couldn't find an agent or project called Nobody"},
		{"tell me when Ledger is done, then tell Nobody to review it", "I couldn't find an agent called Nobody"},
		{"tell me when Ledger is done, then tell Atlas", "What should I tell Atlas?"},
		{"tell me when Ledger is done and also buy milk", "I didn't follow the part after"},
	}
	for _, tc := range cases {
		reply := AnswerIn(tc.text, inProjects(""), now)
		if !strings.Contains(reply.Text, tc.says) {
			t.Errorf("%q: %q", tc.text, reply.Text)
		}
		if reply.Watch != nil || reply.Send != nil || reply.Route != nil || reply.Dispatch {
			t.Errorf("%q was acted on: %+v", tc.text, reply)
		}
	}
	// With no one in the office the reply doesn't offer a list of nothing.
	reply := Answer("tell me when Ledger is done", nil, now)
	if reply.Text != "I couldn't find an agent or project called Ledger." || reply.Watch != nil {
		t.Errorf("empty office: %+v", reply)
	}
}

// What Mabari says once the watch is set, or isn't.
func TestWatchSaid(t *testing.T) {
	then := &models.WatchThen{AgentID: "q", AgentName: "Quill", Text: "review it"}
	cases := []struct {
		name   string
		result WatchResult
		want   string
	}{
		{"agent", WatchResult{Kind: models.WatchAgent, Name: "Ledger"}, "Okay. I'll tell you when Ledger is done."},
		{"project", WatchResult{Kind: models.WatchProject, Name: "Checkout revamp"},
			"Okay. I'll tell you when Checkout revamp is done, which is when every agent on it has finished."},
		{"chain", WatchResult{Kind: models.WatchAgent, Name: "Ledger", Then: then},
			"Okay. I'll tell you when Ledger is done, then tell Quill “review it”. If Ledger hits an error I won't send it, and I'll say so."},
		{"kept", WatchResult{Kind: models.WatchAgent, Name: "Ledger", Kept: true},
			"I'm already watching Ledger. I'll tell you when it's done."},
		{"already done", WatchResult{Kind: models.WatchAgent, Name: "Rune", Task: "Update the README.", Already: models.WatchDone},
			"Rune already finished: Update the README. There's nothing to wait for."},
		{"already done with a chain", WatchResult{Kind: models.WatchAgent, Name: "Rune", Task: "Update the README", Already: models.WatchDone, Then: then},
			"Rune already finished: Update the README. There's nothing to wait for. I haven't told Quill “review it”."},
		{"already stopped", WatchResult{Kind: models.WatchAgent, Name: "Mori", Detail: "Lost the connection.", Already: models.WatchFailed},
			"Mori already stopped with an error: Lost the connection. There's nothing to wait for."},
		{"project already done", WatchResult{Kind: models.WatchProject, Name: "Docs", Already: models.WatchDone},
			"Docs is already done. There's nothing to wait for."},
		{"project already stopped", WatchResult{Kind: models.WatchProject, Name: "Docs", Detail: "Mori", Already: models.WatchFailed},
			"Docs has already stopped. Mori stopped with an error. There's nothing to wait for."},
		{"a problem", WatchResult{Problem: "Quill has left the office."}, "Quill has left the office."},
	}
	for _, tc := range cases {
		if got := WatchSaid(tc.result); got != tc.want {
			t.Errorf("%s:\n got %q\nwant %q", tc.name, got, tc.want)
		}
	}
	reply := Watching(WatchResult{Kind: models.WatchAgent, Name: "Rune", Already: models.WatchDone}, office(), now)
	if reply.Gesture != "shrug" || reply.Watch != nil || reply.Send != nil {
		t.Errorf("reply = %+v", reply)
	}
}
