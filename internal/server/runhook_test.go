// SPDX-License-Identifier: Apache-2.0

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/connectors/claudecode"
	"github.com/SamsonIdowu/mabari/internal/models"
)

// hookCall sends a signed hook call as `mabari hook` does, over the server's own handler. With
// run set it carries the header a session Mabari runs marks its hooks with. The reply comes when
// the hook is answered, which for a risky action is when a person has clicked.
func (o *runOffice) hookCall(t *testing.T, run bool, session, event string, input map[string]any) chan *httptest.ResponseRecorder {
	t.Helper()
	token, err := o.vault.Get(claudecode.TokenName)
	if err != nil || token == "" {
		t.Fatalf("no hook token: %v", err)
	}
	mark := ""
	if run {
		mark = "1"
	}
	return o.signedCall(t, token, mark, mark, session, event, input)
}

// signedCall sends a hook call signed with this token and run value, carrying the header value
// sent, so a test can make the two disagree.
func (o *runOffice) signedCall(t *testing.T, token, signed, sent2 string, session, event string, input map[string]any) chan *httptest.ResponseRecorder {
	t.Helper()
	input["session_id"], input["hook_event_name"] = session, event
	input["cwd"] = o.folder
	raw, _ := json.Marshal(input)
	nonce, sent := strings.Repeat("n", 8)+strconv.FormatInt(time.Now().UnixNano(), 16), strconv.FormatInt(time.Now().Unix(), 10)
	request := httptest.NewRequest(http.MethodPost, "http://localhost:4317"+claudecode.HookPath+event, strings.NewReader(string(raw)))
	request.Header.Set(claudecode.NonceHeader, nonce)
	request.Header.Set(claudecode.TimeHeader, sent)
	request.Header.Set(claudecode.SignatureHeader, claudecode.SignRequest(token, nonce, sent, event, signed, raw))
	if sent2 != "" {
		request.Header.Set(claudecode.RunHeader, sent2)
	}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		recorder := httptest.NewRecorder()
		o.handler.ServeHTTP(recorder, request)
		done <- recorder
	}()
	return done
}

func (o *runOffice) decide(t *testing.T, approval, decision string) {
	t.Helper()
	response := o.do(t, http.MethodPost, "/api/approvals/"+approval+"/decision", `{"decision":"`+decision+`"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("decide = %d %s", response.Code, response.Body.String())
	}
}

func reply(t *testing.T, done chan *httptest.ResponseRecorder) *httptest.ResponseRecorder {
	t.Helper()
	select {
	case recorder := <-done:
		return recorder
	case <-time.After(10 * time.Second):
		t.Fatal("the hook was never answered")
		return nil
	}
}

// The hooks Mabari passes to a session it runs reach the server with the run header. They must be
// answered as that session's own: a risky action becomes an approval, and only a click settles it.
// This is the test that was missing when every such call was taken for a settings-file hook, which
// a live session ignores, so nothing was ever asked and every risky action was denied.
func TestARiskyActionFromASessionMabariRunsReachesTheApprovalFlow(t *testing.T) {
	o := newRunOffice(t)
	agent := o.start(t)
	session := agent.Session.ID
	input := func() map[string]any {
		return map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": "rm -rf build"}}
	}

	done := o.hookCall(t, true, session, "PermissionRequest", input())
	o.until(t, "an approval", func() bool { return o.state(agent.ID).Approval != nil })
	waiting := o.state(agent.ID)
	if waiting.Approval.Type != models.ApprovalCommand || waiting.Approval.RiskLevel != models.RiskHigh ||
		!strings.Contains(waiting.Approval.Detail.Cmd, "rm -rf build") {
		t.Fatalf("approval = %+v", waiting.Approval)
	}
	// It waits for a click: nothing has answered it.
	select {
	case <-done:
		t.Fatal("the hook was answered before anyone clicked")
	case <-time.After(300 * time.Millisecond):
	}
	o.decide(t, waiting.Approval.ID, models.DecisionDenied)
	if body := reply(t, done).Body.String(); !strings.Contains(body, `"behavior":"deny"`) {
		t.Fatalf("a denial was answered %q", body)
	}

	done = o.hookCall(t, true, session, "PermissionRequest", input())
	o.until(t, "a second approval", func() bool { return o.state(agent.ID).Approval != nil })
	o.decide(t, o.state(agent.ID).Approval.ID, models.DecisionAllowed)
	if body := reply(t, done).Body.String(); !strings.Contains(body, `"behavior":"allow"`) {
		t.Fatalf("an allow was answered %q", body)
	}
}

// The run header decides how a call is answered, so it is signed: it can't be put on a settings
// hook's call, or taken off a run's, without breaking the signature.
func TestTheRunHeaderIsPartOfTheSignature(t *testing.T) {
	o := newRunOffice(t)
	agent := o.start(t)
	token, err := o.vault.Get(claudecode.TokenName)
	if err != nil {
		t.Fatal(err)
	}
	input := func() map[string]any {
		return map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": "rm -rf build"}}
	}
	for name, marks := range map[string][2]string{
		"added":   {"", "1"},
		"removed": {"1", ""},
		"changed": {"1", "2"},
	} {
		done := o.signedCall(t, token, marks[0], marks[1], agent.Session.ID, "PermissionRequest", input())
		if response := reply(t, done); response.Code != http.StatusUnauthorized {
			t.Errorf("%s: %d %s", name, response.Code, response.Body.String())
		}
	}
	if got := o.state(agent.ID); got.Approval != nil {
		t.Fatalf("asked: %+v", got.Approval)
	}
}

// tokenOf reads the token Mabari gave a session's hooks, as `mabari hook --run --token-file` does.
func (o *runOffice) tokenOf(t *testing.T, session string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(o.logs, session+".args"))
	if err != nil {
		t.Fatal(err)
	}
	found := regexp.MustCompile(`--token-file\\",\\"([^\\]+)\\"`).FindSubmatch(data)
	if found == nil {
		t.Fatalf("no token file in %s", data)
	}
	token, err := claudecode.ReadTokenFile(string(found[1]))
	if err != nil {
		t.Fatal(err)
	}
	return token
}

// The whole way a session's hook works now: no master key, a token from its own file, over a real
// port. It reaches the approval flow, and no other token gets the same answer.
func TestASessionsHookWorksWithItsOwnToken(t *testing.T) {
	o := newRunOffice(t)
	agent := o.start(t)
	session := agent.Session.ID
	token := o.tokenOf(t, session)
	server := httptest.NewServer(o.handler)
	defer server.Close()
	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil {
		t.Fatal(err)
	}
	input, _ := json.Marshal(map[string]any{
		"session_id": session, "cwd": o.folder, "hook_event_name": "PreToolUse",
		"tool_name": "Bash", "tool_input": map[string]any{"command": "rm -rf build"},
	})
	call := func(secret string) (bool, string) {
		var out bytes.Buffer
		answered := claudecode.RunSessionHook("PreToolUse", port, bytes.NewReader(input), &out,
			func() (string, error) { return secret, nil })
		return answered, out.String()
	}
	if answered, printed := call(token); !answered || !strings.Contains(printed, `"ask"`) {
		t.Fatalf("answered = %v, printed %q", answered, printed)
	}
	if answered, printed := call(strings.Repeat("x", 40)); answered || printed != "" {
		t.Fatalf("a made up token: answered = %v, printed %q", answered, printed)
	}
	// It only signs a run's calls: on a settings hook's it means nothing.
	done := o.signedCall(t, token, "", "", session, "PreToolUse", map[string]any{"tool_name": "Read"})
	if response := reply(t, done); response.Code != http.StatusUnauthorized {
		t.Fatalf("as a settings hook = %d", response.Code)
	}
	// It ends with the process.
	if response := o.do(t, http.MethodPost, "/api/agents/"+agent.ID+"/stop", ""); response.Code != http.StatusOK {
		t.Fatalf("stop = %d %s", response.Code, response.Body.String())
	}
	o.until(t, "the token to end", func() bool {
		_, known := o.connector.RunToken(claudecode.RunKey(token))
		return !known
	})
	if answered, _ := call(token); answered {
		t.Fatal("a gone process's token still works")
	}
}

// The panel's Interrupt answers a waiting approval no, then interrupts, and what was in line behind
// the card goes too. It isn't left waiting, and nothing comes up after it.
func TestThePanelsInterruptDeniesAWaitingApproval(t *testing.T) {
	o := newRunOffice(t)
	agent := o.start(t)
	session := agent.Session.ID
	bash := func(command string) map[string]any {
		return map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": command}}
	}
	first := o.hookCall(t, true, session, "PermissionRequest", bash("rm -rf one"))
	o.until(t, "the card", func() bool { return o.state(agent.ID).Approval != nil })
	card := o.state(agent.ID).Approval.ID
	second := o.hookCall(t, true, session, "PermissionRequest", bash("rm -rf two"))
	time.Sleep(100 * time.Millisecond)
	if response := o.do(t, http.MethodPost, "/api/agents/"+agent.ID+"/interrupt", ""); response.Code != http.StatusOK {
		t.Fatalf("interrupt = %d %s", response.Code, response.Body.String())
	}
	if body := reply(t, first).Body.String(); !strings.Contains(body, "denied this") {
		t.Fatalf("first = %q", body)
	}
	if body := reply(t, second).Body.String(); !strings.Contains(body, "withdrawn") {
		t.Fatalf("second = %q", body)
	}
	got := o.state(agent.ID)
	if got.Approval != nil || got.State != models.StatePaused {
		t.Fatalf("state %s, card %+v", got.State, got.Approval)
	}
	approvals, err := o.engine.Store().Approvals(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	for _, approval := range approvals {
		if approval.ID == card && (approval.Decision == nil || *approval.Decision != models.DecisionDenied) {
			t.Fatalf("approval = %+v", approval)
		}
	}
}

// The same call from a settings file, which Claude Code attached to Mabari also runs, is ignored
// for a session Mabari runs, or the person would be asked twice.
func TestASettingsFileHookForASessionMabariRunsIsIgnored(t *testing.T) {
	o := newRunOffice(t)
	agent := o.start(t)
	done := o.hookCall(t, false, agent.Session.ID, "PermissionRequest",
		map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": "rm -rf build"}})
	if body := reply(t, done).Body.String(); strings.TrimSpace(body) != "" {
		t.Fatalf("answered %q", body)
	}
	if got := o.state(agent.ID); got.Approval != nil || got.State == models.StateApproval {
		t.Fatalf("asked twice: %+v", got.Approval)
	}
}

// A run hook for a session with no process behind it is told no, so a call from a process Mabari no
// longer speaks for is never allowed by a click meant for another.
func TestARunHookForAProcessMabariHasLetGoOfIsNotAsked(t *testing.T) {
	o := newRunOffice(t)
	agent := o.start(t)
	o.until(t, "the turn to end", func() bool { return o.state(agent.ID).State == models.StateDone })
	if response := o.do(t, http.MethodPost, "/api/agents/"+agent.ID+"/session/release", ""); response.Code != http.StatusOK {
		t.Fatalf("release = %d %s", response.Code, response.Body.String())
	}
	done := o.hookCall(t, true, agent.Session.ID, "PermissionRequest",
		map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": "rm -rf build"}})
	if body := reply(t, done).Body.String(); !strings.Contains(body, `"behavior":"deny"`) {
		t.Fatalf("answered %q", body)
	}
	if got := o.state(agent.ID); got.Approval != nil {
		t.Fatalf("asked: %+v", got.Approval)
	}
}

// Parallel calls from a session Mabari runs wait in line: a click on one card answers its own call,
// over the real route, and the next card comes up for the next.
func TestParallelCallsFromASessionWaitInLine(t *testing.T) {
	o := newRunOffice(t)
	agent := o.start(t)
	session := agent.Session.ID
	bash := func(command string) map[string]any {
		return map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": command}}
	}
	first := o.hookCall(t, true, session, "PermissionRequest", bash("rm -rf one"))
	o.until(t, "the first card", func() bool { return o.state(agent.ID).Approval != nil })
	card := o.state(agent.ID).Approval
	// A subagent's call has the same session id.
	subagent := bash("rm -rf two")
	subagent["agent_id"], subagent["agent_type"] = "sub1", "Explore"
	second := o.hookCall(t, true, session, "PermissionRequest", subagent)
	select {
	case <-second:
		t.Fatal("the second call was answered with the first card up")
	case <-time.After(150 * time.Millisecond):
	}
	if now := o.state(agent.ID).Approval; now == nil || now.ID != card.ID {
		t.Fatalf("the card changed: %+v", now)
	}
	o.decide(t, card.ID, models.DecisionAllowed)
	if body := reply(t, first).Body.String(); !strings.Contains(body, `"behavior":"allow"`) {
		t.Fatalf("first = %q", body)
	}
	o.until(t, "the second card", func() bool {
		next := o.state(agent.ID).Approval
		return next != nil && next.ID != card.ID && strings.Contains(next.Detail.Cmd, "rm -rf two")
	})
	select {
	case body := <-second:
		t.Fatalf("a click on the first card answered the second call: %q", body.Body.String())
	default:
	}
	o.decide(t, o.state(agent.ID).Approval.ID, models.DecisionDenied)
	if body := reply(t, second).Body.String(); !strings.Contains(body, "denied this") {
		t.Fatalf("second = %q", body)
	}
}
