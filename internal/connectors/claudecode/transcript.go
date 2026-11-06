// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// A session started elsewhere, in a terminal or an editor, is read from the transcript_path in its
// hook input, and only read. Claude Code's docs say the entry format is internal and changes
// between versions, so this reads only what it needs and skips whatever it doesn't recognise: a
// line it can't read costs that line, never the session. Its hooks still report everything else.

const (
	// transcriptBack is how far from the end the first read starts, so a huge old session can't
	// fill the office.
	transcriptBack = 8 << 20
	// transcriptPass is the most one read takes. The next hook reads on.
	transcriptPass = 4 << 20
)

// tail is how far a session's transcript has been read.
type tail struct {
	path   string
	offset int64
	busy   bool
	again  bool
	// tools are the calls waiting for their results.
	tools map[string]models.ConversationItem
}

// transcriptLine is the part of one transcript entry that matters here.
type transcriptLine struct {
	Type        string     `json:"type"`
	UUID        string     `json:"uuid"`
	Timestamp   string     `json:"timestamp"`
	IsMeta      bool       `json:"isMeta"`
	IsSidechain bool       `json:"isSidechain"`
	Message     apiMessage `json:"message"`
}

// transcriptFile checks a path from a hook before anything opens it. It must be a real .jsonl file
// inside Claude Code's own projects folder, so a hook's input can't point Mabari at other files.
func (c *Connector) transcriptFile(raw string) (string, bool) {
	if c.ConfigDir == "" || raw == "" {
		return "", false
	}
	path := expandHome(raw)
	if !filepath.IsAbs(path) || filepath.Ext(path) != ".jsonl" {
		return "", false
	}
	root, err := filepath.EvalSymlinks(filepath.Join(c.ConfigDir, "projects"))
	if err != nil {
		return "", false
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || !within(resolved, root) || resolved == root {
		return "", false
	}
	info, err := os.Lstat(resolved)
	if err != nil || !info.Mode().IsRegular() {
		return "", false
	}
	return resolved, true
}

// follow reads what is new in a session's transcript, off the hook's path so it never delays Claude
// Code. A read already going reads again when it ends.
func (c *Connector) follow(agentID, raw string) {
	path, ok := c.transcriptFile(raw)
	if !ok {
		return
	}
	c.mu.Lock()
	state := c.tails[agentID]
	if state == nil || state.path != path {
		state = &tail{path: path, tools: map[string]models.ConversationItem{}}
		c.tails[agentID] = state
	}
	if state.busy {
		state.again = true
		c.mu.Unlock()
		return
	}
	state.busy = true
	c.mu.Unlock()
	go c.readTail(agentID, state)
}

func (c *Connector) readTail(agentID string, state *tail) {
	for {
		lines := nextLines(state)
		_ = c.engine.Do(func() { c.applyTranscript(agentID, state, lines) })
		c.mu.Lock()
		if !state.again {
			state.busy = false
			c.mu.Unlock()
			return
		}
		state.again = false
		c.mu.Unlock()
	}
}

// nextLines reads the complete lines after state.offset. A line still being written waits.
func nextLines(state *tail) [][]byte {
	file, err := os.Open(state.path) // #nosec G304 -- checked by transcriptFile, and only read
	if err != nil {
		return nil
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return nil
	}
	// A transcript cleaned up and written again starts over.
	if info.Size() < state.offset {
		state.offset = 0
	}
	skipFirst := false
	if state.offset == 0 && info.Size() > transcriptBack {
		state.offset, skipFirst = info.Size()-transcriptBack, true
	}
	if _, err := file.Seek(state.offset, io.SeekStart); err != nil {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(file, transcriptPass))
	if err != nil {
		return nil
	}
	end := bytes.LastIndexByte(data, '\n')
	if end < 0 {
		return nil
	}
	data = data[:end+1]
	state.offset += int64(len(data))
	lines := bytes.Split(bytes.TrimSuffix(data, []byte("\n")), []byte("\n"))
	if skipFirst && len(lines) > 0 {
		lines = lines[1:]
	}
	return lines
}

func itemTime(timestamp string) int64 {
	if when, err := time.Parse(time.RFC3339Nano, timestamp); err == nil {
		return when.UnixMilli()
	}
	return 0
}

// applyTranscript adds lines to the conversation. Ids come from the transcript's own, so reading a
// line twice, as after a restart, replaces an entry rather than repeating it. Call inside Do.
func (c *Connector) applyTranscript(agentID string, state *tail, lines [][]byte) {
	agent := c.engine.Agent(agentID)
	c.mu.Lock()
	current := c.tails[agentID] == state
	c.mu.Unlock()
	// Taken over by Mabari or gone: the stream speaks for it now, or nobody does.
	if agent == nil || !current {
		return
	}
	for _, raw := range lines {
		var line transcriptLine
		if json.Unmarshal(raw, &line) != nil || line.IsMeta || line.IsSidechain {
			continue
		}
		when := itemTime(line.Timestamp)
		for index, block := range line.Message.blocks() {
			id := "t-" + line.UUID + "-" + strconv.Itoa(index)
			switch {
			case line.UUID == "":
			case line.Type == "user" && block.Type == "text" && strings.TrimSpace(block.Text) != "":
				c.engine.Converse(agentID, models.ConversationItem{
					ID: id, Time: when, Kind: models.ConversationUser, Text: block.Text, From: models.SaidInSession,
				})
			case line.Type == "assistant" && block.Type == "text" && strings.TrimSpace(block.Text) != "":
				c.engine.Converse(agentID, models.ConversationItem{
					ID: id, Time: when, Kind: models.ConversationAssistant, Text: block.Text,
				})
			case line.Type == "assistant" && block.Type == "tool_use" && block.ID != "":
				item := toolItem(block, "")
				item.Time = when
				state.tools[block.ID] = c.engine.Converse(agentID, item)
			case line.Type == "user" && block.Type == "tool_result":
				c.applyToolResult(agentID, state, block)
			}
		}
	}
}

// applyToolResult puts a result on its call, looking the call up if it was read before a restart.
func (c *Connector) applyToolResult(agentID string, state *tail, block contentBlock) {
	item, known := state.tools[block.ToolUseID]
	if !known {
		stored := c.engine.ConversationItem(agentID, block.ToolUseID)
		if stored == nil || stored.Tool == nil {
			return
		}
		item = *stored
	}
	delete(state.tools, block.ToolUseID)
	c.engine.Converse(agentID, withResult(item, block, false))
}
