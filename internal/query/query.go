// SPDX-License-Identifier: Apache-2.0

// Package query answers questions about an agent from its event log, so asking never interrupts
// it. Stage 7 adds answers from a connected model, on the same data.
package query

import (
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// Answer is what the log says about one agent. The UI puts it into words.
type Answer struct {
	Question string `json:"question"`
	AgentID  string `json:"agentId"`
	Name     string `json:"name"`
	State    string `json:"state"`
	Task     string `json:"task"`
	Reads    int    `json:"reads"`
	Edits    int    `json:"edits"`
	Runs     int    `json:"runs"`
	// LatestTool and LatestSummary are the most recent step, if there is one.
	LatestTool    string `json:"latestTool"`
	LatestSummary string `json:"latestSummary"`
	Estimate      string `json:"estimate"`
	Model         string `json:"model"`
	// Events are the ids of the log entries this answer used.
	Events []string `json:"events"`
	// Text is the model's own answer, and AnsweredBy the model, when one answered. Empty means
	// the answer is the summary above, built from the log.
	Text       string `json:"text"`
	AnsweredBy string `json:"answeredBy"`
}

func firstOf(feed []models.Event, tool string) string {
	for _, event := range feed {
		if event.Tool == tool {
			return event.ID
		}
	}
	return ""
}

func count(feed []models.Event, tool string) int {
	total := 0
	for _, event := range feed {
		if event.Tool == tool {
			total++
		}
	}
	return total
}

func unique(ids ...string) []string {
	seen := map[string]bool{}
	kept := []string{}
	for _, id := range ids {
		if id != "" && !seen[id] {
			seen[id] = true
			kept = append(kept, id)
		}
	}
	return kept
}

// Ask answers a question about an agent from its feed.
func Ask(agent *models.LiveAgent, question, model string, now time.Time) Answer {
	answer := Answer{
		Question: question,
		AgentID:  agent.ID,
		Name:     agent.Name,
		State:    models.StateLabels[agent.State],
		Task:     agent.Task,
		Reads:    count(agent.Feed, "read_file"),
		Edits:    count(agent.Feed, "edit_file"),
		Runs:     count(agent.Feed, "run_shell"),
		Estimate: models.ETALong(agent, now),
		Model:    model,
	}
	latest := ""
	if len(agent.Feed) > 0 {
		latest = agent.Feed[0].ID
		answer.LatestTool = agent.Feed[0].Tool
		answer.LatestSummary = agent.Feed[0].Summary
	}
	lastRun := firstOf(agent.Feed, "run_shell")
	if lastRun == "" {
		lastRun = firstOf(agent.Feed, "read_file")
	}
	answer.Events = unique(latest, firstOf(agent.Feed, "edit_file"), lastRun)
	return answer
}

// TeamLine is one agent's row when a question goes to everyone.
type TeamLine struct {
	Name     string `json:"name"`
	State    string `json:"state"`
	Estimate string `json:"estimate"`
	Task     string `json:"task"`
}

// Short is what an agent's bubble says after a question.
func Short(agent *models.LiveAgent, now time.Time) string {
	return models.StateLabels[agent.State] + ". " + models.ETALong(agent, now) + "."
}
