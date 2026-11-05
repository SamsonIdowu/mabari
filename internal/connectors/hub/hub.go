// SPDX-License-Identifier: Apache-2.0

// Package hub lets people's own scripts and agents report to the office over a small HTTP API,
// described in docs/HUB_API.md. Hub agents are blue.
package hub

import (
	"errors"
	"regexp"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/redact"
)

// Source marks agents reported through the hub.
const Source = "hub"

// Event is one report from a custom app.
type Event struct {
	// Agent is the app's own id for the agent. Letters, numbers, dashes and underscores.
	Agent    string  `json:"agent"`
	Name     string  `json:"name"`
	Model    string  `json:"model"`
	State    string  `json:"state"`
	Task     string  `json:"task"`
	Progress float64 `json:"progress"`
	Tool     string  `json:"tool"`
	Summary  string  `json:"summary"`
	Say      string  `json:"say"`
	Folder   string  `json:"folder"`
	Error    string  `json:"error"`
}

// StateEnd takes the agent out of the office.
const StateEnd = "end"

var agentIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

var states = map[string]models.AgentState{
	"thinking": models.StateThinking, "reading": models.StateReading, "editing": models.StateEditing,
	"running": models.StateRunning, "browsing": models.StateBrowsing, "idle": models.StateIdle,
	"done": models.StateDone, "error": models.StateError, "paused": models.StatePaused,
}

// Connector seats hub agents and keeps their instructions until the app asks for them.
type Connector struct{ engine *events.Engine }

// New returns a connector. Register it with engine.AddConnector(Source, connector).
func New(engine *events.Engine) *Connector { return &Connector{engine: engine} }

func agentID(id string) string { return "hub-" + id }

// Check refuses an event before anything changes.
func Check(event Event) error {
	if !agentIDPattern.MatchString(event.Agent) {
		return errors.New("agent must be 1 to 64 letters, numbers, dashes or underscores")
	}
	if _, ok := states[event.State]; !ok && event.State != StateEnd && event.State != "" {
		return errors.New("state must be thinking, reading, editing, running, browsing, idle, done, error, paused or end")
	}
	if event.Progress < 0 || event.Progress > 1 {
		return errors.New("progress must be between 0 and 1")
	}
	return nil
}

func clip(text string, limit int) string {
	text = strings.TrimSpace(strings.SplitN(redact.Text(text), "\n", 2)[0])
	if runes := []rune(text); len(runes) > limit {
		return string(runes[:limit-1]) + "…"
	}
	return text
}

// Report applies one event, seating the agent on its first report. It returns false when every
// desk is taken. Call inside Do.
func (c *Connector) Report(event Event) bool {
	id := agentID(event.Agent)
	agent := c.engine.Agent(id)
	if event.State == StateEnd {
		if agent != nil {
			c.engine.RemoveAgent(id)
		}
		return true
	}
	if agent == nil {
		desk := models.FreeDesk(c.engine.Agents(), false, -1)
		if desk < 0 {
			return false
		}
		agent = &models.LiveAgent{}
		agent.ID = id
		agent.Name = clip(event.Name, 24)
		if agent.Name == "" {
			agent.Name = event.Agent
		}
		agent.Provider = models.ProviderCustom
		agent.Account = models.AccountHub
		agent.Source = Source
		agent.Model = clip(event.Model, 40)
		agent.SubModel = "inherit"
		agent.Desk = desk
		agent.Folder = clip(event.Folder, 200)
		count := len(c.engine.Agents())
		agent.Hue = models.Hues[count%len(models.Hues)]
		agent.Skin = models.Skins[count%len(models.Skins)]
		agent.Hair = models.Hairs[(count*3)%len(models.Hairs)]
		agent.CreatedAt = c.engine.Now().UnixMilli()
		agent.State = models.StateIdle
		agent.Task = "Waiting for work"
		agent.Queued = []models.Instruction{}
		agent.Files = []string{}
		c.engine.AddAgent(agent)
		c.engine.Log(agent.Name, models.LogSession, "A hub agent reported for the first time",
			"Took a desk", "ok")
	}
	if state, ok := states[event.State]; ok {
		agent.State = state
	}
	if event.Task != "" {
		agent.Task = clip(event.Task, 120)
	}
	if event.Model != "" {
		agent.Model = clip(event.Model, 40)
	}
	agent.Progress = event.Progress
	agent.Error = clip(event.Error, 160)
	if event.Tool != "" || event.Summary != "" {
		c.engine.AddEvent(agent, clip(orDefault(event.Tool, "note"), 32), clip(event.Summary, 160), nil)
	}
	if event.Say != "" {
		c.engine.SetReply(agent, clip(event.Say, 90), 8000)
	}
	c.engine.Touch(agent)
	return true
}

// Instructions hands over everything waiting for a hub agent, oldest first. Call inside Do.
func (c *Connector) Instructions(id string) []string {
	agent := c.engine.Agent(agentID(id))
	if agent == nil {
		return []string{}
	}
	texts := []string{}
	for {
		instruction, ok := c.engine.NextQueued(agent)
		if !ok {
			return texts
		}
		texts = append(texts, instruction.Text)
	}
}

func orDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

// Start does nothing: apps report by themselves.
func (c *Connector) Start() {}

// Stop does nothing.
func (c *Connector) Stop() {}

// Instruct keeps the message until the app asks for its instructions.
func (c *Connector) Instruct(agent *models.LiveAgent, text string) { c.engine.Queue(agent, text) }

// Decide does nothing: hub apps don't ask for approvals yet.
func (c *Connector) Decide(*models.LiveAgent, models.Approval) {}

// Interrupt is passed on as an instruction, since Mabari can't reach into the app.
func (c *Connector) Interrupt(agent *models.LiveAgent) { c.engine.Queue(agent, "Please pause.") }

// Continue asks the app to carry on.
func (c *Connector) Continue(agent *models.LiveAgent) { c.engine.Queue(agent, "Please continue.") }

// StopAgent takes the agent out of the office. The app keeps running until it stops itself.
func (c *Connector) StopAgent(agent *models.LiveAgent) {
	c.engine.Queue(agent, "Please stop.")
	c.engine.RemoveAgent(agent.ID)
}

// Retry asks the app to try again.
func (c *Connector) Retry(agent *models.LiveAgent) { c.engine.Queue(agent, "Please retry.") }

// AddSubagent isn't possible for hub agents.
func (c *Connector) AddSubagent(*models.LiveAgent, string, string, string) *models.LiveAgent {
	return nil
}

// Models is whatever the app reports.
func (c *Connector) Models() []string { return models.Models[models.AccountHub] }
