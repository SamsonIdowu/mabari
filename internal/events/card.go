// SPDX-License-Identifier: Apache-2.0

package events

import "github.com/SamsonIdowu/mabari/internal/models"

// Card is the card for an agent's name tag: its role and what it did today. It reads the office
// under the lock, and reports false when there is no such agent.
func (e *Engine) Card(id string) (models.AgentCard, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	agent := e.Agent(id)
	if agent == nil {
		return models.AgentCard{}, false
	}
	var lead *models.LiveAgent
	if agent.Lead != nil {
		lead = e.Agent(*agent.Lead)
	}
	helpers := 0
	for _, other := range e.agents {
		if other.Lead != nil && *other.Lead == agent.ID {
			helpers++
		}
	}
	var def *models.AgentDef
	for index := range e.defs {
		if e.defs[index].ID == agent.DefID && agent.DefID != "" {
			def = &e.defs[index]
			break
		}
	}
	return models.CardFor(agent, lead, helpers, def, e.now()), true
}
