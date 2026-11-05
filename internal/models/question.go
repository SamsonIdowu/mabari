// SPDX-License-Identifier: Apache-2.0

package models

import (
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Asking reports whether the agent waits on an answer to a question it asked the person.
func (a *LiveAgent) Asking() bool { return a.Question != nil }

// QuestionSummary says what an agent is asking in a few words: its first question, and how many
// more there are.
func QuestionSummary(question *Question) string {
	if question == nil || len(question.Items) == 0 {
		return ""
	}
	text := strings.TrimSpace(question.Items[0].Question)
	if more := len(question.Items) - 1; more == 1 {
		text += " (and 1 more question)"
	} else if more > 1 {
		text += " (and " + strconv.Itoa(more) + " more questions)"
	}
	return text
}

// CheckAnswers makes sure answers fit the question: one answer for every question, each picking
// options that exist, at most one unless the question allows several, and the person's own words
// no longer than AnswerOtherMax. An answer must pick an option or give words, or both when the
// question allows several.
func CheckAnswers(question *Question, answers []QuestionAnswer) error {
	if len(answers) != len(question.Items) {
		return errors.New("answer every question, one answer each")
	}
	for index, item := range question.Items {
		answer := answers[index]
		number := "question " + strconv.Itoa(index+1)
		if utf8.RuneCountInString(answer.Other) > AnswerOtherMax {
			return errors.New("the answer to " + number + " is longer than " + strconv.Itoa(AnswerOtherMax) + " characters")
		}
		if !utf8.ValidString(answer.Other) {
			return errors.New("the answer to " + number + " is not valid text")
		}
		other := strings.TrimSpace(answer.Other) != ""
		seen := map[int]bool{}
		for _, picked := range answer.Picked {
			if picked < 0 || picked >= len(item.Options) {
				return errors.New(number + " has no option " + strconv.Itoa(picked))
			}
			if seen[picked] {
				return errors.New(number + " has an option picked twice")
			}
			seen[picked] = true
		}
		count := len(answer.Picked)
		if other {
			count++
		}
		switch {
		case count == 0:
			return errors.New(number + " has no answer")
		case count > 1 && !item.MultiSelect:
			return errors.New(number + " takes one answer")
		}
	}
	return nil
}

// AnswerText is an answer as Claude Code takes it: the labels picked, in the order the options
// are listed, then the person's own words, joined with ", ". Check the answer first.
func AnswerText(item QuestionItem, answer QuestionAnswer) string {
	var parts []string
	for index, option := range item.Options {
		for _, picked := range answer.Picked {
			if picked == index {
				parts = append(parts, option.Label)
				break
			}
		}
	}
	if other := strings.TrimSpace(answer.Other); other != "" {
		parts = append(parts, other)
	}
	return strings.Join(parts, ", ")
}
