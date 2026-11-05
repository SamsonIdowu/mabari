// SPDX-License-Identifier: Apache-2.0

package models

import (
	"strings"
	"testing"
	"time"
)

func sampleQuestion() *Question {
	return &Question{ID: "q1", Items: []QuestionItem{
		{Question: "Which database?", Header: "Database", Options: []QuestionOption{
			{Label: "Postgres"}, {Label: "SQLite"},
		}},
		{Question: "Which checks?", Header: "Checks", MultiSelect: true, Options: []QuestionOption{
			{Label: "Lint"}, {Label: "Tests"}, {Label: "Types"},
		}},
	}}
}

func TestCheckAnswers(t *testing.T) {
	good := []QuestionAnswer{{Picked: []int{1}}, {Picked: []int{2, 0}, Other: "Docs"}}
	if err := CheckAnswers(sampleQuestion(), good); err != nil {
		t.Errorf("good answers: %v", err)
	}
	// Free text alone answers a question, as "Other".
	if err := CheckAnswers(sampleQuestion(), []QuestionAnswer{{Other: "MySQL"}, {Other: "None"}}); err != nil {
		t.Errorf("own words: %v", err)
	}
	bad := map[string][]QuestionAnswer{
		"too few":            {{Picked: []int{0}}},
		"too many":           {{Picked: []int{0}}, {Picked: []int{0}}, {Picked: []int{0}}},
		"no answer":          {{Picked: []int{0}}, {Other: "   "}},
		"no such option":     {{Picked: []int{2}}, {Picked: []int{0}}},
		"negative option":    {{Picked: []int{-1}}, {Picked: []int{0}}},
		"picked twice":       {{Picked: []int{0}}, {Picked: []int{1, 1}}},
		"two for single":     {{Picked: []int{0, 1}}, {Picked: []int{0}}},
		"option and words":   {{Picked: []int{0}, Other: "MySQL"}, {Picked: []int{0}}},
		"words too long":     {{Other: strings.Repeat("a", AnswerOtherMax+1)}, {Picked: []int{0}}},
		"words not utf8":     {{Other: "\xff"}, {Picked: []int{0}}},
		"nothing at all":     {},
		"empty single":       {{}, {Picked: []int{0}}},
		"empty multi answer": {{Picked: []int{0}}, {Picked: []int{}}},
	}
	for name, answers := range bad {
		if err := CheckAnswers(sampleQuestion(), answers); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	// The limit counts characters, not bytes.
	if err := CheckAnswers(sampleQuestion(), []QuestionAnswer{{Other: strings.Repeat("é", AnswerOtherMax)}, {Picked: []int{0}}}); err != nil {
		t.Errorf("%d characters: %v", AnswerOtherMax, err)
	}
}

func TestAnswerTextJoinsLabelsInTheirOrder(t *testing.T) {
	question := sampleQuestion()
	if got := AnswerText(question.Items[0], QuestionAnswer{Picked: []int{1}}); got != "SQLite" {
		t.Errorf("single = %q", got)
	}
	if got := AnswerText(question.Items[1], QuestionAnswer{Picked: []int{2, 0}, Other: " Docs "}); got != "Lint, Types, Docs" {
		t.Errorf("multi = %q", got)
	}
	if got := AnswerText(question.Items[0], QuestionAnswer{Other: "MySQL"}); got != "MySQL" {
		t.Errorf("other = %q", got)
	}
}

func TestQuestionSummary(t *testing.T) {
	question := sampleQuestion()
	if got := QuestionSummary(question); got != "Which database? (and 1 more question)" {
		t.Errorf("summary = %q", got)
	}
	question.Items = question.Items[:1]
	if got := QuestionSummary(question); got != "Which database?" {
		t.Errorf("one = %q", got)
	}
	if QuestionSummary(nil) != "" {
		t.Error("nil has a summary")
	}
}

// An agent asking a question waits on the person: it isn't working, and its bubble says so until
// the question is answered, even over a reply.
func TestAnAgentAskingIsNotWorking(t *testing.T) {
	now := time.UnixMilli(5000)
	a := &LiveAgent{SessionState: SessionState{State: StateThinking, Reply: "Hi", ReplyUntil: 9000}}
	a.Question = sampleQuestion()
	a.Refresh(now)
	if a.Working || a.Bubble != "Asking you a question" || a.BubbleKind != "ask" {
		t.Errorf("working %v, bubble %q %q", a.Working, a.Bubble, a.BubbleKind)
	}
	if got := ETALong(a, now); got != "Waiting for your answer" {
		t.Errorf("eta = %q", got)
	}
	a.Question = nil
	a.Refresh(now)
	if !a.Working || a.BubbleKind != "reply" {
		t.Errorf("answered: working %v, bubble %q", a.Working, a.BubbleKind)
	}
}
