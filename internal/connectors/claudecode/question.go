// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"context"
	"encoding/json"
	"maps"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/redact"
)

// AskTool is Claude Code's tool for asking the person questions with options to pick from. It
// needs the person, so Claude Code waits for answers. A PreToolUse hook gives them by allowing
// the call with updatedInput: the tool's own input with "answers" added, keyed by question text.
const AskTool = "AskUserQuestion"

// asked is a question a hook is waiting on, as Claude Code sent it.
type asked struct {
	// input is the tool's input, echoed back with the answers, as updatedInput replaces it.
	input map[string]json.RawMessage
	// items are the questions exactly as sent: their text keys the answers, and their labels
	// are the answers. What Mabari shows has secrets masked, so it can differ.
	items   []models.QuestionItem
	answers chan map[string]string
}

// readQuestions reads AskUserQuestion's input. It returns false for input Mabari can't show
// faithfully, such as no questions, too many, two with the same text or one without options; the
// session then asks in its own window.
func readQuestions(raw json.RawMessage) (*asked, models.Question, bool) {
	var input map[string]json.RawMessage
	var body struct {
		Questions []models.QuestionItem `json:"questions"`
	}
	if json.Unmarshal(raw, &input) != nil || json.Unmarshal(raw, &body) != nil {
		return nil, models.Question{}, false
	}
	if len(body.Questions) == 0 || len(body.Questions) > models.QuestionsMax {
		return nil, models.Question{}, false
	}
	shown := models.Question{Items: make([]models.QuestionItem, 0, len(body.Questions))}
	seen := map[string]bool{}
	for _, sent := range body.Questions {
		text := sent.Question
		if strings.TrimSpace(text) == "" || seen[text] || utf8.RuneCountInString(text) > models.QuestionTextMax ||
			len(sent.Options) == 0 || len(sent.Options) > models.QuestionOptionsMax {
			return nil, models.Question{}, false
		}
		seen[text] = true
		item := models.QuestionItem{
			Question: redact.Text(text), Header: shownText(sent.Header),
			MultiSelect: sent.MultiSelect, Options: make([]models.QuestionOption, 0, len(sent.Options)),
		}
		for _, option := range sent.Options {
			if strings.TrimSpace(option.Label) == "" || utf8.RuneCountInString(option.Label) > models.QuestionTextMax {
				return nil, models.Question{}, false
			}
			item.Options = append(item.Options, models.QuestionOption{
				Label: redact.Text(option.Label), Description: shownText(option.Description),
			})
		}
		shown.Items = append(shown.Items, item)
	}
	return &asked{input: input, items: body.Questions, answers: make(chan map[string]string, 1)}, shown, true
}

// shownText masks secrets and keeps the text a readable length.
func shownText(text string) string {
	return redact.Text(models.Clip(text, models.QuestionTextMax))
}

// firstQuestion is the first question's text, for the feed.
func firstQuestion(raw json.RawMessage) string {
	var body struct {
		Questions []models.QuestionItem `json:"questions"`
	}
	_ = json.Unmarshal(raw, &body)
	if len(body.Questions) == 0 {
		return "a question"
	}
	return body.Questions[0].Question
}

// ask shows Claude's question in Mabari and waits for the person's answers, as permission does
// for a click. It answers nothing, so Claude Code asks in its own window, when nobody has Mabari
// open, when the question can't be shown, when nobody answers in time or when the hook gives up.
// A question from inside a subagent is shown on the subagent.
func (c *Connector) ask(ctx context.Context, in input) []byte {
	// The call is a tool call like any other first: it is seen, and a pause stops it.
	var reply []byte
	_ = c.engine.Do(func() { reply = c.observe(in) })
	if reply != nil {
		return reply
	}
	pending, shown, ok := readQuestions(in.ToolInput)
	if !ok {
		return nil
	}
	var asker, id string
	_ = c.engine.Do(func() {
		agent := c.engine.Agent(agentID(in.SessionID))
		if in.AgentID != "" {
			if helper := c.engine.Agent(helperID(in)); helper != nil {
				agent = helper
			}
		}
		if agent == nil || !c.engine.HasViewers() {
			return
		}
		asker, id = agent.ID, c.engine.Ask(agent, shown).ID
		c.mu.Lock()
		c.asking[id] = pending
		c.mu.Unlock()
	})
	if id == "" {
		return nil
	}
	defer func() {
		c.mu.Lock()
		delete(c.asking, id)
		c.mu.Unlock()
	}()
	var answers map[string]string
	timer := time.NewTimer(c.wait)
	defer timer.Stop()
	select {
	case answers = <-pending.answers:
	case <-timer.C:
	case <-ctx.Done():
	}
	if answers == nil {
		dropped := false
		_ = c.engine.Do(func() {
			if agent := c.engine.Agent(asker); agent != nil && c.engine.DropQuestion(agent, id) {
				dropped = true
				c.engine.AddEvent(agent, "question", "Left to Claude Code's own prompt", nil)
			}
		})
		// The person may have answered just as the wait ran out.
		if !dropped {
			select {
			case answers = <-pending.answers:
			default:
			}
		}
		if answers == nil {
			return nil
		}
	}
	updated := maps.Clone(pending.input)
	updated["answers"] = mustJSON(answers)
	return mustJSON(map[string]any{"hookSpecificOutput": map[string]any{
		"hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": updated,
	}})
}

// Answer wakes the hook waiting on this question with the person's answers, which the engine has
// checked against it. Call inside Do.
func (c *Connector) Answer(_ *models.LiveAgent, question models.Question, answers []models.QuestionAnswer) {
	c.mu.Lock()
	pending := c.asking[question.ID]
	c.mu.Unlock()
	if pending == nil || len(answers) != len(pending.items) {
		return
	}
	given := make(map[string]string, len(pending.items))
	for index, item := range pending.items {
		given[item.Question] = models.AnswerText(item, answers[index])
	}
	select {
	case pending.answers <- given:
	default:
	}
}
