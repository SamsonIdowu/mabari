// SPDX-License-Identifier: Apache-2.0

package vee

import (
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// The offices a newcomer might be in: no projects (Home's usual state), and projects, where an
// unrecognised message gets the "not sure" reply instead of reaching the dispatcher.
func offices() map[string]Office {
	return map[string]Office{
		"no projects": {Agents: office()},
		"projects":    inProjects(""),
		"in view":     inProjects("eq"),
	}
}

// "How is everything going?" is the first thing a newcomer types. It, and the other ways of
// asking how the office is doing, are answered from the live office, not refused or handed to an
// agent as if they were a task.
func TestHowThingsAreGoingGetsTheStatus(t *testing.T) {
	phrases := []string{
		"how is everything going?",
		"how are things going?",
		"how's it going",
		"How’s it going?", // A curly apostrophe, as a phone or a paste brings.
		"hows it going",
		"how's everything?",
		"how is everyone doing",
		"how are we doing?",
		"how's the office going?",
		"how is the team doing?",
		"is everything ok?",
		"is everything going well?",
	}
	for name, in := range offices() {
		for _, phrase := range phrases {
			reply := AnswerIn(phrase, in, now)
			// Picked on Home, a project with nobody in it says so, which is its status.
			want := "agents are working"
			if name == "in view" {
				want = "Nothing is running in Experience and Quality"
			}
			if reply.Dispatch || reply.Route != nil || !strings.Contains(reply.Text, want) ||
				name != "in view" && reply.Kind != KindStatus {
				t.Errorf("%s: %q got %q %q", name, phrase, reply.Kind, reply.Text)
			}
		}
	}
	// With nobody in the office the status says so, and still isn't a task.
	for _, phrase := range []string{"how is everything going?", "how are things going?", "how's it going"} {
		if reply := Answer(phrase, nil, now); reply.Kind != KindEmpty || reply.Dispatch {
			t.Errorf("empty office: %q got %q %q", phrase, reply.Kind, reply.Text)
		}
	}
}

// Naming an agent or a project still wins over the general question.
func TestHowIsItGoingWithANameIsAboutTheName(t *testing.T) {
	if reply := Answer("how's it going with Ledger?", office(), now); !strings.HasPrefix(reply.Text, "Ledger (Claude) is ") {
		t.Errorf("got %q", reply.Text)
	}
}

// Tasks that share a word with the question are still tasks.
func TestTasksAboutThingsStayTasks(t *testing.T) {
	for _, text := range []string{
		"make everything faster",
		"fix how things look on mobile",
		"update how the report is going to be sent",
	} {
		if reply := Answer(text, office(), now); reply.Kind == KindStatus {
			t.Errorf("%q was answered as a status: %q", text, reply.Text)
		}
	}
}

var quoted = regexp.MustCompile(`"([^"]+)"`)

// When Mabari can't tell what a message wants it suggests what to ask. Each suggestion must be
// understood, or the page is telling people to type something that fails.
func TestEverySuggestionIsUnderstood(t *testing.T) {
	for name, in := range offices() {
		fallback := AnswerIn("ok", in, now)
		if name == "no projects" {
			// With no projects a message like that goes to the dispatcher, so there is no fallback.
			if !fallback.Dispatch {
				t.Errorf("%s: got %q %q", name, fallback.Kind, fallback.Text)
			}
			continue
		}
		if !strings.HasPrefix(fallback.Text, "I'm not sure what to do with that") {
			t.Fatalf("%s: no fallback to check: %q", name, fallback.Text)
		}
		offered := quoted.FindAllStringSubmatch(fallback.Text, -1)
		if len(offered) != len(Suggestions) {
			t.Fatalf("%s: the fallback offers %d phrases, want %v: %q", name, len(offered), Suggestions, fallback.Text)
		}
		for index, match := range offered {
			if match[1] != Suggestions[index] {
				t.Errorf("%s: offers %q, want %q", name, match[1], Suggestions[index])
			}
		}
	}
	for name, in := range offices() {
		for _, phrase := range Suggestions {
			reply := AnswerIn(phrase, in, now)
			if reply.Dispatch || reply.Route != nil || reply.Send != nil || reply.Kind == KindPickProject ||
				strings.HasPrefix(reply.Text, "I'm not sure") || reply.Text == "" {
				t.Errorf("%s: suggested %q, got %q %q", name, phrase, reply.Kind, reply.Text)
			}
		}
	}
	// And in an office where nobody needs anything, or nobody is there.
	quiet := []*models.LiveAgent{agent("Pixel", models.StateIdle)}
	for _, agents := range [][]*models.LiveAgent{quiet, nil} {
		for _, phrase := range Suggestions {
			reply := Answer(phrase, agents, now)
			if reply.Dispatch || strings.HasPrefix(reply.Text, "I'm not sure") || reply.Text == "" {
				t.Errorf("%d agents: suggested %q, got %q %q", len(agents), phrase, reply.Kind, reply.Text)
			}
		}
	}
}

// Mabari speaks in sentences about each state: nobody "is needs approval" or "is error".
func TestAgentStatusReadsAsASentence(t *testing.T) {
	agents := office()
	want := map[string]string{
		"Atlas": "Atlas (Custom AI) is waiting for your approval: Do Atlas's work. Paused until you decide on the approval.",
		"Mori":  "Mori (Custom AI) hit an error: Do Mori's work. Lost the connection.",
		"Pixel": "Pixel (Custom AI) is idle: Do Pixel's work. No task right now.",
	}
	for name, sentence := range want {
		reply := Answer("what is "+name+" doing?", agents, now)
		if reply.Text != sentence {
			t.Errorf("%s: got %q, want %q", name, reply.Text, sentence)
		}
	}
	// Every state has a sentence, not just the three above.
	for state := range models.StateLabels {
		one := agent("Pixel", state)
		reply := Answer("what is Pixel doing?", []*models.LiveAgent{one}, now)
		if !strings.HasPrefix(reply.Text, "Pixel (Custom AI) "+models.StatePhrases[state]+":") {
			t.Errorf("%s: %q", state, reply.Text)
		}
	}
	asking := agent("Pixel", models.StateThinking)
	asking.Question = &models.Question{ID: "q-1", Items: []models.QuestionItem{{Question: "Which one?"}}}
	if got := Answer("what is Pixel doing?", []*models.LiveAgent{asking}, now).Text; !strings.Contains(got, "is asking you a question") {
		t.Errorf("an agent asking: %q", got)
	}
}

// The status lists six agents at most, and says how many more are working, so the count and the
// list reconcile.
func TestStatusCountAndListReconcile(t *testing.T) {
	for _, working := range []int{0, 1, 5, 6, 7, 10} {
		var agents []*models.LiveAgent
		for index := range working {
			agents = append(agents, agent("Worker"+strings.Repeat("x", index), models.StateEditing))
		}
		agents = append(agents, agent("Pixel", models.StateIdle), agent("Rune", models.StateDone))
		reply := Answer("status?", agents, now)
		if reply.Kind != KindStatus || reply.Working != working || len(reply.Lines)+reply.More != working {
			t.Errorf("%d working: %d listed and %d more, working = %d", working, len(reply.Lines), reply.More, reply.Working)
		}
		if reply.Total != working+2 || len(reply.Lines) > 6 {
			t.Errorf("%d working: total %d, %d listed", working, reply.Total, len(reply.Lines))
		}
		if working > 6 {
			more := strconv.Itoa(working - 6)
			if want := "Here are 6 of them, and " + more + " more."; !strings.Contains(reply.Text, want) {
				t.Errorf("%d working: %q lacks %q", working, reply.Text, want)
			}
		} else if reply.More != 0 || strings.Contains(reply.Text, "more.") {
			t.Errorf("%d working: nothing was cut, but %q (more = %d)", working, reply.Text, reply.More)
		}
	}
	if got := Answer("status?", []*models.LiveAgent{agent("Ledger", models.StateEditing)}, now).Text; got != "1 agent is working." {
		t.Errorf("one working agent: %q", got)
	}
	needing := []*models.LiveAgent{agent("Ledger", models.StateEditing), agent("Mori", models.StateError)}
	if got := Answer("status?", needing, now).Text; got != "1 agent is working and 1 needs you." {
		t.Errorf("one needing: %q", got)
	}
}

// The floor lists an agent with a queued instruction under Queued, not Working, so Mabari's count
// matches the header beside it. Its work still counts towards when everything finishes.
func TestAQueuedAgentCountsOnceAndStillFinishes(t *testing.T) {
	ledger := agent("Ledger", models.StateEditing)
	sage := agent("Sage", models.StateEditing)
	sage.Queued = []models.Instruction{{Text: "add a test"}}
	agents := []*models.LiveAgent{ledger, sage}

	status := Answer("status?", agents, now)
	if status.Working != 1 || status.Text != "1 agent is working." || len(status.Lines) != 1 {
		t.Errorf("status = %d working, %q, %d listed", status.Working, status.Text, len(status.Lines))
	}
	if eta := Answer("how long until done?", agents, now); eta.Kind != KindWhen || eta.Estimate == nil {
		t.Errorf("the queued agent's work should still count: %+v", eta)
	}
	alone := Answer("how long until done?", []*models.LiveAgent{sage}, now)
	if alone.Kind != KindWhen || !strings.Contains(alone.Text, "Sage will be last") {
		t.Errorf("only a queued agent is working: %+v", alone)
	}
}
