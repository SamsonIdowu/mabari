// SPDX-License-Identifier: Apache-2.0

package recap

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

type office struct {
	t      *testing.T
	now    time.Time
	engine *events.Engine
}

func newOffice(t *testing.T) *office {
	t.Helper()
	o := &office{t: t, now: time.UnixMilli(1_800_000_000_000)}
	s, err := store.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	o.engine, err = events.New(context.Background(), s, func() time.Time { return o.now })
	if err != nil {
		t.Fatal(err)
	}
	return o
}

func (o *office) at(minutes int) {
	o.now = time.UnixMilli(1_800_000_000_000).Add(time.Duration(minutes) * time.Minute)
}

func (o *office) ms(minutes int) int64 {
	return time.UnixMilli(1_800_000_000_000).Add(time.Duration(minutes) * time.Minute).UnixMilli()
}

func (o *office) add(name string, state models.AgentState) *models.LiveAgent {
	agent := &models.LiveAgent{Agent: models.Agent{ID: "id-" + name, Name: name, Hue: "#" + strconv.Itoa(100+len(name)) + "000"}}
	agent.State, agent.Task = state, "Task of "+name
	_ = o.engine.Do(func() { o.engine.AddAgent(agent) })
	return agent
}

func (o *office) set(agent *models.LiveAgent, state models.AgentState) {
	_ = o.engine.Do(func() {
		agent.State = state
		if state == models.StateError {
			agent.Error = "Lost the connection"
		}
		o.engine.Touch(agent)
	})
}

func (o *office) recap(sinceMinutes, untilMinutes int) models.Recap {
	o.t.Helper()
	var result models.Recap
	var err error
	_ = o.engine.Do(func() {
		result, err = Of(context.Background(), o.engine.Store(), o.engine.Agents(), o.ms(sinceMinutes), o.ms(untilMinutes))
	})
	if err != nil {
		o.t.Fatal(err)
	}
	return result
}

func approval(cmd string) models.Approval {
	return models.Approval{Type: models.ApprovalCommand, Detail: models.ApprovalDetail{Cmd: cmd}, RiskLevel: models.RiskLow}
}

// risky is an approval low risk auto approve never passes.
func risky(cmd string) models.Approval {
	a := approval(cmd)
	a.RiskLevel = models.RiskHigh
	return a
}

func texts(group models.RecapGroup) []string {
	out := []string{}
	for _, item := range group.Items {
		out = append(out, item.Agent+": "+item.Text)
	}
	return out
}

func same(t *testing.T, name string, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Errorf("%s = %q, want %q", name, got, want)
		return
	}
	for i := range got {
		if got[i] != want[i] {
			t.Errorf("%s = %q, want %q", name, got, want)
			return
		}
	}
}

// A period is seeded the way the real office would write it, and every line of the recap is
// checked: what finished, what auto approve settled, the error, and what waits now.
func TestRecapOfAPeriod(t *testing.T) {
	o := newOffice(t)
	o.at(-60)
	atlas := o.add("Atlas", models.StateEditing)
	runner := o.add("Rune", models.StateEditing)
	mori := o.add("Mori", models.StateEditing)
	quill := o.add("Quill", models.StateEditing)
	sage := o.add("Sage", models.StateEditing)
	juno := o.add("Juno", models.StateEditing)
	old := o.add("Old", models.StateEditing)

	// Before the person left: none of this is in the recap. Without a connector to resume it, an
	// agent whose approval auto approve settled stays in the approval state, so the test puts it
	// back to work as the connector would.
	o.at(-30)
	o.set(old, models.StateDone)
	o.set(old, models.StateEditing)
	_ = o.engine.Do(func() {
		o.engine.SetAutoApprove(true, "safe")
		o.engine.RequestApproval(quill, approval("git status"))
		o.engine.SetAutoApprove(false, "safe")
		o.engine.RequestApproval(old, risky("rm -rf build"))
	})
	o.set(quill, models.StateEditing)

	// While away.
	o.at(10)
	o.set(atlas, models.StateDone)
	o.at(20)
	o.set(runner, models.StateDone)
	o.at(30)
	o.set(mori, models.StateError)
	o.at(40)
	_ = o.engine.Do(func() {
		o.engine.SetAutoApprove(true, "safe")
		o.engine.RequestApproval(quill, approval("npm test"))
		o.engine.SetAutoApprove(false, "safe")
	})
	o.set(quill, models.StateEditing)
	o.at(50)
	_ = o.engine.Do(func() {
		o.engine.RequestApproval(sage, risky("npm run db:migrate"))
		o.engine.Ask(juno, models.Question{Items: []models.QuestionItem{{Question: "Which library?"}}})
	})
	o.at(60)

	got := o.recap(0, 60)
	if got.Since != o.ms(0) || got.Until != o.ms(60) {
		t.Errorf("period = %d to %d", got.Since, got.Until)
	}
	if got.Finished.Count != 2 {
		t.Errorf("finished count = %d", got.Finished.Count)
	}
	// Newest first, each linked to its agent.
	same(t, "finished", texts(got.Finished), []string{"Rune: Task of Rune", "Atlas: Task of Atlas"})
	if first := got.Finished.Items[0]; first.AgentID != runner.ID || first.Hue != runner.Hue || first.Time != o.ms(20) {
		t.Errorf("first finished = %+v", first)
	}
	if got.AutoApproved.Count != 1 {
		t.Errorf("auto-approved count = %d", got.AutoApproved.Count)
	}
	same(t, "auto approved", texts(got.AutoApproved), []string{"Quill: npm test"})
	if got.AutoApproved.Items[0].AgentID != quill.ID {
		t.Errorf("auto approved links to %q", got.AutoApproved.Items[0].AgentID)
	}
	if got.Errors.Count != 1 {
		t.Errorf("errors count = %d", got.Errors.Count)
	}
	same(t, "errors", texts(got.Errors), []string{"Mori: Lost the connection"})

	// What waits now: red things first, in office order, then the question. Old's approval was
	// already waiting when the person left, so it is listed but is not news by itself.
	same(t, "needs", texts(got.Needs), []string{
		"Mori: Lost the connection", "Sage: npm run db:migrate", "Old: rm -rf build", "Juno: Asking: Which library?",
	})
	if got.Needs.Count != 4 || got.Needs.Items[1].AgentID != sage.ID {
		t.Errorf("needs = %+v", got.Needs)
	}
	if !got.Happened {
		t.Error("something happened, but the recap says nothing did")
	}
}

// Only something that began after the person left is news. A recap made later, when the finished
// tasks fall before it, has nothing in it but what already waited.
func TestOnlyWhatBeganWhileAwayIsNews(t *testing.T) {
	o := newOffice(t)
	old := o.add("Old", models.StateEditing)
	o.at(-30)
	_ = o.engine.Do(func() { o.engine.RequestApproval(old, risky("rm -rf build")) })
	o.at(60)

	quiet := o.recap(0, 60)
	if quiet.Happened || quiet.Needs.Count != 1 || quiet.Finished.Count != 0 {
		t.Errorf("quiet = %+v", quiet)
	}
	// A new approval is news.
	sage := o.add("Sage", models.StateEditing)
	_ = o.engine.Do(func() { o.engine.RequestApproval(sage, risky("npm run db:migrate")) })
	if news := o.recap(0, 60); !news.Happened || news.Needs.Count != 2 {
		t.Errorf("news = %+v", news)
	}
}

func TestNothingHappenedWhenNothingDid(t *testing.T) {
	o := newOffice(t)
	o.add("Atlas", models.StateEditing)
	o.at(60)
	got := o.recap(0, 60)
	if got.Happened || got.Finished.Count+got.Errors.Count+got.AutoApproved.Count+got.Needs.Count != 0 {
		t.Errorf("recap = %+v", got)
	}
	// Empty groups are empty lists, not null, so the page can read them.
	if got.Finished.Items == nil || got.Needs.Items == nil {
		t.Error("an empty group has no list")
	}
}

// The count is the whole count; the list is only the newest few.
func TestLongListsAreCountedAndCut(t *testing.T) {
	o := newOffice(t)
	atlas := o.add("Atlas", models.StateEditing)
	for minute := 1; minute <= 8; minute++ {
		o.at(minute * 2)
		o.set(atlas, models.StateDone)
		o.at(minute*2 + 1)
		o.set(atlas, models.StateEditing)
	}
	got := o.recap(0, 30)
	if got.Finished.Count != 8 || len(got.Finished.Items) != models.RecapListed {
		t.Errorf("finished = %d counted, %d listed", got.Finished.Count, len(got.Finished.Items))
	}
	if got.Finished.Items[0].Time != o.ms(16) {
		t.Errorf("newest listed is at %d", got.Finished.Items[0].Time)
	}
}

// An agent that has gone has no panel to open, and a new agent with its name isn't the same one.
func TestAnAgentThatLeftHasNoLink(t *testing.T) {
	o := newOffice(t)
	gone := o.add("Atlas", models.StateEditing)
	o.at(5)
	o.set(gone, models.StateDone)
	_ = o.engine.Do(func() { o.engine.RemoveAgent(gone.ID) })
	if got := o.recap(0, 10); got.Finished.Count != 1 || got.Finished.Items[0].AgentID != "" {
		t.Errorf("gone: %+v", got.Finished)
	}
	// Another agent takes the name afterwards.
	o.at(8)
	o.add("Atlas", models.StateEditing)
	o.at(10)
	if got := o.recap(0, 10); got.Finished.Items[0].AgentID != "" {
		t.Errorf("a newer agent of the same name was linked: %+v", got.Finished.Items[0])
	}
}

func TestARecapCannotRunBackwards(t *testing.T) {
	o := newOffice(t)
	_ = o.engine.Do(func() {
		if _, err := Of(context.Background(), o.engine.Store(), nil, 10, 5); err == nil {
			t.Error("a backwards recap was made")
		}
	})
}
