// SPDX-License-Identifier: Apache-2.0

package server

import (
	"net/http"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/connectors/simulator"
	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
)

// watchOffice is an office of simulated agents: Ledger and Mori on the Checkout revamp project,
// Quill free to be told things, and one Done and one stopped by an error for the "already" cases.
func watchOffice(t *testing.T) (*office, *events.Subscription) {
	t.Helper()
	o := newOffice(t)
	project := "checkout"
	_ = o.engine.Do(func() {
		o.engine.SaveProject(models.Project{ID: "checkout", Name: "Checkout revamp", Color: "#FF6B9A"})
		for _, spec := range []struct {
			id, name string
			state    models.AgentState
		}{
			{"ledger", "Ledger", models.StateEditing},
			{"mori", "Mori", models.StateReading},
			{"quill", "Quill", models.StateIdle},
			{"rune", "Rune", models.StateDone},
			{"sage", "Sage", models.StateError},
		} {
			agent := &models.LiveAgent{Agent: models.Agent{
				ID: spec.id, Name: spec.name, Source: simulator.Source, Provider: models.ProviderOpenAI,
			}}
			agent.State, agent.Task, agent.Queued = spec.state, "Task of "+spec.name, []models.Instruction{}
			if spec.id == "sage" {
				agent.Error = "Lost the connection"
			}
			if spec.id == "ledger" || spec.id == "mori" {
				agent.Project = &project
			}
			o.engine.AddAgent(agent)
		}
	})
	return o, o.engine.Subscribe(events.Resume{}).Sub
}

func (o *office) setState(agent string, state models.AgentState) {
	_ = o.engine.Do(func() {
		a := o.engine.Agent(agent)
		a.State = state
		o.engine.Touch(a)
	})
}

func watchesOf(t *testing.T, o *office) []models.Watch {
	t.Helper()
	return decode[models.Snapshot](t, o.do(t, http.MethodGet, "/api/snapshot", "")).Watches
}

func firedMessages(sub *events.Subscription) []models.WatchFired {
	var out []models.WatchFired
	for {
		select {
		case message, open := <-sub.C:
			if !open {
				return out
			}
			if message.Type == models.MsgWatchFired {
				out = append(out, *message.Fired)
			}
		default:
			return out
		}
	}
}

func askedOf(o *office, agent string) []string {
	var texts []string
	_ = o.engine.Do(func() {
		for _, instruction := range o.engine.Agent(agent).Asked {
			texts = append(texts, instruction.Text)
		}
		for _, instruction := range o.engine.Agent(agent).Queued {
			texts = append(texts, instruction.Text)
		}
	})
	return texts
}

func TestSettingAWatchOverTheAPI(t *testing.T) {
	o, sub := watchOffice(t)
	response := o.do(t, http.MethodPost, "/api/watches", `{"kind":"agent","target":"ledger"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("set = %d %s", response.Code, response.Body)
	}
	set := decode[watchResult](t, response)
	if set.Watch == nil || set.Watch.Kind != models.WatchAgent || set.Watch.Target != "ledger" || set.Watch.Name != "Ledger" ||
		set.Watch.Then != nil || set.Already != "" || set.Kept {
		t.Fatalf("set = %+v", set)
	}
	if set.Text != "Okay. I'll tell you when Ledger is done." {
		t.Errorf("text = %q", set.Text)
	}
	// The snapshot and the list carry it, so a reload, a second tab or a restarted page sees it.
	if watches := watchesOf(t, o); len(watches) != 1 || watches[0].ID != set.Watch.ID {
		t.Errorf("snapshot watches = %+v", watches)
	}
	if listed := decode[[]models.Watch](t, o.do(t, http.MethodGet, "/api/watches", "")); len(listed) != 1 {
		t.Errorf("list = %+v", listed)
	}
	// Pages are told over the socket too.
	var told bool
	for len(sub.C) > 0 {
		if message := <-sub.C; message.Type == models.MsgWatches && len(message.Watches) == 1 {
			told = true
		}
	}
	if !told {
		t.Error("pages were not told")
	}
	// Asking again keeps the one watch.
	again := decode[watchResult](t, o.do(t, http.MethodPost, "/api/watches", `{"kind":"agent","target":"ledger"}`))
	if !again.Kept || again.Watch.ID != set.Watch.ID || !strings.Contains(again.Text, "already watching") {
		t.Errorf("again = %+v", again)
	}
	// Turning it off.
	if response := o.do(t, http.MethodDelete, "/api/watches/"+set.Watch.ID, ""); response.Code != http.StatusNoContent {
		t.Fatalf("delete = %d", response.Code)
	}
	if watches := watchesOf(t, o); len(watches) != 0 {
		t.Errorf("after cancelling: %+v", watches)
	}
	if response := o.do(t, http.MethodDelete, "/api/watches/"+set.Watch.ID, ""); response.Code != http.StatusNotFound {
		t.Errorf("cancelling twice = %d", response.Code)
	}
}

func TestAWatchFiresOnceAndClearsItself(t *testing.T) {
	o, sub := watchOffice(t)
	o.do(t, http.MethodPost, "/api/watches", `{"kind":"agent","target":"ledger"}`)
	firedMessages(sub)
	o.setState("ledger", models.StateThinking)
	if fired := firedMessages(sub); len(fired) != 0 {
		t.Fatalf("fired before it was done: %+v", fired)
	}
	o.setState("ledger", models.StateDone)
	fired := firedMessages(sub)
	if len(fired) != 1 || fired[0].Outcome != models.WatchDone || fired[0].AgentID != "ledger" ||
		fired[0].Text != "Ledger is done: Task of Ledger." || fired[0].Notice != "Ledger is done" {
		t.Fatalf("fired = %+v", fired)
	}
	if watches := watchesOf(t, o); len(watches) != 0 {
		t.Errorf("a watch that fired stays: %+v", watches)
	}
	// Done again, after more work: nothing more.
	o.setState("ledger", models.StateEditing)
	o.setState("ledger", models.StateDone)
	if fired := firedMessages(sub); len(fired) != 0 {
		t.Errorf("fired twice: %+v", fired)
	}
}

func TestAWatchOnAnAgentThatHitsAnError(t *testing.T) {
	o, sub := watchOffice(t)
	o.do(t, http.MethodPost, "/api/watches", `{"kind":"agent","target":"mori"}`)
	firedMessages(sub)
	_ = o.engine.Do(func() {
		mori := o.engine.Agent("mori")
		mori.State, mori.Error = models.StateError, "Lost connection to the embedding service."
		o.engine.Touch(mori)
	})
	fired := firedMessages(sub)
	if len(fired) != 1 || fired[0].Outcome != models.WatchFailed ||
		fired[0].Text != "Mori stopped with an error: Lost connection to the embedding service." {
		t.Fatalf("fired = %+v", fired)
	}
	// An error is told calmly, in the activity log too.
	rows := decode[[]models.LogEntry](t, o.do(t, http.MethodGet, "/api/activity?q=Watch+fired", ""))
	if len(rows) != 1 || rows[0].Chip == "red" || rows[0].Outcome != "Told you" {
		t.Errorf("log = %+v", rows)
	}
}

func TestWatchingWorkThatHasEnded(t *testing.T) {
	o, _ := watchOffice(t)
	done := decode[watchResult](t, o.do(t, http.MethodPost, "/api/watches", `{"kind":"agent","target":"rune"}`))
	if done.Watch != nil || done.Already != models.WatchDone || done.Text != "Rune already finished: Task of Rune. There's nothing to wait for." {
		t.Errorf("done = %+v", done)
	}
	failed := decode[watchResult](t, o.do(t, http.MethodPost, "/api/watches", `{"kind":"agent","target":"sage"}`))
	if failed.Watch != nil || failed.Already != models.WatchFailed ||
		failed.Text != "Sage already stopped with an error: Lost the connection. There's nothing to wait for." {
		t.Errorf("failed = %+v", failed)
	}
	if watches := watchesOf(t, o); len(watches) != 0 {
		t.Errorf("watches = %+v", watches)
	}
}

func TestAProjectWatchOverTheAPI(t *testing.T) {
	o, sub := watchOffice(t)
	set := decode[watchResult](t, o.do(t, http.MethodPost, "/api/watches", `{"kind":"project","target":"checkout"}`))
	if set.Watch == nil || set.Watch.Kind != models.WatchProject || set.Watch.Name != "Checkout revamp" {
		t.Fatalf("set = %+v", set)
	}
	firedMessages(sub)
	// Ledger and Mori are on it. One finishing isn't enough.
	o.setState("ledger", models.StateDone)
	if len(firedMessages(sub)) != 0 {
		t.Fatal("fired with Mori still working")
	}
	o.setState("mori", models.StateDone)
	fired := firedMessages(sub)
	if len(fired) != 1 || fired[0].ProjectID != "checkout" || fired[0].Text != "Checkout revamp is done. Every agent on it has finished." {
		t.Fatalf("fired = %+v", fired)
	}
}

func TestAWatchClearsWhenItsAgentLeavesOverTheAPI(t *testing.T) {
	o, sub := watchOffice(t)
	o.do(t, http.MethodPost, "/api/watches", `{"kind":"agent","target":"ledger"}`)
	firedMessages(sub)
	_ = o.engine.Do(func() { o.engine.RemoveAgent("ledger") })
	if watches := watchesOf(t, o); len(watches) != 0 {
		t.Errorf("watches = %+v", watches)
	}
	if len(firedMessages(sub)) != 0 {
		t.Error("a watch for an agent that left fired")
	}
}

func TestAWatchPassesOnItsInstructionOverTheAPI(t *testing.T) {
	o, sub := watchOffice(t)
	response := o.do(t, http.MethodPost, "/api/watches",
		`{"kind":"agent","target":"ledger","then":{"agentId":"quill","text":"review it"}}`)
	set := decode[watchResult](t, response)
	if response.Code != http.StatusOK || set.Watch == nil || set.Watch.Then == nil ||
		set.Watch.Then.AgentID != "quill" || set.Watch.Then.AgentName != "Quill" || set.Watch.Then.Text != "review it" {
		t.Fatalf("set = %d %+v", response.Code, set)
	}
	if !strings.Contains(set.Text, "then tell Quill “review it”") {
		t.Errorf("text = %q", set.Text)
	}
	firedMessages(sub)
	if got := askedOf(o, "quill"); len(got) != 0 {
		t.Fatalf("Quill was told %v before Ledger was done", got)
	}
	o.setState("ledger", models.StateDone)
	// It went the way every instruction goes, through the agent's connector, so Quill took it.
	if got := askedOf(o, "quill"); len(got) != 1 || got[0] != "review it" {
		t.Errorf("Quill was told %v", got)
	}
	fired := firedMessages(sub)
	if len(fired) != 1 || fired[0].Text != "Ledger is done: Task of Ledger. I told Quill “review it”." {
		t.Fatalf("fired = %+v", fired)
	}
	if got := askedOf(o, "ledger"); len(got) != 0 {
		t.Errorf("Ledger was told %v", got)
	}
}

func TestAnErrorStopsTheInstructionOverTheAPI(t *testing.T) {
	o, sub := watchOffice(t)
	o.do(t, http.MethodPost, "/api/watches",
		`{"kind":"agent","target":"ledger","then":{"agentId":"quill","text":"review it"}}`)
	firedMessages(sub)
	o.setState("ledger", models.StateError)
	if got := askedOf(o, "quill"); len(got) != 0 {
		t.Errorf("Quill was told %v after an error", got)
	}
	fired := firedMessages(sub)
	if len(fired) != 1 || fired[0].Outcome != models.WatchFailed || !strings.Contains(fired[0].Text, "I didn't tell Quill “review it”.") {
		t.Fatalf("fired = %+v", fired)
	}
}

func TestAMissingTargetIsSaidOverTheAPI(t *testing.T) {
	o, sub := watchOffice(t)
	o.do(t, http.MethodPost, "/api/watches",
		`{"kind":"agent","target":"ledger","then":{"agentId":"quill","text":"review it"}}`)
	_ = o.engine.Do(func() { o.engine.RemoveAgent("quill") })
	firedMessages(sub)
	o.setState("ledger", models.StateDone)
	fired := firedMessages(sub)
	if len(fired) != 1 || !strings.Contains(fired[0].Text, "Quill has left, so I didn't pass on “review it”.") {
		t.Fatalf("fired = %+v", fired)
	}
	for _, id := range []string{"ledger", "mori", "rune", "sage"} {
		if got := askedOf(o, id); len(got) != 0 {
			t.Errorf("%s was told %v in Quill's place", id, got)
		}
	}
}

func TestCancellingAnInstructionKeepsTheWatch(t *testing.T) {
	o, sub := watchOffice(t)
	set := decode[watchResult](t, o.do(t, http.MethodPost, "/api/watches",
		`{"kind":"agent","target":"ledger","then":{"agentId":"quill","text":"review it"}}`))
	response := o.do(t, http.MethodDelete, "/api/watches/"+set.Watch.ID+"/then", "")
	left := decode[models.Watch](t, response)
	if response.Code != http.StatusOK || left.ID != set.Watch.ID || left.Then != nil {
		t.Fatalf("cancel = %d %+v", response.Code, left)
	}
	if watches := watchesOf(t, o); len(watches) != 1 || watches[0].Then != nil {
		t.Errorf("watches = %+v", watches)
	}
	firedMessages(sub)
	o.setState("ledger", models.StateDone)
	if got := askedOf(o, "quill"); len(got) != 0 {
		t.Errorf("Quill was told %v", got)
	}
	if fired := firedMessages(sub); len(fired) != 1 || strings.Contains(fired[0].Text, "Quill") {
		t.Errorf("fired = %+v", fired)
	}
	if response := o.do(t, http.MethodDelete, "/api/watches/nope/then", ""); response.Code != http.StatusNotFound {
		t.Errorf("no such watch = %d", response.Code)
	}
}

func TestSettingAWatchChecksTheRequest(t *testing.T) {
	o, _ := watchOffice(t)
	cases := []struct {
		name, body string
		want       int
	}{
		{"an unknown kind", `{"kind":"office","target":"ledger"}`, http.StatusBadRequest},
		{"a missing kind", `{"target":"ledger"}`, http.StatusBadRequest},
		{"no such agent", `{"kind":"agent","target":"nobody"}`, http.StatusNotFound},
		{"no such project", `{"kind":"project","target":"nobody"}`, http.StatusNotFound},
		{"an agent used as a project", `{"kind":"project","target":"ledger"}`, http.StatusNotFound},
		{"no one to tell", `{"kind":"agent","target":"ledger","then":{"agentId":"nobody","text":"x"}}`, http.StatusConflict},
		{"nothing to tell", `{"kind":"agent","target":"ledger","then":{"agentId":"quill","text":"   "}}`, http.StatusBadRequest},
		{"too much to tell", `{"kind":"agent","target":"ledger","then":{"agentId":"quill","text":"` + strings.Repeat("x", events.WatchTextMax+1) + `"}}`, http.StatusBadRequest},
		{"a field it doesn't know", `{"kind":"agent","target":"ledger","approve":true}`, http.StatusBadRequest},
		{"no body", ``, http.StatusBadRequest},
	}
	for _, tc := range cases {
		response := o.do(t, http.MethodPost, "/api/watches", tc.body)
		if response.Code != tc.want {
			t.Errorf("%s: %d %s, want %d", tc.name, response.Code, response.Body, tc.want)
		}
	}
	if watches := watchesOf(t, o); len(watches) != 0 {
		t.Errorf("a refused request left %+v", watches)
	}
}

// Mabari: the phrases set a watch, are never sent to the agent, and leave "tell Ledger to …" alone.
func TestMabariSetsWatchesFromChat(t *testing.T) {
	o, sub := watchOffice(t)
	say := func(text string) veeResult {
		t.Helper()
		response := o.do(t, http.MethodPost, "/api/vee", `{"text":"`+text+`"}`)
		if response.Code != http.StatusOK {
			t.Fatalf("%q = %d %s", text, response.Code, response.Body)
		}
		return decode[veeResult](t, response)
	}
	result := say("tell me when Ledger is done")
	if result.Reply.Text != "Okay. I'll tell you when Ledger is done." || result.Message != nil || result.Reply.Relay != nil {
		t.Errorf("reply = %+v message %+v", result.Reply, result.Message)
	}
	if watches := watchesOf(t, o); len(watches) != 1 || watches[0].Target != "ledger" {
		t.Fatalf("watches = %+v", watches)
	}
	// It wasn't passed to the agent, and nothing was routed or logged as an instruction.
	for _, id := range []string{"ledger", "mori", "quill"} {
		if got := askedOf(o, id); len(got) != 0 {
			t.Errorf("%s was told %v", id, got)
		}
	}
	rows := decode[[]models.LogEntry](t, o.do(t, http.MethodGet, "/api/activity?type=Instruction", ""))
	if len(rows) != 0 {
		t.Errorf("a watch phrase was logged as an instruction: %+v", rows)
	}

	// Again: the same watch.
	if again := say("let me know when Ledger finishes"); !strings.Contains(again.Reply.Text, "already watching Ledger") {
		t.Errorf("again = %q", again.Reply.Text)
	}
	// A project.
	if project := say("let me know when Checkout revamp finishes"); !strings.Contains(project.Reply.Text, "Checkout revamp is done, which is when every agent on it has finished") {
		t.Errorf("project = %q", project.Reply.Text)
	}
	// Already done.
	if already := say("tell me when Rune is done"); already.Reply.Text != "Rune already finished: Task of Rune. There's nothing to wait for." {
		t.Errorf("already = %q", already.Reply.Text)
	}
	// A chain.
	chain := say("when Mori is done, tell Quill to review it")
	if !strings.Contains(chain.Reply.Text, "then tell Quill “review it”") {
		t.Errorf("chain = %q", chain.Reply.Text)
	}
	if got := askedOf(o, "quill"); len(got) != 0 {
		t.Errorf("Quill was told %v when the chain was set", got)
	}
	// No such name: said, and nothing set.
	if nobody := say("tell me when Nobody is done"); !strings.Contains(nobody.Reply.Text, "couldn't find an agent or project called Nobody") {
		t.Errorf("nobody = %q", nobody.Reply.Text)
	}
	if watches := watchesOf(t, o); len(watches) != 3 {
		t.Errorf("watches = %+v", watches)
	}

	// "tell Ledger to …" is still an instruction, even one about being told.
	instructed := say("tell Quill to let me know when you are done")
	if instructed.Message == nil || len(instructed.Message.Agents) != 1 || instructed.Message.Agents[0] != "quill" {
		t.Errorf("tell Quill to … = %+v", instructed)
	}
	if got := askedOf(o, "quill"); len(got) != 1 || got[0] != "let me know when you are done" {
		t.Errorf("Quill was told %v", got)
	}
	if watches := watchesOf(t, o); len(watches) != 3 {
		t.Errorf("an instruction made a watch: %+v", watches)
	}

	// The chain fires: Mori is done, so Quill is told, and Mori's watch and the project's remain
	// one fewer.
	firedMessages(sub)
	o.setState("mori", models.StateDone)
	fired := firedMessages(sub)
	if len(fired) < 1 {
		t.Fatalf("nothing fired: %+v", fired)
	}
	var told bool
	for _, got := range askedOf(o, "quill") {
		told = told || got == "review it"
	}
	if !told {
		t.Errorf("Quill was never told: %v", askedOf(o, "quill"))
	}
}

func TestWatchesAreBehindTheSignIn(t *testing.T) {
	o := newAccessOffice(t, true)
	for _, request := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/watches", ""},
		{http.MethodPost, "/api/watches", `{"kind":"agent","target":"x"}`},
		{http.MethodDelete, "/api/watches/x", ""},
		{http.MethodDelete, "/api/watches/x/then", ""},
	} {
		if response := o.call(t, request.method, request.path, request.body, docker, local, ""); !needsSignIn(response) {
			t.Errorf("%s %s = %d %s", request.method, request.path, response.Code, response.Body)
		}
	}
	token := o.signIn(t, docker, local)
	if response := o.call(t, http.MethodGet, "/api/watches", "", docker, local, token); response.Code != http.StatusOK {
		t.Errorf("signed in = %d", response.Code)
	}
}
