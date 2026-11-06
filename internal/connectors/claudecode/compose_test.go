// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/models"
)

func (b *bench) instructWith(id, text string, opt SendOptions) error {
	var err error
	_ = b.engine.Do(func() {
		if agent := b.engine.Agent(id); agent != nil {
			err = b.c.InstructWith(agent, text, opt)
		}
	})
	return err
}

func TestPlanFirstRunsTheNextTurnInPlanModeThenAsks(t *testing.T) {
	b := newBench(t)
	agent := b.start("say hello")
	b.untilState(agent.ID, models.StateDone)
	if err := b.instructWith(agent.ID, "add a login page", SendOptions{Plan: true}); err != nil {
		t.Fatal(err)
	}
	// The process starts again, in plan mode, with the same session.
	b.until("a plan to ask about", func() bool { return b.read(agent.ID).Approval != nil })
	saved := b.read(agent.ID)
	if saved.Approval.Type != models.ApprovalPlan || saved.Session.Mode != runModePlan {
		t.Fatalf("approval = %+v, mode = %q", saved.Approval, saved.Session.Mode)
	}
	all := b.argsOf(agent.Session.ID)
	if len(all) != 2 || !hasArg(all[1], "--permission-mode", "plan") || !hasArg(all[1], "--resume", agent.Session.ID) {
		t.Fatalf("command lines = %v", all)
	}
	// Plan mode only takes away: nothing on either command line grants anything.
	for _, args := range all {
		for _, forbidden := range []string{"--dangerously-skip-permissions", "--allowedTools", "--bare"} {
			if slices.Contains(args, forbidden) {
				t.Fatalf("%s in %v", forbidden, args)
			}
		}
	}
}

func TestSwitchingTheModelRestartsTheIdleSessionWithIt(t *testing.T) {
	b := newBench(t)
	agent := b.start("say hello")
	b.untilState(agent.ID, models.StateDone)
	if err := b.instructWith(agent.ID, "carry on", SendOptions{Model: "claude-haiku-4-5"}); err != nil {
		t.Fatal(err)
	}
	b.until("the reply", func() bool { return slices.Contains(b.said(agent.ID), "assistant: Done: carry on") })
	all := b.argsOf(agent.Session.ID)
	if len(all) != 2 || !hasArg(all[1], "--model", "claude-haiku-4-5") || !hasArg(all[1], "--resume", agent.Session.ID) {
		t.Fatalf("command lines = %v", all)
	}
	if got := b.read(agent.ID).Model; got != "claude-haiku-4-5" {
		t.Fatalf("model = %q", got)
	}
}

func TestTheModelCantChangeWhileTheSessionIsWorking(t *testing.T) {
	b := newBench(t)
	agent := b.start("fake:hang")
	b.working(agent.ID)
	before := b.read(agent.ID).Model
	if err := b.instructWith(agent.ID, "faster please", SendOptions{Model: "claude-haiku-4-5"}); err == nil {
		t.Fatal("a working session switched model")
	}
	if got := b.read(agent.ID); got.Model != before || len(got.Queued) != 0 {
		t.Fatalf("model = %q, queued = %v", got.Model, got.Queued)
	}
}

func TestSendingNowInterruptsAWorkingSessionAndSendsAtOnce(t *testing.T) {
	b := newBench(t)
	agent := b.start("fake:hang")
	b.working(agent.ID)
	if err := b.instructWith(agent.ID, "stop that, do this instead", SendOptions{Now: true}); err != nil {
		t.Fatal(err)
	}
	b.until("the new message to be answered", func() bool {
		return slices.Contains(b.said(agent.ID), "assistant: Done: stop that, do this instead")
	})
	if got := b.read(agent.ID); len(got.Queued) != 0 {
		t.Fatalf("it queued instead: %v", got.Queued)
	}
}

func TestSendingNowNeverSettlesAnApproval(t *testing.T) {
	b := newBench(t)
	agent := b.start("fake:bash rm -rf build")
	b.until("an approval", func() bool { return b.read(agent.ID).Approval != nil })
	if err := b.instructWith(agent.ID, "never mind", SendOptions{Now: true}); err != nil {
		t.Fatal(err)
	}
	saved := b.read(agent.ID)
	if saved.Approval == nil || saved.State != models.StateApproval {
		t.Fatalf("the approval was settled: state %q, approval %v", saved.State, saved.Approval)
	}
	if len(saved.Queued) != 1 || b.actions() != 0 {
		t.Fatalf("queued = %v, actions = %d", saved.Queued, b.actions())
	}
}

// A name someone chose for an agent Mabari starts is theirs, even one an earlier version used to
// hand out. Once the session's hooks reach Mabari, and after a restart tidies the old sessions, it
// is still what they called it, and the agent is still at its desk.
func TestANameChosenForASessionMabariRunsIsKept(t *testing.T) {
	b := newBench(t)
	// Juniper is one of the made up names the connector once gave sessions.
	agent := b.start("say hello")
	b.untilState(agent.ID, models.StateDone)
	if got := b.read(agent.ID); got.Name != "Juniper" {
		t.Fatalf("hooks renamed it to %q", got.Name)
	}
	_ = b.engine.Do(func() { b.c.TidyNames() })
	got := b.read(agent.ID)
	if got.Name != "Juniper" || got.Workflow || got.Desk < 0 {
		t.Fatalf("tidying changed it: name %q, workflow %v, desk %d", got.Name, got.Workflow, got.Desk)
	}
}

// A model is a command line flag, so only what the account offers gets that far, and the process
// isn't ended for a switch that can't happen.
func TestASessionOnlySwitchesToAModelItsAccountOffers(t *testing.T) {
	b := newBench(t)
	agent := b.start("hello")
	b.untilState(agent.ID, models.StateDone)
	before := b.read(agent.ID).Model
	for _, model := range []string{"not-a-model", "--dangerously-skip-permissions", "gpt-5"} {
		var err error
		_ = b.engine.Do(func() {
			err = b.c.InstructWith(b.engine.Agent(agent.ID), "carry on", SendOptions{Model: model})
		})
		var unknown UnknownModel
		if !errors.As(err, &unknown) || !strings.Contains(err.Error(), model) {
			t.Fatalf("%s: %v", model, err)
		}
	}
	if got := b.read(agent.ID); got.Model != before || got.Session.Status != models.SessionRunning {
		t.Fatalf("model %q, session %q", got.Model, got.Session.Status)
	}
	if runs := b.argsOf(agent.Session.ID); len(runs) != 1 {
		t.Fatalf("runs = %q", runs)
	}
}
