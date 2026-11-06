// SPDX-License-Identifier: Apache-2.0

// Package recap works out what happened while the person was away, for the card on Home and for
// Mabari's answer to "what did I miss?". It reads only local data, the activity log and the office
// as it is, and calls no model.
package recap

import (
	"context"
	"errors"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

// ErrBackwards is returned for a period that ends before it starts.
var ErrBackwards = errors.New("a recap can't end before it starts")

// Of works out what happened from since up to until, in Unix milliseconds. agents are the office as
// it is now: they say who is still here to link to, and what waits for the person this moment.
// There is no spend in it, because only each agent's running total is kept, never what it spent in
// a period, and a figure that could not be true is better left out.
func Of(ctx context.Context, s *store.Store, agents []*models.LiveAgent, since, until int64) (models.Recap, error) {
	if until < since {
		return models.Recap{}, ErrBackwards
	}
	recap := models.Recap{Since: since, Until: until}
	people := byName(agents)
	var err error
	window := store.LogQuery{Since: since, Until: until}
	if recap.Finished, err = group(ctx, s, people, window, models.LogSession, models.OutcomeFinished, models.PrefixFinished); err != nil {
		return recap, err
	}
	if recap.Errors, err = group(ctx, s, people, window, models.LogSession, models.OutcomeError, models.PrefixError); err != nil {
		return recap, err
	}
	if recap.AutoApproved, err = group(ctx, s, people, window, models.LogApproval, models.OutcomeAutoAllowed, ""); err != nil {
		return recap, err
	}
	var news bool
	recap.Needs, news = needs(agents, since)
	recap.Happened = news || recap.Finished.Count+recap.Errors.Count+recap.AutoApproved.Count > 0
	return recap, nil
}

func byName(agents []*models.LiveAgent) map[string]*models.LiveAgent {
	people := make(map[string]*models.LiveAgent, len(agents))
	for _, agent := range agents {
		people[strings.ToLower(agent.Name)] = agent
	}
	return people
}

// group counts the rows of one kind in the window, and lists the newest few.
func group(
	ctx context.Context, s *store.Store, people map[string]*models.LiveAgent,
	window store.LogQuery, kind models.LogType, outcome, prefix string,
) (models.RecapGroup, error) {
	window.Type, window.Outcome = kind, outcome
	group := models.RecapGroup{Items: []models.RecapItem{}}
	var err error
	if group.Count, err = s.LogCount(ctx, window); err != nil {
		return group, err
	}
	window.Limit = models.RecapListed
	rows, err := s.Log(ctx, window)
	if err != nil {
		return group, err
	}
	for _, row := range rows {
		item := models.RecapItem{Agent: row.Agent, Text: strings.TrimPrefix(row.Message, prefix), Time: row.Time}
		// An agent that has left has no panel to open, and a new one with its name is another agent.
		if agent := people[strings.ToLower(row.Agent)]; agent != nil && agent.CreatedAt <= row.Time {
			item.AgentID, item.Hue = agent.ID, agent.Hue
		}
		group.Items = append(group.Items, item)
	}
	return group, nil
}

// needs lists what waits for the person now: approvals and errors first, which are the red ones,
// then questions. The second result says whether any of it began after since, which makes it news.
// An error carries no time of its own: its row is in the errors group if it happened in the window.
func needs(agents []*models.LiveAgent, since int64) (models.RecapGroup, bool) {
	group := models.RecapGroup{Items: []models.RecapItem{}}
	var news bool
	add := func(agent *models.LiveAgent, text string, at int64) {
		group.Count++
		news = news || at >= since
		if len(group.Items) < models.RecapListed {
			group.Items = append(group.Items, models.RecapItem{
				AgentID: agent.ID, Agent: agent.Name, Hue: agent.Hue, Text: text, Time: at,
			})
		}
	}
	for _, agent := range agents {
		switch {
		case agent.Asking():
			continue
		case agent.State == models.StateApproval && agent.Approval != nil:
			add(agent, models.Clip(models.ApprovalSummary(agent.Approval), 160), agent.Approval.Time)
		case agent.State == models.StateApproval:
			add(agent, "Waiting for your approval", 0)
		case agent.State == models.StateError:
			text := strings.TrimSpace(agent.Error)
			if text == "" {
				text = "Stopped with an error"
			}
			add(agent, models.Clip(text, 160), 0)
		}
	}
	for _, agent := range agents {
		if agent.Asking() {
			add(agent, "Asking: "+models.Clip(models.QuestionSummary(agent.Question), 160), agent.Question.Time)
		}
	}
	return group, news
}
