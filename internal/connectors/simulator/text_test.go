// SPDX-License-Identifier: Apache-2.0

package simulator

import (
	"regexp"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/models"
)

var (
	// A blank where a name goes leaves a space in front of punctuation, or two spaces together.
	blankSlot = regexp.MustCompile(`\s[.,?!:;]|\s\s|\bto\s*$|\bin\s*[.?]`)
	slot      = regexp.MustCompile(`\{(\w+)\}`)
)

// Every line of chat the demo can say reads whole, whichever two agents are talking, including
// the agents whose file is a folder ("test/", "docs/") or who have none: no name is ever blank,
// as in "touches . Over to you" and "change to ?".
func TestNoDemoLineHasABlankFileName(t *testing.T) {
	people := map[string]*models.LiveAgent{}
	for name, files := range demoFiles {
		person := &models.LiveAgent{}
		person.Name, person.Files, person.State = name, files, models.StateEditing
		person.Progress, person.Rate = 0.4, 0.001
		people[name] = person
	}
	// An agent made in the app with no file list, and one whose list is only slashes.
	people["Fresh"] = &models.LiveAgent{}
	people["Slashes"] = &models.LiveAgent{SessionState: models.SessionState{Files: []string{"/", "//"}}}
	people["Default"] = &models.LiveAgent{SessionState: models.SessionState{Files: defaultFiles}}

	templates := append(append([]chatTemplate{}, peerTalk...), subTalk...)
	checked := 0
	for _, first := range people {
		for _, second := range people {
			values := chatValues(first, second)
			for key, value := range values {
				if strings.TrimSpace(value) == "" {
					t.Errorf("%s with %s: %s is blank", first.Name, second.Name, key)
				}
			}
			for _, template := range templates {
				for _, text := range []string{template.say, template.answer} {
					said := fill(text, values)
					checked++
					if blankSlot.MatchString(said) || slot.MatchString(said) {
						t.Errorf("%s to %s: %q has a blank in it", first.Name, second.Name, said)
					}
					// Every blank the template names has a value, so a typo in a template can't pass.
					for _, name := range slot.FindAllStringSubmatch(text, -1) {
						if _, ok := values[name[1]]; !ok {
							t.Errorf("template %q names {%s}, which nothing fills", text, name[1])
						}
					}
				}
			}
		}
	}
	if checked < 500 {
		t.Errorf("only %d lines were checked", checked)
	}
	// The folders in the demo are named as folders.
	if got := firstFile(people["Bolt"], "app.ts"); got != "test/" {
		t.Errorf("Bolt's first file is %q", got)
	}
	if got := firstFile(people["Mori"], "app.ts"); got != "docs/" {
		t.Errorf("Mori's first file is %q", got)
	}
	if got := firstFile(people["Slashes"], "app.ts"); got != "app.ts" {
		t.Errorf("nothing to name: %q", got)
	}
}

// What the demo's agents say in the office reads whole too, from the first seconds to well past
// the point where every agent has talked.
func TestDemoChatNeverHasABlank(t *testing.T) {
	sim, engine, c, _ := setup(t, ":memory:", 7)
	if err := sim.LoadDemo(); err != nil {
		t.Fatal(err)
	}
	advance(t, sim, c, 300)
	messages := engine.Snapshot().Messages
	if len(messages) < 20 {
		t.Fatalf("only %d messages", len(messages))
	}
	for _, message := range messages {
		if blankSlot.MatchString(message.Text) {
			t.Errorf("%s to %s: %q", message.FromName, message.ToName, message.Text)
		}
	}
	for _, agent := range engine.Snapshot().Agents {
		for _, event := range agent.Feed {
			// A step names its file, or its command, before the two spaces and the detail.
			if strings.TrimSpace(strings.SplitN(event.Summary, "  ", 2)[0]) == "" {
				t.Errorf("%s: step %q names nothing", agent.Name, event.Summary)
			}
		}
		if strings.HasSuffix(strings.TrimSpace(agent.Bubble), "Reading") || strings.HasSuffix(agent.Bubble, "Editing ") ||
			strings.HasSuffix(agent.Bubble, "Reading ") {
			t.Errorf("%s: bubble %q", agent.Name, agent.Bubble)
		}
	}
}
