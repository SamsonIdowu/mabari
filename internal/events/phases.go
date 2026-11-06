// SPDX-License-Identifier: Apache-2.0

package events

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

// aliveEvery is how often the server notes that it is still running, so that after a restart the
// timeline knows when it stopped.
const aliveEvery = 30 * time.Second

// trackPhases records each change in what the agents are doing, as they are saved, and logs the
// two that matter after the fact: an agent finishing its task, and an agent stopping with an error.
// No connector says so itself, and the recap of an absence is built from the log, so this is where
// they are written down. It runs in flush, so every connector is covered, and an agent seen for the
// first time is recorded but not announced: it did not finish anything in front of us.
//
// Subagents are left out. They are helpers inside a lead's task, come and go in seconds, and
// their work shows as their lead's.
func (e *Engine) trackPhases(now int64) {
	for _, agent := range e.agents {
		if _, ok := e.dirty[agent.ID]; !ok || agent.Lead != nil {
			continue
		}
		phase := models.PhaseOf(agent)
		before, seen := e.phases[agent.ID]
		if seen && before == phase {
			continue
		}
		e.recordPhase(agent.ID, agent.Name, phase, now)
		switch {
		case !seen:
		case phase == models.PhaseDone:
			e.Log(agent.Name, models.LogSession, models.PrefixFinished+orElse(agent.Task, "a task"),
				models.OutcomeFinished, "ok")
		case phase == models.PhaseError:
			e.Log(agent.Name, models.LogSession, models.PrefixError+orElse(agent.Error, "no reason given"),
				models.OutcomeError, "red")
		}
	}
}

func orElse(text, fallback string) string {
	if strings.TrimSpace(text) == "" {
		return fallback
	}
	return text
}

func (e *Engine) recordPhase(id, name string, phase models.Phase, at int64) {
	e.phases[id] = phase
	e.record(e.writePhase(context.Background(), id, name, phase, at))
}

func (e *Engine) writePhase(ctx context.Context, id, name string, phase models.Phase, at int64) error {
	return e.store.AddStateChange(ctx, models.StateChange{AgentID: id, Agent: name, Time: at, Phase: phase})
}

// closePhase notes that nothing is known of an agent from now on, because it left the office.
func (e *Engine) closePhase(agent *models.LiveAgent) {
	if before, ok := e.phases[agent.ID]; ok && before != models.PhaseOff {
		e.recordPhase(agent.ID, agent.Name, models.PhaseOff, e.now().UnixMilli())
	}
	delete(e.phases, agent.ID)
}

// openPhases picks up the day's record after a start. Each agent that was shown doing something
// when the server stopped is closed at the last moment the server was known to be running, since
// what happened in between is unknown, and then everyone is recorded as they are now. Call
// while loading, after the agents.
func (e *Engine) openPhases(ctx context.Context) error {
	last, err := e.store.LastStateChanges(ctx)
	if err != nil {
		return err
	}
	now := e.now().UnixMilli()
	alive := int64(0)
	if raw, err := e.store.Meta(ctx, store.MetaAlive); err != nil {
		return err
	} else if stamp, err := strconv.ParseInt(raw, 10, 64); err == nil {
		alive = stamp
	}
	closeAt := func(previous models.StateChange) int64 {
		// Without a stamp the change is the last thing known. A clock that went back never puts
		// the end before the start, or after now.
		return min(max(alive, previous.Time), now)
	}
	known := map[string]bool{}
	for _, agent := range e.agents {
		if agent.Lead != nil {
			continue
		}
		known[agent.ID] = true
		current := models.Phase("")
		if previous, ok := last[agent.ID]; ok {
			current = previous.Phase
			if previous.Phase.Shown() {
				if err := e.writePhase(ctx, agent.ID, agent.Name, models.PhaseOff, closeAt(previous)); err != nil {
					return err
				}
				current = models.PhaseOff
			}
		}
		phase := models.PhaseOf(agent)
		if phase != current {
			if err := e.writePhase(ctx, agent.ID, agent.Name, phase, now); err != nil {
				return err
			}
		}
		e.phases[agent.ID] = phase
	}
	// An agent that is no longer in the office left while the server was down.
	for id, previous := range last {
		if !known[id] && previous.Phase.Shown() {
			if err := e.writePhase(ctx, id, previous.Agent, models.PhaseOff, closeAt(previous)); err != nil {
				return err
			}
		}
	}
	return nil
}

// noteAlive stamps the time, so a restart can tell how long Mabari was stopped. Call inside Do.
func (e *Engine) noteAlive() {
	e.record(e.store.SetMeta(context.Background(), store.MetaAlive, strconv.FormatInt(e.now().UnixMilli(), 10)))
}
