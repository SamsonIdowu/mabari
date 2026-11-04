// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	mabanswer "github.com/SamsonIdowu/mabari/internal/answer"
	"github.com/SamsonIdowu/mabari/internal/dispatch"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/query"
)

const (
	targetAuto     = "auto"
	targetEveryone = "everyone"
	replyMillis    = 6000
)

// scope says which agents are in view, so messages reach only what the user can see.
type scope struct {
	Project string `json:"projectId"`
	Team    string `json:"teamId"`
}

func (a *api) inScope(s scope) []*models.LiveAgent {
	var agents []*models.LiveAgent
	for _, agent := range a.engine.Agents() {
		if s.Team != "" && agent.ID != s.Team && (agent.Lead == nil || *agent.Lead != s.Team) {
			continue
		}
		if s.Project != "" && s.Project != "all" && (agent.Project == nil || *agent.Project != s.Project) {
			continue
		}
		agents = append(agents, agent)
	}
	return agents
}

func (a *api) previewDispatch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		scope
		Text string `json:"text"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	var decision *dispatch.Decision
	if err := a.engine.Do(func() { decision = a.router.Route(body.Text, a.inScope(body.scope)) }); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]*dispatch.Decision{"decision": decision})
}

type messageBody struct {
	scope
	Text string `json:"text"`
	Mode string `json:"mode"`
	// Target is "auto", "everyone" or an agent id.
	Target string `json:"target"`
	// quiet leaves out the toasts, for Mabari on Home, which says the same thing itself.
	quiet bool
}

type messageResult struct {
	Agents []string           `json:"agents"`
	Answer *query.Answer      `json:"answer"`
	Team   []query.TeamLine   `json:"team"`
	Routed *dispatch.Decision `json:"routed"`
	// facts and model are taken inside the lock, for a model to answer after it.
	facts string
	model string
}

// targets resolves who a message is for.
func (a *api) targets(body messageBody) ([]*models.LiveAgent, *dispatch.Decision) {
	switch body.Target {
	case targetAuto, "":
		decision := a.router.Route(body.Text, a.inScope(body.scope))
		if decision == nil {
			return nil, nil
		}
		return []*models.LiveAgent{a.engine.Agent(decision.AgentID)}, decision
	case targetEveryone:
		var agents []*models.LiveAgent
		for _, agent := range a.inScope(body.scope) {
			if agent.State != models.StateError {
				agents = append(agents, agent)
			}
		}
		return agents, nil
	default:
		if agent := a.engine.Agent(body.Target); agent != nil {
			return []*models.LiveAgent{agent}, nil
		}
		return nil, nil
	}
}

func (a *api) ask(agents []*models.LiveAgent, text string, result *messageResult) {
	now := a.engine.Now()
	if len(agents) > 1 {
		for _, agent := range agents {
			result.Team = append(result.Team, query.TeamLine{
				Name:     agent.Name,
				State:    models.StateLabels[agent.State],
				Estimate: strings.ToLower(models.ETALong(agent, now)),
				Task:     agent.Task,
			})
		}
		a.engine.Log("Everyone", models.LogQuery, text, "Answered from the log", "")
		return
	}
	agent := agents[0]
	answer := query.Ask(agent, text, a.engine.Settings().QueryModel, now)
	result.Answer = &answer
	result.facts, result.model = mabanswer.Facts(agent, now), a.engine.Settings().QueryModel
	a.engine.Log(agent.Name, models.LogQuery, text, "Answered from the log", "")
	a.engine.SetReply(agent, query.Short(agent, now), replyMillis)
}

func (a *api) instruct(agents []*models.LiveAgent, text string, quiet bool) {
	for _, agent := range agents {
		if connector := a.engine.ConnectorFor(agent); connector != nil {
			connector.Instruct(agent, text)
		}
	}
	if quiet {
		return
	}
	waiting := 0
	for _, agent := range agents {
		for _, queued := range agent.Queued {
			if queued.Text == text {
				waiting++
				break
			}
		}
	}
	switch {
	case len(agents) > 1 && waiting > 0:
		a.engine.Toast("Sent to " + strconv.Itoa(len(agents)) + " agents. " + strconv.Itoa(waiting) +
			" will get it at their next checkpoint")
	case len(agents) > 1:
		a.engine.Toast("Sent to " + strconv.Itoa(len(agents)) + " agents")
	case waiting > 0:
		a.engine.Toast("Queued for " + agents[0].Name + ". It will be delivered at the next checkpoint.")
	default:
		a.engine.Toast("Sent to " + agents[0].Name)
	}
}

func (a *api) sendMessage(w http.ResponseWriter, r *http.Request) {
	var body messageBody
	if !readJSON(w, r, &body) {
		return
	}
	text := strings.TrimSpace(body.Text)
	if text == "" {
		writeError(w, http.StatusBadRequest, "a message needs some text")
		return
	}
	if body.Mode != string(models.ModeInstruct) && body.Mode != string(models.ModeQuery) {
		writeError(w, http.StatusBadRequest, `mode must be "instruct" or "query"`)
		return
	}
	body.Text = text
	var result messageResult
	var delivered bool
	err := a.engine.Do(func() { result, delivered = a.deliver(body) })
	switch {
	case err != nil:
		internalError(w, err)
	case !delivered:
		writeError(w, http.StatusBadRequest, "Pick an agent first. Click one on the floor or choose it in Send to.")
	default:
		a.modelAnswer(r.Context(), &result)
		writeJSON(w, http.StatusOK, result)
	}
}

// modelAnswer has the query model write the answer when an Anthropic key is saved and a Claude
// model is chosen. Otherwise, or if the call fails, the answer from the log stands.
func (a *api) modelAnswer(ctx context.Context, result *messageResult) {
	if result.Answer == nil || a.secrets == nil || !mabanswer.IsClaude(result.model) {
		return
	}
	key, err := a.secrets.Get(string(models.AccountAnthropicKey))
	if err != nil || key == "" {
		return
	}
	call, cancel := context.WithTimeout(ctx, mabanswer.Wait)
	defer cancel()
	text, err := a.answerer(key).Answer(call, result.model, result.Answer.Question, result.facts)
	if err != nil {
		slog.Warn("the query model could not answer; using the log", "model", result.model, "error", err)
		return
	}
	result.Answer.Text, result.Answer.AnsweredBy = text, result.model
	_ = a.engine.Do(func() {
		if agent := a.engine.Agent(result.Answer.AgentID); agent != nil {
			a.engine.Log(agent.Name, models.LogQuery, result.Answer.Question, "Answered by "+result.model, "")
			a.engine.SetReply(agent, firstSentence(text), replyMillis)
		}
	})
}

func firstSentence(text string) string {
	if cut := strings.IndexAny(text, ".!?"); cut > 0 && cut < 120 {
		return text[:cut+1]
	}
	if runes := []rune(text); len(runes) > 90 {
		return string(runes[:89]) + "…"
	}
	return text
}

// deliver is the one way a message reaches an agent. It runs inside engine.Do, and reports false
// when nobody could take the message.
func (a *api) deliver(body messageBody) (messageResult, bool) {
	result := messageResult{Agents: []string{}}
	agents, routed := a.targets(body)
	if len(agents) == 0 {
		return result, false
	}
	for _, agent := range agents {
		result.Agents = append(result.Agents, agent.ID)
	}
	if routed != nil {
		result.Routed = routed
		kind := models.LogInstruction
		if body.Mode == string(models.ModeQuery) {
			kind = models.LogQuery
		}
		a.engine.Log("Mabari", kind, body.Text, "Routed to "+routed.Name, "")
		if !body.quiet {
			a.engine.Toast("Mabari sent it to " + routed.Name + ": " + routed.Reason)
		}
	}
	if body.Mode == string(models.ModeQuery) {
		a.ask(agents, body.Text, &result)
	} else {
		a.instruct(agents, body.Text, body.quiet)
	}
	return result, true
}

func (a *api) autoApprove(w http.ResponseWriter, r *http.Request) {
	var body struct {
		On    bool   `json:"on"`
		Scope string `json:"scope"`
		// Acknowledged is the confirmation box for approving risky actions without asking.
		Acknowledged bool `json:"acknowledged"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.Scope == "" {
		body.Scope = "safe"
	}
	if body.Scope != "safe" && body.Scope != "all" {
		writeError(w, http.StatusBadRequest, `scope must be "safe" or "all"`)
		return
	}
	if body.On && body.Scope == "all" && !body.Acknowledged {
		writeError(w, http.StatusBadRequest, "approving everything needs an acknowledgement")
		return
	}
	var settled int
	if err := a.engine.Do(func() { settled = a.engine.SetAutoApprove(body.On, body.Scope) }); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"settled": settled})
}
