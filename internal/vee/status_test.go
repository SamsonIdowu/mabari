// SPDX-License-Identifier: Apache-2.0

package vee

import (
	"regexp"
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
