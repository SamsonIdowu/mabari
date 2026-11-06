// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"errors"
	"slices"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// SendOptions are what the message box can ask for with one message to a session Mabari runs.
type SendOptions struct {
	// Plan runs the next turn in plan mode, so the session stops at its plan and Mabari asks.
	Plan bool
	// Model switches the session's model, from this message on. Empty keeps it.
	Model string
	// Now interrupts a turn in progress and sends the message straight after, instead of waiting
	// for the next checkpoint.
	Now bool
}

// UnknownModel says a session was asked to switch to a model its account doesn't offer.
type UnknownModel struct{ Model, Agent string }

func (e UnknownModel) Error() string {
	return e.Model + " isn't one of the models for " + e.Agent + "'s account."
}

// CheckModel says why an agent's session can't switch to a model, or nil. Keeping its model is
// always fine: a session can run one the list has since dropped.
func CheckModel(agent *models.LiveAgent, model string) error {
	if model == "" || model == agent.Model || slices.Contains(models.Models[agent.Account], model) {
		return nil
	}
	return UnknownModel{Model: model, Agent: agent.Name}
}

// CanSwitchModel says whether the session's model can change now: only a session Mabari runs, that
// is not in the middle of something, because the model is a command line flag and changing it
// means starting the process again.
func CanSwitchModel(agent *models.LiveAgent) bool {
	return agent.RunsHere() && agent.Lead == nil && !busy(agent)
}

// busy is an agent that can't take a message this instant: it is working, or waiting on the person.
func busy(agent *models.LiveAgent) bool {
	return agent.State.Active() || agent.Approval != nil || agent.Asking()
}

// CanPlan says whether the next message can run in plan mode, which Claude Code holds a session to:
// a session Mabari runs that is not in the middle of a turn. Anything else can only be asked to
// plan in words.
func CanPlan(agent *models.LiveAgent) bool {
	return agent.RunsHere() && agent.Lead == nil && (agent.Session.Mode == runModePlan || !busy(agent))
}

// InstructWith sends a message to a session Mabari runs, with what the message box asked for. Plan
// mode and a new model both live on the command line, so the process ends and starts again, once
// the old one has let go of the session: two processes must never write to one. Nothing here
// grants anything: plan mode only takes away. Call inside Do.
func (c *Connector) InstructWith(agent *models.LiveAgent, text string, opt SendOptions) error {
	if !agent.RunsHere() || agent.Lead != nil {
		return errors.New(agent.Name + "'s session doesn't run in Mabari.")
	}
	if err := CheckModel(agent, opt.Model); err != nil {
		return err
	}
	switchModel := opt.Model != "" && opt.Model != agent.Model
	switchPlan := opt.Plan && agent.Session.Mode != runModePlan
	if switchModel && busy(agent) {
		return errors.New(agent.Name + " is working. Change its model once it has finished.")
	}
	if opt.Now && agent.State.Active() && agent.Approval == nil && !agent.Asking() {
		// An interrupt ends the turn at once. A message must never settle an approval, which is why
		// it is only done with none waiting.
		c.Interrupt(agent)
	}
	// Plan mode starts at the next turn, so a session in the middle of one carries on as it is.
	if switchPlan && busy(agent) {
		switchPlan = false
	}
	if !switchModel && !switchPlan {
		c.Instruct(agent, text)
		return nil
	}
	session := *agent.Session
	if switchPlan {
		session.Mode = runModePlan
	}
	agent.Session = &session
	if switchModel {
		agent.Model = opt.Model
		c.engine.AddEvent(agent, "instruction", "Model changed to "+opt.Model, nil)
		c.engine.Log(agent.Name, models.LogInstruction, "Switch model to "+opt.Model, "From the next message", "ok")
	}
	c.engine.Touch(agent)
	c.mu.Lock()
	old := c.runs[agent.ID]
	c.mu.Unlock()
	if old == nil {
		c.instructRun(agent, text)
		return nil
	}
	c.retire(old)
	c.markResumable(agent)
	id := agent.ID
	go func() {
		<-old.exited
		_ = c.engine.Do(func() {
			if again := c.engine.Agent(id); again != nil {
				c.instructRun(again, text)
			}
		})
	}()
	return nil
}
