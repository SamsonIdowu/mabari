// SPDX-License-Identifier: Apache-2.0

package server

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// guarded checks a route has the checks every route has: it asks for a sign in where one is
// needed, including through Docker and under a name other than this computer's, and takes the
// session once it has one.
func guarded(t *testing.T, path string) {
	t.Helper()
	o := newAccessOffice(t, true)
	if response := o.call(t, http.MethodGet, path, "", docker, local, ""); !needsSignIn(response) {
		t.Errorf("%s from Docker without a sign in = %d %s", path, response.Code, response.Body)
	}
	if response := o.call(t, http.MethodGet, path, "", phone, "192.168.1.5:4317", ""); !needsSignIn(response) {
		t.Errorf("%s from a phone without a sign in = %d", path, response.Code)
	}
	if response := o.call(t, http.MethodGet, path, "", here, "evil.example", ""); !needsSignIn(response) {
		t.Errorf("%s under another name = %d", path, response.Code)
	}
	token := o.signIn(t, docker, local)
	if response := o.call(t, http.MethodGet, path, "", docker, local, token); response.Code != http.StatusOK {
		t.Errorf("%s signed in = %d %s", path, response.Code, response.Body)
	}
}

func TestRecapHasTheSameAccessChecks(t *testing.T) {
	guarded(t, "/api/recap?since=1")
}

func TestRecapRoute(t *testing.T) {
	o := newOffice(t)
	o.demo(t)
	since := time.Now().Add(-90 * time.Minute).UnixMilli()
	got := decode[models.Recap](t, o.do(t, http.MethodGet, "/api/recap?since="+strconv.FormatInt(since, 10), ""))
	if got.Since != since || got.Until < since || got.Until > time.Now().UnixMilli() {
		t.Errorf("period = %d to %d", got.Since, got.Until)
	}
	// The demo opens with approvals and an error waiting, which began just now.
	if !got.Happened || got.Needs.Count == 0 || got.Needs.Items[0].AgentID == "" {
		t.Errorf("recap = %+v", got)
	}
	// A recap from now on holds nothing that happened before.
	later := strconv.FormatInt(time.Now().Add(time.Hour).UnixMilli(), 10)
	if response := o.do(t, http.MethodGet, "/api/recap?since="+later, ""); response.Code != http.StatusBadRequest {
		t.Errorf("a future since = %d", response.Code)
	}
	for _, query := range []string{"", "since=", "since=abc", "since=0", "since=-5"} {
		if response := o.do(t, http.MethodGet, "/api/recap?"+query, ""); response.Code != http.StatusBadRequest {
			t.Errorf("%q = %d", query, response.Code)
		}
	}
	// An end that is in the future is held to now.
	end := strconv.FormatInt(time.Now().Add(24*time.Hour).UnixMilli(), 10)
	held := decode[models.Recap](t, o.do(t, http.MethodGet, "/api/recap?since="+strconv.FormatInt(since, 10)+"&until="+end, ""))
	if held.Until > time.Now().UnixMilli() {
		t.Errorf("until = %d, after now", held.Until)
	}
}

func TestRecapRouteCountsWhatFinishedWhileAway(t *testing.T) {
	o := newOffice(t)
	o.demo(t)
	since := time.Now().UnixMilli() - 1000
	atlas := agentNamed(t, o, "Rune") // Done in the demo's opening.
	if err := o.engine.Do(func() {
		agent := o.engine.Agent(atlas.ID)
		agent.State = models.StateEditing
		o.engine.Touch(agent)
	}); err != nil {
		t.Fatal(err)
	}
	if err := o.engine.Do(func() {
		agent := o.engine.Agent(atlas.ID)
		agent.State, agent.Task = models.StateDone, "Index the docs folder"
		o.engine.Touch(agent)
	}); err != nil {
		t.Fatal(err)
	}
	got := decode[models.Recap](t, o.do(t, http.MethodGet, "/api/recap?since="+strconv.FormatInt(since, 10), ""))
	found := false
	for _, item := range got.Finished.Items {
		found = found || (item.Agent == "Rune" && item.Text == "Index the docs folder" && item.AgentID == atlas.ID)
	}
	if !found || got.Finished.Count < 1 {
		t.Errorf("finished = %+v", got.Finished)
	}
}

// Mabari answers "what did I miss?" from the same recap, and keeps answering the other questions.
func TestVeeAnswersWhatDidIMiss(t *testing.T) {
	o := newOffice(t)
	o.demo(t)
	since := strconv.FormatInt(time.Now().Add(-80*time.Minute).UnixMilli(), 10)
	result := askVee(t, o, `{"text":"what did I miss?","since":`+since+`}`)
	reply := result.Reply
	if reply.Kind != "recap" || reply.Recap == nil || !regexp.MustCompile(`^Since \d\d:\d\d \(1 h 20 min ago\): `).MatchString(reply.Text) {
		t.Fatalf("reply = %q %q", reply.Kind, reply.Text)
	}
	if reply.Recap.Needs.Count == 0 || result.Message != nil {
		t.Errorf("recap = %+v, message %+v", reply.Recap, result.Message)
	}
	// Nothing was sent to an agent.
	for _, agent := range decode[models.Snapshot](t, o.do(t, http.MethodGet, "/api/snapshot", "")).Agents {
		for _, asked := range agent.Asked {
			if strings.Contains(asked.Text, "miss") {
				t.Errorf("%s was sent %q", agent.Name, asked.Text)
			}
		}
	}
	// Without a time it covers the last hour, and says so.
	if got := askVee(t, o, `{"text":"catch me up"}`).Reply; got.Kind != "recap" || !strings.Contains(got.Text, "(1 h ago)") {
		t.Errorf("catch me up = %q %q", got.Kind, got.Text)
	}
	// The existing questions are answered as they were.
	if got := askVee(t, o, `{"text":"What's happening?"}`).Reply; got.Kind != "status" {
		t.Errorf("status = %q", got.Kind)
	}
	if got := askVee(t, o, `{"text":"who needs me?"}`).Reply; got.Kind != "needs" {
		t.Errorf("needs = %q", got.Kind)
	}
}
