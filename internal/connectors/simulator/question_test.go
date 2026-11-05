// SPDX-License-Identifier: Apache-2.0

package simulator

import (
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
)

// questionDemo loads the demo with its question due after the given time. The message the demo
// opens with waiting for Sage is read first, so the question comes when it says.
func questionDemo(t *testing.T, seed uint32, after time.Duration) (*Simulator, *events.Engine, *clock) {
	t.Helper()
	sim, engine, c, _ := setup(t, ":memory:", seed)
	sim.SetDemoQuestion(after)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	if err := engine.Do(func() { engine.AgentByName(demoAsker).Queued = []models.Instruction{} }); err != nil {
		t.Fatal(err)
	}
	return sim, engine, c
}

// The demo's Claude agent asks a question in the shape Claude Code's AskUserQuestion has, so a
// newcomer can see being asked, and answer, without a real session (FIRST-11).
func TestTheDemoAsksAQuestion(t *testing.T) {
	sim, engine, c := questionDemo(t, 1, 20*time.Second)
	if got := agentSnapshot(engine, demoAsker); got.Question != nil {
		t.Fatal("the demo opens with a question showing")
	}
	// It comes later, not on the first look at the floor.
	advance(t, sim, c, 19)
	if got := agentSnapshot(engine, demoAsker); got.Question != nil {
		t.Fatal("it asked too soon")
	}
	advance(t, sim, c, 2)
	sage := agentSnapshot(engine, demoAsker)
	if sage.Question == nil {
		t.Fatalf("%s didn't ask: %s", sage.Name, sage.State)
	}
	if sage.Provider != models.ProviderClaude || sage.Lead != nil {
		t.Errorf("the asker is %s, lead %v: only a Claude agent asks", sage.Provider, sage.Lead)
	}
	// The real shape: an id, the agent, questions with options and what each means, and one that
	// takes several answers. The engine's own checks accept it.
	question := sage.Question
	if question.ID == "" || question.Agent != sage.ID || len(question.Items) != 2 {
		t.Fatalf("question = %+v", question)
	}
	for _, item := range question.Items {
		if strings.TrimSpace(item.Question) == "" || strings.TrimSpace(item.Header) == "" ||
			len(item.Options) < 2 || len(item.Options) > models.QuestionOptionsMax {
			t.Errorf("item = %+v", item)
		}
		for _, option := range item.Options {
			if option.Label == "" || option.Description == "" {
				t.Errorf("option = %+v", option)
			}
		}
	}
	if question.Items[0].MultiSelect || !question.Items[1].MultiSelect {
		t.Error("the first question takes one answer and the second several")
	}
	// An agent asking is waiting on you, not working, and has no finish time.
	if sage.Working || sage.Estimate != nil || sage.BubbleKind != "ask" || sage.Bubble != "Asking you a question" {
		t.Errorf("working %v, estimate %+v, bubble %q (%s)", sage.Working, sage.Estimate, sage.Bubble, sage.BubbleKind)
	}
	// It asks once, and while it waits it does no work and runs up no tokens.
	before := sage
	advance(t, sim, c, 40)
	after := agentSnapshot(engine, demoAsker)
	if after.Question == nil || after.Question.ID != question.ID {
		t.Fatal("the question changed or went away unanswered")
	}
	if after.Progress != before.Progress || after.TokensIn != before.TokensIn || after.State != before.State {
		t.Errorf("it worked while it waited: progress %v to %v, tokens %d to %d, %s to %s",
			before.Progress, after.Progress, before.TokensIn, after.TokensIn, before.State, after.State)
	}
}

func answerDemo(t *testing.T, engine *events.Engine, name string, answers []models.QuestionAnswer) error {
	t.Helper()
	var failed error
	if err := engine.Do(func() {
		agent := engine.AgentByName(name)
		failed = engine.AnswerQuestion(agent.ID, agent.Question.ID, answers)
	}); err != nil {
		t.Fatal(err)
	}
	return failed
}

// Answering takes the question down, the agent says what it will do and carries on, and what was
// sent to it while it waited is delivered then.
func TestTheDemoCarriesOnOnceAnswered(t *testing.T) {
	sim, engine, c := questionDemo(t, 1, 5*time.Second)
	advance(t, sim, c, 7)
	if agentSnapshot(engine, demoAsker).Question == nil {
		t.Fatal("no question")
	}
	// A message sent while it waits on you is held, then delivered by the answer.
	if err := engine.Do(func() { sim.Instruct(engine.AgentByName(demoAsker), "Also add a test for the cursor") }); err != nil {
		t.Fatal(err)
	}
	waiting := agentSnapshot(engine, demoAsker)
	if len(waiting.Queued) != 1 || len(waiting.Asked) != 0 {
		t.Fatalf("queued %d, asked %d", len(waiting.Queued), len(waiting.Asked))
	}

	// Answers the engine refuses leave the question where it was.
	if err := answerDemo(t, engine, demoAsker, []models.QuestionAnswer{{Picked: []int{0}}}); err == nil {
		t.Error("an answer to one of two questions was accepted")
	}
	if err := answerDemo(t, engine, demoAsker, []models.QuestionAnswer{{Picked: []int{0, 1}}, {Picked: []int{0}}}); err == nil {
		t.Error("two answers to a question that takes one were accepted")
	}
	if agentSnapshot(engine, demoAsker).Question == nil {
		t.Fatal("a refused answer took the question down")
	}

	progress := agentSnapshot(engine, demoAsker).Progress
	if err := answerDemo(t, engine, demoAsker, []models.QuestionAnswer{
		{Picked: []int{0}}, {Picked: []int{1, 2}, Other: "Rate limits"},
	}); err != nil {
		t.Fatal(err)
	}
	sage := agentSnapshot(engine, demoAsker)
	if sage.Question != nil || !sage.Working || sage.Estimate == nil {
		t.Fatalf("after answering: question %v, working %v, estimate %v", sage.Question, sage.Working, sage.Estimate)
	}
	if want := "Thanks. Going with Cursor-based and Link headers, API docs, Rate limits."; sage.Reply != want {
		t.Errorf("reply = %q, want %q", sage.Reply, want)
	}
	if len(sage.Queued) != 0 || len(sage.Asked) != 1 || sage.Asked[0].Reply == "" {
		t.Errorf("the message wasn't delivered: queued %d, asked %+v", len(sage.Queued), sage.Asked)
	}
	// It carries on: its work moves again, and it doesn't ask a second time.
	advance(t, sim, c, 10)
	later := agentSnapshot(engine, demoAsker)
	if later.Progress <= progress || later.Question != nil {
		t.Errorf("progress %v to %v, question %v", progress, later.Progress, later.Question)
	}
	if row := logRow(t, engine, "Answered"); row.Outcome != "Answered" || row.Chip != "ok" {
		t.Errorf("activity row = %+v", row)
	}
	// An answer that was already given is refused.
	if err := engine.Do(func() {
		if got := engine.AnswerQuestion(sage.ID, "question-gone", nil); got == nil {
			t.Error("an answer to a question nobody is asking was accepted")
		}
	}); err != nil {
		t.Fatal(err)
	}
}

// Stopping the agent takes its question down, and the demo never asks a question of an agent that
// has gone or isn't working: it waits, then gives up.
func TestTheDemoQuestionNeverHangsAroundForAnAgentThatLeft(t *testing.T) {
	sim, engine, c := questionDemo(t, 1, 5*time.Second)
	advance(t, sim, c, 7)
	if err := engine.Do(func() { sim.StopAgent(engine.AgentByName(demoAsker)) }); err != nil {
		t.Fatal(err)
	}
	if agentSnapshot(engine, demoAsker).Question != nil {
		t.Error("a stopped agent is still asking")
	}

	// An agent that isn't working when the time comes is asked later, when it is.
	sim, engine, c = questionDemo(t, 1, 5*time.Second)
	if err := engine.Do(func() {
		sage := engine.AgentByName(demoAsker)
		sage.State = models.StateIdle
		sim.runtimeOf(sage).nextTask = 0
	}); err != nil {
		t.Fatal(err)
	}
	advance(t, sim, c, 8)
	if agentSnapshot(engine, demoAsker).Question != nil {
		t.Fatal("an idle agent was asked")
	}
	if err := engine.Do(func() { engine.AgentByName(demoAsker).State = models.StateEditing }); err != nil {
		t.Fatal(err)
	}
	advance(t, sim, c, 12)
	if agentSnapshot(engine, demoAsker).Question == nil {
		t.Error("it never asked once the agent was working")
	}
}

// The question comes after the message the demo opens with waiting for Sage has been read, so the
// queued card and the question don't muddle each other, and it comes by itself.
func TestTheQuestionWaitsForTheOpeningMessageToBeRead(t *testing.T) {
	for seed := uint32(1); seed <= 6; seed++ {
		sim, engine, c, _ := setup(t, ":memory:", seed)
		sim.SetDemoQuestion(2 * time.Second)
		if err := sim.LoadDemo(); err != nil {
			t.Fatal(err)
		}
		if got := agentSnapshot(engine, demoAsker); len(got.Queued) != 1 {
			t.Fatalf("seed %d: the demo opens with %d messages waiting for Sage", seed, len(got.Queued))
		}
		asked := false
		for tick := 0; tick < 120 && !asked; tick++ {
			advance(t, sim, c, 1)
			got := agentSnapshot(engine, demoAsker)
			if got.Question != nil {
				asked = true
				if len(got.Queued) != 0 || len(got.Asked) != 1 {
					t.Errorf("seed %d: asked with %d waiting and %d read", seed, len(got.Queued), len(got.Asked))
				}
			}
		}
		if !asked {
			t.Errorf("seed %d: it never asked", seed)
		}
	}
}

// The demo's agents are never left asking when it ends.
func TestEndingTheDemoClearsTheQuestion(t *testing.T) {
	sim, engine, c := questionDemo(t, 1, 5*time.Second)
	advance(t, sim, c, 7)
	if err := engine.Do(sim.StopDemo); err != nil {
		t.Fatal(err)
	}
	if got := engine.Snapshot(); len(got.Agents) != 0 {
		t.Errorf("%d agents are left", len(got.Agents))
	}
}

// An agent asking isn't asked for an approval as well.
func TestAnAskingAgentIsNotAlsoAskedForAnApproval(t *testing.T) {
	sim, engine, c := questionDemo(t, 3, 5*time.Second)
	if err := engine.Do(func() {
		engine.AgentByName("Atlas").Approval = nil
		engine.AgentByName("Atlas").State = models.StateEditing
	}); err != nil {
		t.Fatal(err)
	}
	advance(t, sim, c, 600)
	for _, agent := range engine.Snapshot().Agents {
		if agent.Asking() && agent.State == models.StateApproval {
			t.Errorf("%s asks a question and waits on an approval", agent.Name)
		}
	}
}
