// SPDX-License-Identifier: Apache-2.0

package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/connectors/claudecode"
	"github.com/SamsonIdowu/mabari/internal/connectors/codex"
	"github.com/SamsonIdowu/mabari/internal/connectors/hub"
	"github.com/SamsonIdowu/mabari/internal/connectors/simulator"
	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
)

func idsOf(agents []models.LiveAgent) string {
	ids := make([]string, 0, len(agents))
	for _, agent := range agents {
		ids = append(ids, `"`+agent.ID+`"`)
	}
	return `{"ids":[` + strings.Join(ids, ",") + `]}`
}

func groupAction(t *testing.T, o *office, action, body string) groupReply {
	t.Helper()
	response := o.do(t, http.MethodPost, "/api/agents/"+action, body)
	if response.Code != http.StatusOK {
		t.Fatalf("%s = %d %s", action, response.Code, response.Body)
	}
	return decode[groupReply](t, response)
}

func resultFor(t *testing.T, reply groupReply, id string) groupResult {
	t.Helper()
	for _, result := range reply.Results {
		if result.ID == id {
			return result
		}
	}
	t.Fatalf("no result for %s in %+v", id, reply.Results)
	return groupResult{}
}

func snapshotOf(t *testing.T, o *office) models.Snapshot {
	t.Helper()
	return decode[models.Snapshot](t, o.do(t, http.MethodGet, "/api/snapshot", ""))
}

func agentByID(t *testing.T, o *office, id string) models.LiveAgent {
	t.Helper()
	for _, agent := range snapshotOf(t, o).Agents {
		if agent.ID == id {
			return agent
		}
	}
	t.Fatalf("no agent %s", id)
	return models.LiveAgent{}
}

func logRows(t *testing.T, o *office, agent string) []models.LogEntry {
	t.Helper()
	var found []models.LogEntry
	for _, row := range decode[[]models.LogEntry](t, o.do(t, http.MethodGet, "/api/activity", "")) {
		if row.Agent == agent {
			found = append(found, row)
		}
	}
	return found
}

// working is who Pause everyone can stop: working, and not waiting on an approval or an answer.
func working(agent models.LiveAgent) bool { return agent.State.Active() && agent.Question == nil }

// The demo has every state at once. Only the working agents are paused; the rest are named, with
// why, and left exactly as they were. An approval is never settled.
func TestPauseEveryoneStopsOnlyWhoIsWorking(t *testing.T) {
	o := newOffice(t)
	before := o.demo(t)
	var workers, waiting, others []models.LiveAgent
	for _, agent := range before.Agents {
		switch {
		case working(agent):
			workers = append(workers, agent)
		case agent.State == models.StateApproval || agent.Question != nil:
			waiting = append(waiting, agent)
		default:
			others = append(others, agent)
		}
	}
	if len(workers) < 3 || len(waiting) == 0 || len(others) == 0 {
		t.Fatalf("the demo should have working, waiting and finished agents: %d, %d, %d",
			len(workers), len(waiting), len(others))
	}
	pending := decode[[]models.Approval](t, o.do(t, http.MethodGet, "/api/approvals?pending=1", ""))
	rowsBefore := len(decode[[]models.LogEntry](t, o.do(t, http.MethodGet, "/api/activity", "")))

	reply := groupAction(t, o, "interrupt", idsOf(before.Agents))

	if reply.Paused != len(workers) || reply.Skipped != len(waiting)+len(others) || reply.Asked != 0 {
		t.Errorf("counts = %d paused, %d skipped, %d asked; want %d, %d, 0",
			reply.Paused, reply.Skipped, reply.Asked, len(workers), len(waiting)+len(others))
	}
	if len(reply.Results) != len(before.Agents) {
		t.Fatalf("results = %d, want one for each of the %d agents", len(reply.Results), len(before.Agents))
	}
	for _, agent := range workers {
		if got := resultFor(t, reply, agent.ID); got.Outcome != outcomePaused || got.Name != agent.Name {
			t.Errorf("%s: %+v", agent.Name, got)
		}
		if state := agentByID(t, o, agent.ID).State; state != models.StatePaused {
			t.Errorf("%s is %s after the pause", agent.Name, state)
		}
	}
	for _, agent := range append(waiting, others...) {
		got := resultFor(t, reply, agent.ID)
		if got.Outcome != outcomeSkipped || got.Why == "" {
			t.Errorf("%s was not left alone with a reason: %+v", agent.Name, got)
		}
		// Exactly as it was: same state, same approval, same question.
		after := agentByID(t, o, agent.ID)
		if after.State != agent.State || (after.Approval == nil) != (agent.Approval == nil) ||
			(after.Question == nil) != (agent.Question == nil) {
			t.Errorf("%s changed: %s to %s", agent.Name, agent.State, after.State)
		}
	}
	// Every approval still waits.
	left := decode[[]models.Approval](t, o.do(t, http.MethodGet, "/api/approvals?pending=1", ""))
	if len(left) != len(pending) || len(pending) == 0 {
		t.Errorf("approvals pending: %d before, %d after", len(pending), len(left))
	}
	for _, approval := range left {
		if approval.Decision != nil {
			t.Errorf("approval %s was settled: %v", approval.ID, *approval.Decision)
		}
	}
	// One row for the group, not one for each agent, and nothing but it.
	rows := logRows(t, o, "Everyone")
	if len(rows) != 1 || rows[0].Message != "Pause everyone" || rows[0].Type != models.LogInstruction ||
		!strings.Contains(rows[0].Outcome, "paused") {
		t.Errorf("group rows = %+v", rows)
	}
	if after := len(decode[[]models.LogEntry](t, o.do(t, http.MethodGet, "/api/activity", ""))); after != rowsBefore+1 {
		t.Errorf("the log grew by %d rows, want 1", after-rowsBefore)
	}
	// What the page shows is what the server computed.
	if !strings.HasPrefix(reply.Summary, "Paused "+agentCount(len(workers))+".") ||
		!strings.Contains(reply.Summary, "Left alone:") {
		t.Errorf("summary = %q", reply.Summary)
	}
}

// Continue everyone carries on what a pause stopped, and nothing else: an agent paused by hand
// earlier was left alone by the pause, so it is not in what the pause stopped.
func TestContinueEveryoneResumesOnlyWhatThePauseStopped(t *testing.T) {
	o := newOffice(t)
	before := o.demo(t)
	var workers []models.LiveAgent
	for _, agent := range before.Agents {
		if working(agent) {
			workers = append(workers, agent)
		}
	}
	byHand := workers[0]
	if response := o.do(t, http.MethodPost, "/api/agents/"+byHand.ID+"/interrupt", ""); response.Code != http.StatusOK {
		t.Fatalf("interrupt = %d", response.Code)
	}
	reply := groupAction(t, o, "interrupt", idsOf(workers))
	if got := resultFor(t, reply, byHand.ID); got.Outcome != outcomeSkipped || got.Why != "is already paused" {
		t.Errorf("the agent paused by hand = %+v", got)
	}
	var stopped []models.LiveAgent
	for _, result := range reply.Results {
		if result.Outcome == outcomePaused {
			stopped = append(stopped, models.LiveAgent{Agent: models.Agent{ID: result.ID}})
		}
	}
	if len(stopped) != len(workers)-1 {
		t.Fatalf("the pause stopped %d, want %d", len(stopped), len(workers)-1)
	}

	resumed := groupAction(t, o, "continue", idsOf(stopped))
	if resumed.Resumed != len(stopped) || resumed.Skipped != 0 {
		t.Errorf("continue = %d resumed, %d skipped", resumed.Resumed, resumed.Skipped)
	}
	for _, agent := range stopped {
		if state := agentByID(t, o, agent.ID).State; !state.Active() {
			t.Errorf("%s did not carry on: %s", agent.ID, state)
		}
	}
	if state := agentByID(t, o, byHand.ID).State; state != models.StatePaused {
		t.Errorf("the agent paused by hand is %s: it must stay paused", state)
	}
	rows := logRows(t, o, "Everyone")
	if len(rows) != 2 || rows[0].Message != "Continue everyone" || !strings.Contains(rows[0].Outcome, "resumed") {
		t.Errorf("group rows = %+v", rows)
	}

	// Asked to continue again, nothing is paused any more, so every agent is left alone.
	again := groupAction(t, o, "continue", idsOf(stopped))
	if again.Resumed != 0 || again.Skipped != len(stopped) || !strings.HasPrefix(again.Summary, "Nobody was resumed.") {
		t.Errorf("a second continue = %+v", again)
	}
	for _, result := range again.Results {
		if result.Why != "isn't paused any more" {
			t.Errorf("a second continue said %+v", result)
		}
	}
	// Naming the agent paused by hand does resume it: the page decides who, and only lists the
	// agents the pause stopped.
	if got := groupAction(t, o, "continue", `{"ids":["`+byHand.ID+`"]}`); got.Resumed != 1 {
		t.Errorf("continue named it = %+v", got)
	}
}

// Pausing a project's agents names the project in the one row it writes.
func TestPauseEveryoneNamesTheProjectInItsRow(t *testing.T) {
	o := newOffice(t)
	before := o.demo(t)
	var checkout []models.LiveAgent
	for _, agent := range before.Agents {
		if agent.Project != nil && *agent.Project == "checkout" && working(agent) {
			checkout = append(checkout, agent)
		}
	}
	if len(checkout) == 0 {
		t.Fatal("no working agent in Checkout revamp")
	}
	groupAction(t, o, "interrupt", idsOf(checkout))
	rows := logRows(t, o, "Everyone")
	if len(rows) != 1 || rows[0].Message != "Pause everyone in Checkout revamp" {
		t.Errorf("rows = %+v", rows)
	}
	for _, agent := range before.Agents {
		if working(agent) && (agent.Project == nil || *agent.Project != "checkout") {
			if state := agentByID(t, o, agent.ID).State; state != agent.State {
				t.Errorf("%s is in another project but is now %s", agent.Name, state)
			}
		}
	}
}

func TestGroupActionsCheckTheirBody(t *testing.T) {
	o := newOffice(t)
	o.demo(t)
	crowd := make([]string, maxGroup+1)
	for i := range crowd {
		crowd[i] = fmt.Sprintf("agent-%d", i)
	}
	many, _ := json.Marshal(groupBody{IDs: crowd})
	for _, test := range []struct {
		name, body string
		code       int
	}{
		{"no body", ``, http.StatusBadRequest},
		{"no ids", `{"ids":[]}`, http.StatusBadRequest},
		{"blank ids", `{"ids":["", "  "]}`, http.StatusBadRequest},
		{"an unknown field", `{"ids":["a"],"all":true}`, http.StatusBadRequest},
		{"too many", string(many), http.StatusBadRequest},
	} {
		for _, action := range []string{"interrupt", "continue"} {
			if response := o.do(t, http.MethodPost, "/api/agents/"+action, test.body); response.Code != test.code {
				t.Errorf("%s %s = %d %s", action, test.name, response.Code, response.Body)
			}
		}
	}
	// A repeated id is one agent, and one that has gone is said so, not an error.
	snapshot := snapshotOf(t, o)
	worker := snapshot.Agents[0]
	reply := groupAction(t, o, "interrupt", `{"ids":["`+worker.ID+`","`+worker.ID+`","nobody"]}`)
	if len(reply.Results) != 2 {
		t.Fatalf("results = %+v", reply.Results)
	}
	if gone := resultFor(t, reply, "nobody"); gone.Outcome != outcomeSkipped || gone.Why != "has left the office" {
		t.Errorf("an agent that has gone = %+v", gone)
	}
	if !strings.Contains(reply.Summary, "1 agent had left the office.") {
		t.Errorf("summary = %q", reply.Summary)
	}
}

// A stand-in for a connector whose Interrupt can only ask, as Codex's does until its turn ends.
type askingConnector struct {
	events.Connector
	interrupted, continued []string
}

func (c *askingConnector) Interrupt(agent *models.LiveAgent) {
	c.interrupted = append(c.interrupted, agent.Name)
}

func (c *askingConnector) Continue(agent *models.LiveAgent) {
	c.continued = append(c.continued, agent.Name)
}

func (*askingConnector) Models() []string { return nil }

// What each real connector's Interrupt does decides what Mabari may claim. The demo stops at once.
// The hub is only sent "Please pause.", so the answer says it was asked, not paused, and the
// agent keeps its state until the app reports one.
func TestPauseEveryoneSaysWhenAnAgentCanOnlyBeAsked(t *testing.T) {
	o := newOffice(t)
	bridge := hub.New(o.engine)
	o.engine.AddConnector(hub.Source, bridge)
	codexStandIn := &askingConnector{}
	o.engine.AddConnector(codex.Source, codexStandIn)
	if err := o.engine.Do(func() {
		bridge.Report(hub.Event{Agent: "bot", Name: "Botty", State: "running", Task: "Sort the mail"})
		bridge.Report(hub.Event{Agent: "idle", Name: "Napper", State: "idle"})
		codexAgent := &models.LiveAgent{}
		codexAgent.ID, codexAgent.Name, codexAgent.Source = "cx-1", "Codey", codex.Source
		codexAgent.State, codexAgent.Queued = models.StateEditing, []models.Instruction{}
		o.engine.AddAgent(codexAgent)
	}); err != nil {
		t.Fatal(err)
	}

	reply := groupAction(t, o, "interrupt", `{"ids":["hub-bot","hub-idle","cx-1"]}`)

	if reply.Asked != 2 || reply.Paused != 0 || reply.Skipped != 1 {
		t.Errorf("counts = %d asked, %d paused, %d skipped", reply.Asked, reply.Paused, reply.Skipped)
	}
	if got := resultFor(t, reply, "hub-bot"); got.Outcome != outcomeAsked || got.Why != "was asked, and its app decides" {
		t.Errorf("hub = %+v", got)
	}
	if got := resultFor(t, reply, "cx-1"); got.Outcome != outcomeAsked || got.Why != "is ending its turn" {
		t.Errorf("codex = %+v", got)
	}
	if got := resultFor(t, reply, "hub-idle"); got.Outcome != outcomeSkipped || got.Why != "has nothing running" {
		t.Errorf("idle = %+v", got)
	}
	// The hub agent was only sent a request. It is still running as far as Mabari knows, with the
	// request waiting in its queue.
	hubAgent := agentByID(t, o, "hub-bot")
	if hubAgent.State != models.StateRunning || len(hubAgent.Queued) != 1 || hubAgent.Queued[0].Text != "Please pause." {
		t.Errorf("hub agent = %s, queued %+v", hubAgent.State, hubAgent.Queued)
	}
	if !slices.Equal(codexStandIn.interrupted, []string{"Codey"}) {
		t.Errorf("codex was interrupted for %v", codexStandIn.interrupted)
	}
	for _, want := range []string{"Only asked:", "Botty was asked, and its app decides", "Codey is ending its turn",
		"Left alone: Napper has nothing running."} {
		if !strings.Contains(reply.Summary, want) {
			t.Errorf("summary %q lacks %q", reply.Summary, want)
		}
	}
	if !strings.HasPrefix(reply.Summary, "Nobody was paused.") {
		t.Errorf("summary = %q", reply.Summary)
	}
	// Asking is still one row for the group. The hub's request is its own row, as an instruction
	// waiting for its app is.
	if rows := logRows(t, o, "Everyone"); len(rows) != 1 || !strings.Contains(rows[0].Outcome, "2 asked") {
		t.Errorf("group rows = %+v", rows)
	}
}

// A real Claude Code session is asked, and stops at its next step. Continue before that step lifts
// the pause; Continue after it can only tell the person its session is waiting for them.
func TestPauseEveryoneWithClaudeCodeSessions(t *testing.T) {
	o := newClaudeOffice(t)
	o.do(t, http.MethodPost, "/api/accounts/claude/connect", `{"confirm":true}`)
	token, _ := o.vault.Get(claudecode.TokenName)
	step := func(session, tool string) *httptest.ResponseRecorder {
		return o.hook(t, token, "PreToolUse",
			`{"session_id":"`+session+`","cwd":"/tmp/shop","hook_event_name":"PreToolUse","tool_name":"`+tool+
				`","tool_input":{"file_path":"/tmp/shop/a.go"}}`)
	}
	step("s1", "Read")
	step("s2", "Read")
	step("s3", "Read")

	reply := groupAction(t, o.office, "interrupt", `{"ids":["cc-s1","cc-s2","cc-s3"]}`)
	if reply.Asked != 3 || reply.Paused != 0 {
		t.Fatalf("counts = %d asked, %d paused", reply.Asked, reply.Paused)
	}
	if got := resultFor(t, reply, "cc-s1"); got.Why != "stops at its next step" {
		t.Errorf("claude = %+v", got)
	}
	// Nothing has stopped yet: Claude Code only hears it at its next tool call.
	if state := agentByID(t, o.office, "cc-s1").State; state != models.StateReading {
		t.Errorf("cc-s1 is %s before its next step", state)
	}

	// Session 3 is continued before it reaches its next step, so the pause is lifted.
	lifted := groupAction(t, o.office, "continue", `{"ids":["cc-s3"]}`)
	if lifted.Resumed != 1 {
		t.Errorf("continue before the pause = %+v", lifted)
	}
	// The next steps: 1 and 2 stop, 3 carries on.
	for _, session := range []string{"s1", "s2"} {
		response := step(session, "Edit")
		if !strings.Contains(response.Body.String(), `"continue":false`) {
			t.Errorf("%s did not stop: %s", session, response.Body)
		}
	}
	if response := step("s3", "Edit"); strings.Contains(response.Body.String(), `"continue":false`) {
		t.Errorf("s3 stopped though its pause was lifted: %s", response.Body)
	}
	if state := agentByID(t, o.office, "cc-s1").State; state != models.StatePaused {
		t.Errorf("cc-s1 = %s", state)
	}
	// A paused session can't be restarted from here: it is waiting for the person to type in it.
	back := groupAction(t, o.office, "continue", `{"ids":["cc-s1","cc-s2"]}`)
	if back.Waiting != 2 || back.Resumed != 0 {
		t.Errorf("continue = %+v", back)
	}
	if got := resultFor(t, back, "cc-s1"); got.Outcome != outcomeWaiting ||
		got.Why != "ended its turn, so type in its session to carry on" {
		t.Errorf("claude after the pause = %+v", got)
	}
	if state := agentByID(t, o.office, "cc-s1").State; state != models.StateIdle {
		t.Errorf("cc-s1 = %s, want it waiting for its person", state)
	}
	if !strings.Contains(back.Summary, "type in its session to carry on") {
		t.Errorf("summary = %q", back.Summary)
	}
}

// Asking for a pause hears a question or an approval too, and leaves both as they are.
func TestPauseEveryoneNeverAnswersAQuestionOrSettlesAnApproval(t *testing.T) {
	o := newOffice(t)
	if err := o.engine.Do(func() {
		for _, name := range []string{"Asker", "Approver"} {
			agent := &models.LiveAgent{}
			agent.ID, agent.Name, agent.Source = strings.ToLower(name), name, simulator.Source
			agent.State, agent.Queued = models.StateRunning, []models.Instruction{}
			o.engine.AddAgent(agent)
		}
		o.engine.Agent("asker").Question = &models.Question{ID: "q1", Agent: "asker",
			Items: []models.QuestionItem{{Question: "Which?", Options: []models.QuestionOption{{Label: "A"}}}}}
		approver := o.engine.Agent("approver")
		o.engine.RequestApproval(approver, models.Approval{
			Type: models.ApprovalCommand, Title: "wants to run a command",
			Detail: models.ApprovalDetail{Cmd: "make deploy"}, RiskLevel: models.RiskHigh,
		})
	}); err != nil {
		t.Fatal(err)
	}
	if state := agentByID(t, o, "approver").State; state != models.StateApproval {
		t.Fatalf("approver = %s", state)
	}
	reply := groupAction(t, o, "interrupt", `{"ids":["asker","approver"]}`)
	if reply.Skipped != 2 || reply.Paused != 0 {
		t.Fatalf("reply = %+v", reply)
	}
	if got := resultFor(t, reply, "asker"); got.Why != "is waiting for your answer" {
		t.Errorf("asker = %+v", got)
	}
	if got := resultFor(t, reply, "approver"); got.Why != "is waiting for your approval" {
		t.Errorf("approver = %+v", got)
	}
	approver := agentByID(t, o, "approver")
	if approver.State != models.StateApproval || approver.Approval == nil || approver.Approval.Decision != nil {
		t.Errorf("the approval was touched: %s %+v", approver.State, approver.Approval)
	}
	if agentByID(t, o, "asker").Question == nil {
		t.Error("the question was dropped")
	}
	// Continue leaves them too: they were never paused.
	if got := groupAction(t, o, "continue", `{"ids":["asker","approver"]}`); got.Skipped != 2 || got.Resumed != 0 {
		t.Errorf("continue = %+v", got)
	}
}

// The group's toast is said once, by the server, however many agents it stopped.
func TestPauseEveryoneToastsOnce(t *testing.T) {
	o := newOffice(t)
	before := o.demo(t)
	joined := o.engine.Subscribe(events.Resume{})
	defer o.engine.Unsubscribe(joined.Sub)
	groupAction(t, o, "interrupt", idsOf(before.Agents))
	var toasts []string
	for drained := false; !drained; {
		select {
		case message := <-joined.Sub.C:
			if message.Type == models.MsgToast {
				toasts = append(toasts, message.Text)
			}
		default:
			drained = true
		}
	}
	if len(toasts) != 1 || !strings.HasPrefix(toasts[0], "Paused ") {
		t.Errorf("toasts = %q", toasts)
	}
}

func TestNamesAreListedWithTheRestCounted(t *testing.T) {
	for _, test := range []struct {
		in   []string
		want string
	}{
		{nil, ""},
		{[]string{"A"}, "A"},
		{[]string{"A", "B"}, "A and B"},
		{[]string{"A", "B", "C"}, "A, B and C"},
		{[]string{"A", "B", "C", "D"}, "A, B, C and 1 more"},
		{[]string{"A", "B", "C", "D", "E", "F"}, "A, B, C and 3 more"},
	} {
		if got := names(test.in); got != test.want {
			t.Errorf("names(%v) = %q, want %q", test.in, got, test.want)
		}
	}
}

// The group routes sit beside /api/agents/{id}/interrupt and don't take its place.
func TestGroupRoutesDoNotShadowTheSingleAgentOnes(t *testing.T) {
	o := newOffice(t)
	before := o.demo(t)
	worker := slices.IndexFunc(before.Agents, func(agent models.LiveAgent) bool { return working(agent) })
	id := before.Agents[worker].ID
	if response := o.do(t, http.MethodPost, "/api/agents/"+id+"/interrupt", ""); response.Code != http.StatusOK {
		t.Fatalf("one agent's interrupt = %d", response.Code)
	}
	if got := agentByID(t, o, id).State; got != models.StatePaused {
		t.Errorf("state = %s", got)
	}
	if response := o.do(t, http.MethodGet, "/api/agents/interrupt", ""); response.Code != http.StatusNotFound &&
		response.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET /api/agents/interrupt = %d", response.Code)
	}
	var reply groupReply
	response := o.do(t, http.MethodPost, "/api/agents/continue", `{"ids":["`+id+`"]}`)
	if err := json.Unmarshal(response.Body.Bytes(), &reply); err != nil || reply.Resumed != 1 {
		t.Errorf("continue = %d %s", response.Code, response.Body)
	}
}
