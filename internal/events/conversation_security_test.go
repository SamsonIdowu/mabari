// SPDX-License-Identifier: Apache-2.0

package events_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
)

// A tool's input is JSON, where a secret's key and value are separated by quotes, so text patterns
// written for "Authorization: x" never see it.
func TestConverseMasksSecretsInStructuredToolData(t *testing.T) {
	cases := []struct {
		name, data, secret string
	}{
		{"authorization", `{"headers":{"Authorization":"plainvalue123"}}`, "plainvalue123"},
		{"lower case authorization", `{"authorization":"plainvalue123"}`, "plainvalue123"},
		{"cookie", `{"Cookie":"session=plainvalue123"}`, "plainvalue123"},
		{"set-cookie", `{"response":{"Set-Cookie":"sid=plainvalue123; Path=/"}}`, "plainvalue123"},
		{"nested in an array", `{"calls":[{"auth":{"password":"plainvalue123"}}]}`, "plainvalue123"},
		{"deeply nested", `{"a":{"b":[{"c":{"api_key":"plainvalue123"}}]}}`, "plainvalue123"},
		{"escaped quotes in a value", `{"note":"password=\"plainvalue123\" and more"}`, "plainvalue123"},
		{"escaped quotes in a secret", `{"password":"plain\"value123"}`, `value123`},
		{"a number as a secret", `{"password":1234567890}`, "1234567890"},
		{"JSON inside a string", `{"body":"{\"authorization\":\"plainvalue123\"}"}`, "plainvalue123"},
		{"JSON inside JSON inside a string", `{"body":"{\"inner\":\"{\\\"cookie\\\":\\\"plainvalue123\\\"}\"}"}`, "plainvalue123"},
		{"a secret as a key", `{"sk-ant-abcdefghijklmnop1234":true}`, "sk-ant-abcdefghijklmnop1234"},
		{"text that only looks like JSON", `{"authorization": broken password=plainvalue123`, "plainvalue123"},
		{"JSON with more after it", `{"a":1} password=plainvalue123`, "plainvalue123"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			engine := conversationEngine(t)
			var item models.ConversationItem
			_ = engine.Do(func() {
				item = engine.Converse("a1", models.ConversationItem{
					Kind: models.ConversationTool,
					Tool: &models.ToolCall{Name: "mcp__x__call", Input: test.data, Output: test.data, State: models.ToolDone},
				})
			})
			if strings.Contains(item.Tool.Input, test.secret) {
				t.Errorf("input kept the secret: %s", item.Tool.Input)
			}
			if strings.Contains(item.Tool.Output, test.secret) {
				t.Errorf("output kept the secret: %s", item.Tool.Output)
			}
			// What was stored and sent is the masked copy, not only what came back.
			items, _, err := engine.Store().Conversation(context.Background(), "a1", 0, 1)
			if err != nil || len(items) != 1 {
				t.Fatalf("stored: %v, %v", items, err)
			}
			if strings.Contains(items[0].Tool.Input, test.secret) {
				t.Errorf("the database kept the secret: %s", items[0].Tool.Input)
			}
		})
	}
}

// Nothing to hide leaves the data exactly as it came, so what the person reads is what ran.
func TestConverseLeavesHarmlessToolDataAlone(t *testing.T) {
	for _, data := range []string{
		`{"command": "ls -la && echo <done>", "timeout": 120000}`,
		`{"id":12345678901234567890}`,
		"{\n  \"pretty\": [1, 2]\n}",
		`not json at all`,
		`[1, 2, 3]`,
	} {
		engine := conversationEngine(t)
		var item models.ConversationItem
		_ = engine.Do(func() {
			item = engine.Converse("a1", models.ConversationItem{
				Kind: models.ConversationTool,
				Tool: &models.ToolCall{Input: data, Output: data},
			})
		})
		if item.Tool.Input != data || item.Tool.Output != data {
			t.Errorf("changed %q to %q and %q", data, item.Tool.Input, item.Tool.Output)
		}
	}
}

// Masking keeps the input usable: it stays JSON, and what isn't secret stays readable.
func TestConverseKeepsMaskedToolInputAsJSON(t *testing.T) {
	engine := conversationEngine(t)
	var item models.ConversationItem
	_ = engine.Do(func() {
		item = engine.Converse("a1", models.ConversationItem{
			Kind: models.ConversationTool,
			Tool: &models.ToolCall{Input: `{"url":"https://example.com/?a=1&b=<2>","Authorization":"plainvalue123","count":3}`},
		})
	})
	var decoded map[string]any
	if err := json.Unmarshal([]byte(item.Tool.Input), &decoded); err != nil {
		t.Fatalf("no longer JSON: %v: %s", err, item.Tool.Input)
	}
	if decoded["url"] != "https://example.com/?a=1&b=<2>" || decoded["count"] != float64(3) {
		t.Fatalf("lost what isn't secret: %s", item.Tool.Input)
	}
	if !strings.Contains(item.Tool.Input, "&b=<2>") {
		t.Fatalf("escaped for HTML, which nobody asked for: %s", item.Tool.Input)
	}
}

// replayed is everything a joining client is sent, as text.
func replayed(t *testing.T, joined events.Joined) string {
	t.Helper()
	data, err := json.Marshal(joined.Replay)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// A page that was away during a wipe resumes from its old number. It must reload, and must not be
// handed what the wipe deleted.
func TestResumingFromBeforeAWipeReplaysNothingDeleted(t *testing.T) {
	for name, clear := range map[string]func(*events.Engine){
		"wipe":         func(engine *events.Engine) { engine.Wipe() },
		"clear office": func(engine *events.Engine) { engine.ClearOffice() },
	} {
		t.Run(name, func(t *testing.T) {
			engine := conversationEngine(t)
			before := engine.Subscribe(events.Resume{})
			engine.Unsubscribe(before.Sub)
			const text = "the private conversation"
			_ = engine.Do(func() {
				engine.Converse("a1", models.ConversationItem{Kind: models.ConversationAssistant, Text: text})
				engine.ConverseDelta("a1", "item", text)
			})
			// Sanity: before the wipe this resume does replay it, so the check below can fail.
			early := engine.Subscribe(events.Resume{BootID: before.BootID, Seq: before.Seq})
			engine.Unsubscribe(early.Sub)
			if !strings.Contains(replayed(t, early), text) {
				t.Fatal("the test proves nothing: the text wasn't in the replay to begin with")
			}
			last := engine.Snapshot().Seq
			_ = engine.Do(func() { clear(engine) })
			for from, seq := range map[string]uint64{"far behind": before.Seq, "up to date": last} {
				joined := engine.Subscribe(events.Resume{BootID: before.BootID, Seq: seq})
				engine.Unsubscribe(joined.Sub)
				if strings.Contains(replayed(t, joined), text) {
					t.Errorf("%s: replayed deleted text: %s", from, replayed(t, joined))
				}
				if !joined.Resync {
					t.Errorf("%s: told to resume, not to reload", from)
				}
			}
		})
	}
}

// A page that is connected through a wipe still hears about it, and resumes as normal afterwards.
func TestAPageConnectedThroughAWipeIsToldAndCarriesOn(t *testing.T) {
	engine := conversationEngine(t)
	joined := engine.Subscribe(events.Resume{})
	defer engine.Unsubscribe(joined.Sub)
	_ = engine.Do(engine.Wipe)
	if message := <-joined.Sub.C; message.Type != models.MsgReset {
		t.Fatalf("a connected page got %+v", message)
	}
	office := engine.Snapshot()
	_ = engine.Do(func() { engine.Toast("hello") })
	resumed := engine.Subscribe(events.Resume{BootID: office.BootID, Seq: office.Seq})
	defer engine.Unsubscribe(resumed.Sub)
	if resumed.Resync || len(resumed.Replay) != 1 || resumed.Replay[0].Text != "hello" {
		t.Fatalf("resuming from the new snapshot: resync %v, replay %+v", resumed.Resync, resumed.Replay)
	}
}

// Ending the demo clears the office and puts real agents back. Their conversations stay with them,
// and the demo's go.
func TestClearingTheOfficeKeepsConversationsOfAgentsThatStay(t *testing.T) {
	engine := conversationEngine(t)
	_ = engine.Do(func() {
		engine.Converse("real", models.ConversationItem{Kind: models.ConversationUser, Text: "keep me"})
		engine.Converse("demo", models.ConversationItem{Kind: models.ConversationUser, Text: "forget me"})
		engine.ClearOffice("real")
	})
	ctx := context.Background()
	kept, _, err := engine.Store().Conversation(ctx, "real", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(kept) != 1 || kept[0].Text != "keep me" {
		t.Fatalf("the real agent's conversation: %+v", kept)
	}
	gone, _, err := engine.Store().Conversation(ctx, "demo", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(gone) != 0 {
		t.Fatalf("the demo's conversation stayed: %+v", gone)
	}
	var next models.ConversationItem
	_ = engine.Do(func() {
		next = engine.Converse("real", models.ConversationItem{Kind: models.ConversationUser, Text: "and again"})
	})
	if next.Seq != 2 {
		t.Fatalf("the kept conversation started over at %d", next.Seq)
	}
}
