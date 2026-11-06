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
	// ownStart means the transcript starts with what Mabari's own process wrote, and offset began
	// after it. Nothing before that point is ever read.
	ownStart bool
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

// sessionTranscript finds the transcript Claude Code keeps for a session, in the folder it made for
// the directory the session ran in. Sessions Mabari runs have their first turn before any hook is
// sure to have named the file, so it is looked for by the session's id.
func (c *Connector) sessionTranscript(session string) (string, bool) {
	if c.ConfigDir == "" {
		return "", false
	}
	root := filepath.Join(c.ConfigDir, "projects")
	folders, err := os.ReadDir(root)
	if err != nil {
		return "", false
	}
	name := sessionChars.ReplaceAllString(session, "") + ".jsonl"
	for _, folder := range folders {
		candidate := filepath.Join(root, folder.Name(), name)
		if _, err := os.Lstat(candidate); err != nil {
			continue
		}
		if path, ok := c.transcriptFile(candidate); ok {
			return path, true
		}
	}
	return "", false
}

// countTranscript marks the end of the session's transcript as heard. Everything Mabari's process
// wrote came down its stream too, and is already in the conversation, however the words repeat, so
// what tells a copy from something new is where it sits in the file. Call inside Do.
func (c *Connector) countTranscript(agent *models.LiveAgent) {
	if agent.Session == nil {
		return
	}
	path, ok := c.sessionTranscript(agent.Session.ID)
	if !ok {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		return
	}
	session := *agent.Session
	end := info.Size()
	session.TranscriptEnd = &end
	agent.Session = &session
	c.engine.Touch(agent)
}

// catchUp reads what was added to a session's transcript since Mabari's process last ended, before
// a new process takes it on: with no hooks in Claude Code's settings, nothing else ever would. A
// process still on its way out hasn't been counted, so its session is left unread. Call inside Do.
func (c *Connector) catchUp(agent *models.LiveAgent) {
	if agent.Session == nil || agent.Session.TranscriptEnd == nil {
		return
	}
	path, ok := c.sessionTranscript(agent.Session.ID)
	if !ok {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.leavingNow(agent.ID) {
		return
	}
	state := c.tails[agent.ID]
	if state == nil {
		state = &tail{
			path: path, offset: *agent.Session.TranscriptEnd, ownStart: true,
			tools: map[string]models.ConversationItem{},
		}
		c.tails[agent.ID] = state
	}
	if state.busy {
		return
	}
	c.mu.Unlock()
	defer c.mu.Lock()
	for lines := nextLines(state); len(lines) > 0; lines = nextLines(state) {
		c.applyTranscript(agent.ID, state, lines)
	}
}

// follow reads what is new in a session's transcript, off the hook's path so it never delays Claude
// Code. A read already going reads again when it ends.
func (c *Connector) follow(agentID, raw string) {
	path, ok := c.transcriptFile(raw)
	if !ok {
		return
	}
	var heard *int64
	_ = c.engine.Do(func() {
		if agent := c.engine.Agent(agentID); agent != nil && agent.Session != nil {
			heard = agent.Session.TranscriptEnd
		}
	})
	c.mu.Lock()
	state := c.tails[agentID]
	if state == nil || state.path != path {
		state = &tail{path: path, tools: map[string]models.ConversationItem{}}
		if heard != nil {
			state.offset, state.ownStart = *heard, true
		}
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
	// A transcript cleaned up and written again starts over, except that what Mabari's process wrote
	// is never read: all that's known of a shorter file is that nothing has been added to it.
	if info.Size() < state.offset {
		state.offset = 0
		if state.ownStart {
			state.offset = info.Size()
		}
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
