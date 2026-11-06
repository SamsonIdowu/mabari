// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"bufio"
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// Lines in the shapes the Agent SDK's reference documents for SDKMessage, as of Claude Code 2.1.318.
const (
	documentedInit = `{"type":"system","subtype":"init","uuid":"1","session_id":"s","cwd":"/x","tools":["Bash"],` +
		`"mcp_servers":[],"model":"claude-sonnet-4-5[1m]","permissionMode":"default","slash_commands":[],` +
		`"apiKeySource":"none","claude_code_version":"2.1.318","output_style":"default","skills":[],"plugins":[]}`
	documentedAssistant = `{"type":"assistant","uuid":"2","session_id":"s","parent_tool_use_id":null,"message":{"id":"msg_1",` +
		`"type":"message","role":"assistant","content":[{"type":"text","text":"Hi"},{"type":"thinking","thinking":"hm"},` +
		`{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]}}`
	documentedResult = `{"type":"result","subtype":"success","uuid":"3","session_id":"s","duration_ms":1,"duration_api_ms":1,` +
		`"is_error":false,"num_turns":1,"result":"Hi","stop_reason":"end_turn","total_cost_usd":0.25,` +
		`"usage":{"input_tokens":10,"output_tokens":2},"modelUsage":{},` +
		`"permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_1","tool_input":{}}]}`
	documentedDelta = `{"type":"stream_event","uuid":"4","session_id":"s","parent_tool_use_id":null,"event":` +
		`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}}`
	documentedError = `{"type":"result","subtype":"error_max_budget_usd","uuid":"5","session_id":"s","is_error":true,` +
		`"errors":["Reached the budget"],"total_cost_usd":5,"usage":{"input_tokens":1,"output_tokens":1},"permission_denials":[]}`
)

func parsed(t *testing.T, raw string) streamLine {
	t.Helper()
	var line streamLine
	if err := json.Unmarshal([]byte(raw), &line); err != nil {
		t.Fatal(err)
	}
	return line
}

func TestDocumentedLinesAreRead(t *testing.T) {
	init := parsed(t, documentedInit)
	if init.Subtype != "init" || init.PermissionMode != "default" || init.Model == "" {
		t.Fatalf("init = %+v", init)
	}
	blocks := parsed(t, documentedAssistant).message().blocks()
	if len(blocks) != 3 || blocks[0].Text != "Hi" || blocks[2].Name != "Bash" || blocks[2].ID != "toolu_1" {
		t.Fatalf("blocks = %+v", blocks)
	}
	result := parsed(t, documentedResult)
	if result.TotalCost != 0.25 || result.Usage.OutputTokens != 2 || result.PermissionDenials[0].ToolUseID != "toolu_1" {
		t.Fatalf("result = %+v", result)
	}
	delta := parsed(t, documentedDelta)
	if delta.Event == nil || delta.Event.Delta.Text != "Hi" || delta.Event.Delta.Type != "text_delta" {
		t.Fatalf("delta = %+v", delta)
	}
	if said := resultError(parsed(t, documentedError)); said != "Reached the budget" {
		t.Fatalf("error = %q", said)
	}
}

// A "system" message may use the same key for plain text, which isn't a message at all.
func TestAMessageInAnotherShapeIsHarmless(t *testing.T) {
	line := parsed(t, `{"type":"system","subtype":"permission_denied","tool_use_id":"x","message":"no"}`)
	if blocks := line.message().blocks(); blocks != nil {
		t.Fatalf("blocks = %+v", blocks)
	}
}

func TestContentCanBeAStringOrBlocks(t *testing.T) {
	plain := apiMessage{Content: json.RawMessage(`"hello"`)}
	if blocks := plain.blocks(); len(blocks) != 1 || blocks[0].Text != "hello" {
		t.Fatalf("blocks = %+v", blocks)
	}
	if got := toolOutput(json.RawMessage(`"plain"`)); got != "plain" {
		t.Fatalf("output = %q", got)
	}
	if got := toolOutput(json.RawMessage(`[{"type":"text","text":"a"},{"type":"image"},{"type":"text","text":"b"}]`)); got != "a\nb" {
		t.Fatalf("output = %q", got)
	}
}

func TestToolStatesFromResults(t *testing.T) {
	item := toolItem(contentBlock{ID: "t", Name: "Read", Input: json.RawMessage(`{"file_path":"a.ts"}`)}, "")
	if item.Tool.State != models.ToolRunning || item.Tool.Summary != "Read a.ts" {
		t.Fatalf("tool = %+v", item.Tool)
	}
	for name, test := range map[string]struct {
		block  contentBlock
		denied bool
		want   models.ToolCallState
	}{
		"done":   {contentBlock{}, false, models.ToolDone},
		"failed": {contentBlock{IsError: true}, false, models.ToolFailed},
		"denied": {contentBlock{IsError: true}, true, models.ToolDenied},
	} {
		if got := withResult(item, test.block, test.denied).Tool.State; got != test.want {
			t.Errorf("%s: %s", name, got)
		}
	}
}

func TestALineTooLongIsSkippedNotKept(t *testing.T) {
	reader := bufio.NewReaderSize(strings.NewReader(strings.Repeat("x", 500)+"\nshort\n"), 16)
	line, skipped, err := readLine(reader, 100)
	if err != nil || !skipped || len(line) != 0 {
		t.Fatalf("line %d, skipped %v, err %v", len(line), skipped, err)
	}
	line, skipped, err = readLine(reader, 100)
	if err != nil || skipped || !bytes.Equal(line, []byte("short\n")) {
		t.Fatalf("line %q, skipped %v, err %v", line, skipped, err)
	}
}

func TestStopAndPermissionHooksAreTheOnlyOnesThatGate(t *testing.T) {
	for event, gates := range map[string]bool{
		"PreToolUse": true, "PermissionRequest": true, "Stop": false, "UserPromptSubmit": false,
	} {
		if Gates(event) != gates {
			t.Errorf("%s: %v", event, !gates)
		}
	}
}

// Unlike the hook in settings.json, this one says when it couldn't reach Mabari.
func TestASessionHookReportsWhenMabariIsDown(t *testing.T) {
	var out bytes.Buffer
	token := func() (string, error) { return "secret", nil }
	if RunSessionHook("PermissionRequest", 1, strings.NewReader(`{"session_id":"x"}`), &out, token) {
		t.Fatal("reported an answer from nothing")
	}
	if out.Len() != 0 {
		t.Fatalf("printed %q", out.String())
	}
}
