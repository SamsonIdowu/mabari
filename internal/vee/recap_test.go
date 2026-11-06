// SPDX-License-Identifier: Apache-2.0

package vee

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// away is a recap of 80 minutes, as the office would hand it over.
func away(since, until int64) models.Recap {
	item := func(agent, text string) models.RecapItem {
		return models.RecapItem{AgentID: "id-" + agent, Agent: agent, Text: text}
	}
	return models.Recap{
		Since: since, Until: until, Happened: true,
		Finished:     models.RecapGroup{Count: 3, Items: []models.RecapItem{item("Atlas", "Index the docs")}},
		AutoApproved: models.RecapGroup{Count: 1, Items: []models.RecapItem{item("Quill", "npm test")}},
		Errors:       models.RecapGroup{Count: 1, Items: []models.RecapItem{item("Mori", "Lost the connection")}},
		Needs:        models.RecapGroup{Count: 2, Items: []models.RecapItem{item("Mori", "Lost the connection")}},
	}
}

func officeWithRecap(since int64, calls *[][2]int64) Office {
	return Office{
		Agents: office(), Since: since,
		Recap: func(from, to int64) (models.Recap, error) {
			*calls = append(*calls, [2]int64{from, to})
			return away(from, to), nil
		},
	}
}

// "What did I miss?" and "catch me up" get the recap, in whatever way they are put.
func TestRecapPhrases(t *testing.T) {
	phrases := []string{
		"what did I miss?",
		"What did I miss",
		"what have I missed?",
		"what I missed",
		"did I miss anything?",
		"did I miss something",
		"catch me up",
		"Catch me up!",
		"please catch me up",
		"can you catch me up?",
		"could you catch me up please",
		"catch up",
		"bring me up to speed",
		"fill me in",
		"recap",
		"what happened while I was away?",
		"what happened while I was out",
		"what's happened since I left?",
		"what’s happened?", // A curly apostrophe, as a phone or a paste brings.
		"what has happened",
		"anything happen while I was gone?",
	}
	for _, phrase := range phrases {
		var calls [][2]int64
		reply := AnswerIn(phrase, officeWithRecap(0, &calls), now)
		if reply.Kind != KindRecap || reply.Recap == nil || reply.Dispatch || reply.Route != nil || reply.Send != nil {
			t.Errorf("%q got %q %q", phrase, reply.Kind, reply.Text)
		}
		if len(calls) != 1 {
			t.Errorf("%q asked for the recap %d times", phrase, len(calls))
		}
	}
}

// Messages that share words with a recap request, and the phrases that already had answers,
// are untouched.
func TestRecapDoesNotTakeOtherPhrases(t *testing.T) {
	tests := []struct {
		text string
		kind Kind
	}{
		{"What's happening?", KindStatus},
		{"what's up", KindStatus},
		{"status", KindStatus},
		{"update me", KindStatus},
		{"give me a summary", KindStatus},
		{"what's going on", KindStatus},
		{"how is everything going?", KindStatus},
		{"who needs me?", KindNeeds},
		{"when will everything be done?", KindWhen},
		{"what did Claude say?", KindPlain},
		// A name keeps it about that agent, as "catch me up on Ledger" was.
		{"catch me up on Ledger", KindStatus},
		{"what did Ledger miss?", KindPlain},
		{"hello", KindPlain},
	}
	for _, test := range tests {
		var calls [][2]int64
		reply := AnswerIn(test.text, officeWithRecap(0, &calls), now)
		if reply.Kind != test.kind || len(calls) != 0 {
			t.Errorf("%q got %q %q (asked for a recap %d times)", test.text, reply.Kind, reply.Text, len(calls))
		}
	}
	// Tasks that share words with it stay tasks: nothing is answered, so they go to the dispatcher.
	for _, text := range []string{
		"catch up on the test coverage", "recap the meeting notes", "catch up with main and rebase",
		"what happened to the build script? fix it", "fill me in the form",
	} {
		var calls [][2]int64
		reply := AnswerIn(text, officeWithRecap(0, &calls), now)
		if reply.Kind == KindRecap || len(calls) != 0 {
			t.Errorf("%q was answered as a recap: %q", text, reply.Text)
		}
	}
}

// The recap covers from when the person last looked, or the last hour when the page doesn't say.
func TestRecapPeriod(t *testing.T) {
	until := now.UnixMilli()
	since := now.Add(-80 * time.Minute).UnixMilli()

	var calls [][2]int64
	reply := AnswerIn("what did I miss?", officeWithRecap(since, &calls), now)
	if len(calls) != 1 || calls[0] != [2]int64{since, until} {
		t.Errorf("asked for %v, want %d to %d", calls, since, until)
	}
	if !strings.HasPrefix(reply.Text, "Since "+time.UnixMilli(since).Format("15:04")+" (1 h 20 min ago): ") {
		t.Errorf("text = %q", reply.Text)
	}

	calls = nil
	reply = AnswerIn("what did I miss?", officeWithRecap(0, &calls), now)
	if hour := now.Add(-time.Hour).UnixMilli(); len(calls) != 1 || calls[0] != [2]int64{hour, until} {
		t.Errorf("with no time given, asked for %v", calls)
	}
	if !strings.Contains(reply.Text, "(1 h ago)") {
		t.Errorf("text = %q", reply.Text)
	}

	// A time in the future is no time at all.
	calls = nil
	AnswerIn("catch me up", officeWithRecap(until+5000, &calls), now)
	if len(calls) != 1 || calls[0][0] != now.Add(-time.Hour).UnixMilli() {
		t.Errorf("a future time was used: %v", calls)
	}
}

func TestRecapTextSaysEveryLine(t *testing.T) {
	since := now.Add(-80 * time.Minute).UnixMilli()
	recap := away(since, now.UnixMilli())
	clock := time.UnixMilli(since).Format("15:04")
	cases := []struct {
		name  string
		shape func(*models.Recap)
		want  string
	}{
		{"everything", func(*models.Recap) {},
			"Since " + clock + " (1 h 20 min ago): 3 tasks finished, 1 approval was auto-approved and 1 error. 2 things need you now."},
		{"singular", func(r *models.Recap) {
			r.Finished.Count, r.Needs.Count = 1, 1
			r.AutoApproved.Count, r.Errors.Count = 0, 0
		}, "Since " + clock + " (1 h 20 min ago): 1 task finished. 1 thing needs you now."},
		{"two kinds", func(r *models.Recap) {
			r.AutoApproved.Count, r.Errors.Count, r.Needs.Count = 2, 0, 0
		}, "Since " + clock + " (1 h 20 min ago): 3 tasks finished and 2 approvals were auto-approved. Nothing needs you now."},
		{"only news that needs you", func(r *models.Recap) {
			r.Finished.Count, r.AutoApproved.Count, r.Errors.Count = 0, 0, 0
		}, "Since " + clock + " (1 h 20 min ago): 2 things need you now."},
		{"only what already waited", func(r *models.Recap) {
			r.Finished.Count, r.AutoApproved.Count, r.Errors.Count, r.Happened = 0, 0, 0, false
		}, "Nothing new since " + clock + " (1 h 20 min ago), but 2 things need you now."},
		{"nothing", func(r *models.Recap) {
			r.Finished.Count, r.AutoApproved.Count, r.Errors.Count, r.Needs.Count, r.Happened = 0, 0, 0, 0, false
		}, "Nothing has happened since " + clock + " (1 h 20 min ago), and nothing needs you."},
	}
	for _, test := range cases {
		shaped := recap
		test.shape(&shaped)
		if got := RecapText(shaped); got != test.want {
			t.Errorf("%s:\n got  %s\n want %s", test.name, got, test.want)
		}
	}
	// What is read aloud names no agent and no command.
	if text := RecapText(recap); strings.Contains(text, "Atlas") || strings.Contains(text, "npm") {
		t.Errorf("the text names an agent or a command: %q", text)
	}
}

func TestRecapWithNothingToReadFrom(t *testing.T) {
	reply := AnswerIn("what did I miss?", Office{Agents: office()}, now)
	if reply.Kind == KindRecap || reply.Recap != nil || !strings.Contains(reply.Text, "can't look back") {
		t.Errorf("no log: %q %q", reply.Kind, reply.Text)
	}
	failing := Office{Agents: office(), Recap: func(int64, int64) (models.Recap, error) { return models.Recap{}, errors.New("disk") }}
	reply = AnswerIn("what did I miss?", failing, now)
	if reply.Kind == KindRecap || reply.Recap != nil || !strings.Contains(reply.Text, "couldn't read the log") {
		t.Errorf("a failing log: %q %q", reply.Kind, reply.Text)
	}
}
