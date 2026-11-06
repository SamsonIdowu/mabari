// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"crypto/rand"
	"encoding/hex"
	"slices"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// Parallel tool calls and subagents all report under one session id, so one agent can have several
// hook calls waiting for a person at once, while its card shows one approval at a time. So each call
// waits under its own approval's id, and an answer can only reach the call it was for: a click on
// one card can never allow another call. Calls wait in line, oldest first, and the next card shows
// when the one before it is settled.

// withdrawnReply is what Claude hears when a call's card went away with nobody deciding. It must not
// say the person said no.
const withdrawnReply = "This request was replaced or withdrawn in Mabari before anyone answered it, " +
	"so it did not run. Ask again if it is still needed."

// approvalCall is one hook call waiting for a person.
type approvalCall struct {
	agentID  string
	approval models.Approval
	// shown is true once its card has been put up.
	shown bool
	// decided hears the answer. Whoever takes the call from waiting sends the one answer, so the
	// buffer means the send never blocks.
	decided chan models.Approval
}

// joinLine puts a call at the back of the agent's line, under an id of its own. The id is made here
// because auto approve can settle a card while it is being put up. Call inside Do.
func (c *Connector) joinLine(agentID string, approval models.Approval) *approvalCall {
	raw := make([]byte, 16)
	_, _ = rand.Read(raw) // crypto/rand never fails on supported platforms.
	approval.ID = "approval-" + hex.EncodeToString(raw)
	call := &approvalCall{agentID: agentID, approval: approval, decided: make(chan models.Approval, 1)}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.waiting[approval.ID] = call
	c.lines[agentID] = append(c.lines[agentID], call)
	return call
}

// takeCall removes a call from waiting and from its line, and returns it, or nil when it has gone.
// Only whoever gets it may answer it.
func (c *Connector) takeCall(id string) *approvalCall {
	c.mu.Lock()
	defer c.mu.Unlock()
	call := c.waiting[id]
	if call == nil {
		return nil
	}
	delete(c.waiting, id)
	line := slices.DeleteFunc(c.lines[call.agentID], func(other *approvalCall) bool { return other == call })
	if len(line) == 0 {
		delete(c.lines, call.agentID)
	} else {
		c.lines[call.agentID] = line
	}
	return call
}

// showNext puts up the card of the next call in the agent's line, unless a card is already up. Auto
// approve may settle it at once, which comes back here for the one after it. Call inside Do.
func (c *Connector) showNext(agent *models.LiveAgent) {
	if agent.Approval != nil {
		return
	}
	c.mu.Lock()
	var next *approvalCall
	for _, call := range c.lines[agent.ID] {
		if !call.shown {
			next = call
			next.shown = true
			break
		}
	}
	c.mu.Unlock()
	if next != nil {
		c.engine.RequestApproval(agent, next.approval)
	}
}

// withdraw tells a call taken from the line that nobody decided it.
func withdraw(call *approvalCall) {
	decision := models.DecisionCancelled
	call.decided <- models.Approval{Decision: &decision}
}

// withdrawCalls settles every call in the agent's line with no decision, as when it stops. Call
// inside Do.
func (c *Connector) withdrawCalls(agentID string) {
	c.withdrawWhere(agentID, func(*approvalCall) bool { return true })
}

// WithdrawQueued settles the calls whose cards haven't been shown, leaving the card on show, so
// settling that card doesn't bring up the next. Call inside Do.
func (c *Connector) WithdrawQueued(agent *models.LiveAgent) {
	c.withdrawWhere(agent.ID, func(call *approvalCall) bool { return !call.shown })
}

func (c *Connector) withdrawWhere(agentID string, match func(*approvalCall) bool) {
	c.mu.Lock()
	var ids []string
	for _, call := range c.lines[agentID] {
		if match(call) {
			ids = append(ids, call.approval.ID)
		}
	}
	c.mu.Unlock()
	for _, id := range ids {
		if call := c.takeCall(id); call != nil {
			withdraw(call)
		}
	}
}

// supersede tells the call behind the agent's card that the card is being replaced by something
// that isn't a call, such as a plan. Call inside Do.
func (c *Connector) supersede(agent *models.LiveAgent) {
	if agent.Approval == nil {
		return
	}
	if call := c.takeCall(agent.Approval.ID); call != nil {
		withdraw(call)
	}
}

// giveUp ends a call nobody answered in time, or whose hook has gone. An answer that came in just as
// time ran out still counts, and is returned. Otherwise its card, if it got one, goes, and the next
// one shows.
func (c *Connector) giveUp(call *approvalCall, agentID string, fromRun bool) *models.Approval {
	said := "Left to Claude Code's own prompt"
	if fromRun {
		said = "Denied: nobody answered in time"
	}
	var answer *models.Approval
	_ = c.engine.Do(func() {
		if c.takeCall(call.approval.ID) == nil {
			select {
			case approval := <-call.decided:
				answer = &approval
			default:
			}
			return
		}
		agent := c.engine.Agent(agentID)
		if agent == nil {
			return
		}
		if agent.Approval != nil && agent.Approval.ID == call.approval.ID {
			c.engine.CancelApproval(agent)
			agent.State = models.StateThinking
			c.engine.AddEvent(agent, "approval", said, nil)
		}
		c.showNext(agent)
	})
	return answer
}
