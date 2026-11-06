// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/redact"
)

// What `claude -p --output-format stream-json --verbose --include-partial-messages` prints is one
// JSON object a line, documented as the Agent SDK's message types (SDKMessage). Fields Mabari has
// no use for are ignored, and so are types it doesn't know, which is what the docs ask of a reader.

// maxStreamLine is the longest line read. A Write tool call can carry a whole file. Anything longer
// is skipped, and the conversation says so, rather than taking all of the memory.
const maxStreamLine = 32 << 20

// deltaEvery is how often streaming text reaches the pages, so one fast session can't flood them.
const deltaEvery = 80 * time.Millisecond

// contentBlock is one block of a message, in the Anthropic API's format.
type contentBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
}

// apiMessage is an assistant or user message. Content is a string or a list of blocks.
type apiMessage struct {
	Content json.RawMessage `json:"content"`
}

// blocks reads the message's content, whichever form it takes.
func (m apiMessage) blocks() []contentBlock {
	var blocks []contentBlock
	if json.Unmarshal(m.Content, &blocks) == nil {
		return blocks
	}
	var text string
	if json.Unmarshal(m.Content, &text) == nil && text != "" {
		return []contentBlock{{Type: "text", Text: text}}
	}
	return nil
}

// toolOutput is the text of a tool result, which is a string or a list of blocks.
func toolOutput(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var blocks []contentBlock
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	var parts []string
	for _, block := range blocks {
		if block.Type == "text" {
			parts = append(parts, block.Text)
		}
	}
	return strings.Join(parts, "\n")
}

// toolItem is the conversation entry for a tool call, before it has a result.
func toolItem(block contentBlock, parent string) models.ConversationItem {
	return models.ConversationItem{
		ID: block.ID, Kind: models.ConversationTool, Parent: parent,
		Tool: &models.ToolCall{
			Name: block.Name, Summary: summaryOf(block.Name, block.Input), Input: string(block.Input),
			State: models.ToolRunning,
		},
	}
}

// withResult is a tool call's entry with its result. A denial outranks a failure: it never ran.
func withResult(item models.ConversationItem, block contentBlock, denied bool) models.ConversationItem {
	tool := *item.Tool
	tool.Output = toolOutput(block.Content)
	switch {
	case denied, tool.State == models.ToolDenied:
		tool.State = models.ToolDenied
	case block.IsError:
		tool.State = models.ToolFailed
	default:
		tool.State = models.ToolDone
	}
	item.Tool = &tool
	return item
}

type usage struct {
	InputTokens  int64 `json:"input_tokens"`
	OutputTokens int64 `json:"output_tokens"`
}

type denial struct {
	ToolUseID string `json:"tool_use_id"`
}

// streamLine is one line of the stream. Type says which of the fields are set.
type streamLine struct {
	Type      string          `json:"type"`
	Subtype   string          `json:"subtype"`
	SessionID string          `json:"session_id"`
	Message   json.RawMessage `json:"message"`
	Parent    *string         `json:"parent_tool_use_id"`
	Event     *streamEvent    `json:"event"`
	// On the "init" message.
	Model          string `json:"model"`
	PermissionMode string `json:"permissionMode"`
	// On a "permission_denied" message.
	ToolUseID string `json:"tool_use_id"`
	// On the "result" message.
	Result            string   `json:"result"`
	IsError           bool     `json:"is_error"`
	Errors            []string `json:"errors"`
	TotalCost         float64  `json:"total_cost_usd"`
	Usage             usage    `json:"usage"`
	PermissionDenials []denial `json:"permission_denials"`
}

// message decodes the assistant or user message on the line. It is held raw because a "system"
// line uses the same key for plain text.
func (line streamLine) message() apiMessage {
	var message apiMessage
	_ = json.Unmarshal(line.Message, &message)
	return message
}

// streamEvent is the part of the Anthropic API's stream events that matters here.
type streamEvent struct {
	Type         string `json:"type"`
	Index        int    `json:"index"`
	ContentBlock struct {
		Type string `json:"type"`
	} `json:"content_block"`
	Delta struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"delta"`
}

// liveText is an assistant message's text as it arrives.
type liveText struct {
	id   string
	time int64
	raw  strings.Builder
	// sent is the masked text the pages have.
	sent    string
	flushed time.Time
}

// readLine reads one line, skipping what is past limit and reporting that it did.
func readLine(reader *bufio.Reader, limit int) (line []byte, skipped bool, err error) {
	for {
		part, readErr := reader.ReadSlice('\n')
		if !skipped && len(line)+len(part) <= limit {
			line = append(line, part...)
		} else {
			skipped, line = true, nil
		}
		if errors.Is(readErr, bufio.ErrBufferFull) {
			continue
		}
		return line, skipped, readErr
	}
}

// read handles the process's output until it ends.
func (c *Connector) read(r *run, stdout io.Reader) {
	reader := bufio.NewReaderSize(stdout, 64<<10)
	for {
		line, skipped, err := readLine(reader, maxStreamLine)
		switch {
		case skipped:
			c.tooLong(r)
		case len(line) > 0:
			c.handleLine(r, line)
		}
		if err != nil {
			return
		}
	}
}

func (c *Connector) tooLong(r *run) {
	_ = c.engine.Do(func() {
		if agent := c.runAgent(r); agent != nil {
			c.notice(agent, "One message was too long to keep here. It's in the session's own transcript.")
		}
	})
}

// handleLine handles one line of the stream.
func (c *Connector) handleLine(r *run, raw []byte) {
	var line streamLine
	if json.Unmarshal(raw, &line) != nil {
		return
	}
	switch line.Type {
	case "stream_event":
		c.handleEvent(r, line.Event)
	case "assistant":
		c.handleAssistant(r, line)
	case "user":
		c.handleResults(r, line)
	case "system":
		switch line.Subtype {
		case "init":
			c.handleInit(r, line)
		case "permission_denied":
			r.denied[line.ToolUseID] = true
		case "compact_boundary":
			_ = c.engine.Do(func() {
				if agent := c.runAgent(r); agent != nil {
					c.notice(agent, "The conversation was compacted to save room.")
				}
			})
		}
	case "result":
		c.handleResult(r, line)
	}
}

// handleInit reads the session's metadata. The session's permission mode is checked here, before
// it has done anything: approvals only stop for a click in the modes Mabari asked for, so one that
// comes up in another is ended. Nothing should cause this, because the flag outranks every settings
// file, but managed settings outrank the flag.
func (c *Connector) handleInit(r *run, line streamLine) {
	_ = c.engine.Do(func() {
		agent := c.runAgent(r)
		if agent == nil {
			return
		}
		if line.PermissionMode != "" && line.PermissionMode != runModeDefault && line.PermissionMode != runModePlan {
			c.engine.Log(agent.Name, models.LogSession, "Started in "+line.PermissionMode+" mode", "Stopped by Mabari", "red")
			c.fail(agent, "Claude Code started in "+line.PermissionMode+" mode, where actions may not stop for your click, so Mabari ended it.")
			c.retire(r)
			return
		}
		if line.Model != "" {
			agent.Model = modelName(line.Model)
		}
		if agent.Session != nil {
			session := *agent.Session
			session.Started = true
			if line.SessionID != "" && line.SessionID != session.ID {
				// Resuming keeps the id today. If that ever changes, hooks carry the new one.
				c.mu.Lock()
				c.sessions[line.SessionID] = agent.ID
				c.mu.Unlock()
				session.ID = line.SessionID
			}
			agent.Session = &session
		}
		c.engine.Touch(agent)
	})
}

// handleEvent builds streaming text from partial messages.
func (c *Connector) handleEvent(r *run, event *streamEvent) {
	if event == nil {
		return
	}
	switch event.Type {
	case "content_block_start":
		if event.ContentBlock.Type != "text" {
			return
		}
		live := &liveText{id: "item-" + newSessionID(), time: time.Now().UnixMilli()}
		r.live[event.Index] = live
		r.order = append(r.order, live)
		_ = c.engine.Do(func() {
			if agent := c.runAgent(r); agent != nil {
				c.engine.Converse(agent.ID, models.ConversationItem{
					ID: live.id, Time: live.time, Kind: models.ConversationAssistant, Streaming: true,
				})
			}
		})
	case "content_block_delta":
		live := r.live[event.Index]
		if live == nil || event.Delta.Type != "text_delta" {
			return
		}
		if live.raw.Len() < models.ConversationTextLimit*4 {
			live.raw.WriteString(event.Delta.Text)
		}
		if time.Since(live.flushed) >= deltaEvery {
			c.flushLive(r, live, false)
		}
	case "content_block_stop":
		if live := r.live[event.Index]; live != nil {
			c.flushLive(r, live, true)
			delete(r.live, event.Index)
		}
	}
}

// flushLive passes on what has arrived. Text is masked whole, since a secret can span two deltas,
// and until the end the last word is held back, since it may be the start of one.
func (c *Connector) flushLive(r *run, live *liveText, final bool) {
	text := live.raw.String()
	if !final {
		cut := strings.LastIndexAny(text, " \n\t")
		if cut < 0 {
			return
		}
		text = text[:cut+1]
	}
	clean := redact.Text(text)
	live.flushed = time.Now()
	if clean == live.sent {
		return
	}
	_ = c.engine.Do(func() {
		agent := c.runAgent(r)
		if agent == nil {
			return
		}
		if strings.HasPrefix(clean, live.sent) {
			c.engine.ConverseDelta(agent.ID, live.id, clean[len(live.sent):])
		} else {
			// Masking changed what was already shown, so the whole text goes again.
			c.engine.Converse(agent.ID, models.ConversationItem{
				ID: live.id, Time: live.time, Kind: models.ConversationAssistant, Text: clean, Streaming: true,
			})
		}
	})
	live.sent = clean
}

// takeLive is the oldest streamed text not yet matched with its finished message.
func (r *run) takeLive() *liveText {
	if len(r.order) == 0 {
		return nil
	}
	live := r.order[0]
	r.order = r.order[1:]
	for index, open := range r.live {
		if open == live {
			delete(r.live, index)
		}
	}
	return live
}

// handleAssistant takes a finished message. Claude Code may send one per content block, all with
// the same message id, so text is matched with what streamed by its order. Thinking isn't kept.
func (c *Connector) handleAssistant(r *run, line streamLine) {
	parent := ""
	if line.Parent != nil {
		parent = *line.Parent
	}
	blocks := line.message().blocks()
	// Worked out first, because a summary masks the call and everyone waits inside Do.
	calls := map[string]models.ConversationItem{}
	for _, block := range blocks {
		if block.Type == "tool_use" {
			calls[block.ID] = toolItem(block, parent)
		}
	}
	_ = c.engine.Do(func() {
		agent := c.runAgent(r)
		if agent == nil {
			return
		}
		for _, block := range blocks {
			switch block.Type {
			case "text":
				item := models.ConversationItem{Kind: models.ConversationAssistant, Text: block.Text, Parent: parent}
				if parent == "" {
					if live := r.takeLive(); live != nil {
						item.ID, item.Time = live.id, live.time
					}
				}
				if strings.TrimSpace(block.Text) != "" || item.ID != "" {
					c.engine.Converse(agent.ID, item)
				}
			case "tool_use":
				r.tools[block.ID] = c.engine.Converse(agent.ID, calls[block.ID])
				if parent == "" && agent.State != models.StateApproval && agent.State != models.StatePaused {
					agent.State = stateFor(block.Name)
					c.engine.Touch(agent)
				}
			}
		}
	})
}

// handleResults puts tool results on their calls.
func (c *Connector) handleResults(r *run, line streamLine) {
	blocks := line.message().blocks()
	_ = c.engine.Do(func() {
		agent := c.runAgent(r)
		if agent == nil {
			return
		}
		for _, block := range blocks {
			if block.Type != "tool_result" {
				continue
			}
			item, known := r.tools[block.ToolUseID]
			if !known {
				continue
			}
			r.tools[block.ToolUseID] = c.engine.Converse(agent.ID, withResult(item, block, r.denied[block.ToolUseID]))
		}
	})
}

// handleResult ends a turn: one result comes for each.
func (c *Connector) handleResult(r *run, line streamLine) {
	for _, live := range r.order {
		c.flushLive(r, live, true)
	}
	// Masked first and cut to what a reply keeps, because everyone waits inside Do.
	if most := models.ReplyLimit * 4; len(line.Result) > most {
		line.Result = strings.ToValidUTF8(line.Result[:most], "")
	}
	line.Result = redact.Text(line.Result)
	_ = c.engine.Do(func() {
		agent := c.runAgent(r)
		if agent == nil {
			return
		}
		c.closeLive(r, agent)
		c.markDenied(r, agent, line.PermissionDenials)
		r.pending = max(0, r.pending-1)
		// total_cost_usd is a running total, resumed sessions included. usage covers one turn.
		agent.Cost = max(agent.Cost, line.TotalCost)
		agent.TokensIn += line.Usage.InputTokens
		agent.TokensOut += line.Usage.OutputTokens
		c.engine.Touch(agent)
		if r.interrupted {
			r.interrupted = false
			return
		}
		if agent.State == models.StatePaused {
			return
		}
		if line.IsError || line.Subtype != "success" {
			c.fail(agent, resultError(line))
			return
		}
		if r.pending > 0 {
			return
		}
		c.turnFinished(agent, line.Result)
	})
}

// closeLive finishes streamed text whose finished message never came, as after an interrupt.
func (c *Connector) closeLive(r *run, agent *models.LiveAgent) {
	for live := r.takeLive(); live != nil; live = r.takeLive() {
		c.engine.Converse(agent.ID, models.ConversationItem{
			ID: live.id, Time: live.time, Kind: models.ConversationAssistant, Text: live.raw.String(),
		})
	}
	clear(r.live)
}

// markDenied updates calls whose denial was only known once the turn ended, then forgets the
// turn's calls.
func (c *Connector) markDenied(r *run, agent *models.LiveAgent, denials []denial) {
	for _, denied := range denials {
		item, known := r.tools[denied.ToolUseID]
		if !known || item.Tool == nil || item.Tool.State == models.ToolDenied {
			continue
		}
		tool := *item.Tool
		tool.State = models.ToolDenied
		item.Tool = &tool
		c.engine.Converse(agent.ID, item)
	}
	clear(r.tools)
	clear(r.denied)
}

// resultError says in words why a turn failed.
func resultError(line streamLine) string {
	switch {
	case line.Result != "":
		return line.Result
	case len(line.Errors) > 0:
		return strings.Join(line.Errors, " ")
	case line.Subtype == "error_max_budget_usd":
		return "It reached its cost cap."
	case line.Subtype == "error_max_turns":
		return "It reached its limit of turns."
	}
	return "Claude Code stopped with an error."
}
