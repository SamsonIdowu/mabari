// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"encoding/json"
	"path/filepath"
)

// A file the person attaches is kept in Mabari's data folder, outside the session's own, so reading
// it would stop for a click. The person chose to hand it to this agent, so that one read needs none.
//
// --add-dir doesn't do it: it only applies when a process starts, while a message can reach a
// process already running, and it gives a whole working directory, editing included. Instead,
// Mabari's PreToolUse hook answers "allow", which Claude Code 2.1.318 documents as skipping the
// permission prompt. Only the Read tool, only the exact path Mabari gave this agent, and only while
// that path still lands on the file it was: everything else goes on to the usual rules.

// AllowAttached lets the agent's session read these files, which the person attached to a message
// for it, with no click. It is only remembered while Mabari runs: after a restart a read asks.
func (c *Connector) AllowAttached(agentID string, paths []string) {
	for _, path := range paths {
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil {
			continue
		}
		c.mu.Lock()
		if c.attached[agentID] == nil {
			c.attached[agentID] = map[string]string{}
		}
		c.attached[agentID][path] = resolved
		c.mu.Unlock()
	}
}

// attachedRead is the hook's answer to this session reading a file attached for it, or nil for
// anything else. Call inside Do.
func (c *Connector) attachedRead(in input) []byte {
	if in.ToolName != "Read" {
		return nil
	}
	var args toolInput
	if json.Unmarshal(in.ToolInput, &args) != nil || args.FilePath == "" {
		return nil
	}
	id := c.idOf(in.SessionID)
	if agent := c.engine.Agent(id); agent == nil || !agent.RunsHere() {
		return nil
	}
	c.mu.Lock()
	resolved, known := c.attached[id][args.FilePath]
	c.mu.Unlock()
	if !known {
		return nil
	}
	if now, err := filepath.EvalSymlinks(args.FilePath); err != nil || now != resolved {
		return nil
	}
	return mustJSON(map[string]any{"hookSpecificOutput": map[string]any{
		"hookEventName": "PreToolUse", "permissionDecision": "allow",
		"permissionDecisionReason": "The person attached this file for this session.",
	}})
}
