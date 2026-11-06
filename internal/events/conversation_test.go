// SPDX-License-Identifier: Apache-2.0

package events_test

import (
	"context"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

func conversationEngine(t *testing.T) *events.Engine {
	t.Helper()
	database, err := store.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	engine, err := events.New(context.Background(), database, nil)
	if err != nil {
		t.Fatal(err)
	}
	return engine
}

func TestConverseNumbersItemsAndReplacesByID(t *testing.T) {
	engine := conversationEngine(t)
	var first, again, second models.ConversationItem
	_ = engine.Do(func() {
		first = engine.Converse("a1", models.ConversationItem{ID: "x", Kind: models.ConversationAssistant, Text: "one"})
		second = engine.Converse("a1", models.ConversationItem{ID: "y", Kind: models.ConversationAssistant, Text: "two"})
		again = engine.Converse("a1", models.ConversationItem{ID: "x", Kind: models.ConversationAssistant, Text: "one, finished"})
	})
	if first.Seq != 1 || second.Seq != 2 || again.Seq != 1 {
		t.Fatalf("numbers: first %d, second %d, replaced %d", first.Seq, second.Seq, again.Seq)
	}
	items, more, err := engine.Store().Conversation(context.Background(), "a1", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if more || len(items) != 2 || items[0].Text != "one, finished" || items[1].Text != "two" {
		t.Fatalf("stored: %+v, more %v", items, more)
	}
}

// Another agent's numbers don't depend on this one's, and a restart carries on from the store.
func TestConversationNumbersSurviveARestart(t *testing.T) {
	ctx := context.Background()
	database, err := store.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = database.Close() }()
	engine, err := events.New(ctx, database, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = engine.Do(func() {
		engine.Converse("a1", models.ConversationItem{Kind: models.ConversationUser, Text: "one"})
		engine.Converse("a1", models.ConversationItem{Kind: models.ConversationUser, Text: "two"})
	})
	restarted, err := events.New(ctx, database, nil)
	if err != nil {
		t.Fatal(err)
	}
	var next, other models.ConversationItem
	_ = restarted.Do(func() {
		next = restarted.Converse("a1", models.ConversationItem{Kind: models.ConversationUser, Text: "three"})
		other = restarted.Converse("a2", models.ConversationItem{Kind: models.ConversationUser, Text: "first"})
	})
	if next.Seq != 3 || other.Seq != 1 {
		t.Fatalf("numbers after a restart: a1 %d, a2 %d", next.Seq, other.Seq)
	}
}

// Whatever a connector hands over, nothing that looks like a secret reaches the database.
func TestConverseMasksSecretsAndCutsLongText(t *testing.T) {
	engine := conversationEngine(t)
	secret := "sk-ant-abcdefghijklmnop1234"
	long := strings.Repeat("é", models.ConversationTextLimit+10)
	var told, cut models.ConversationItem
	_ = engine.Do(func() {
		told = engine.Converse("a1", models.ConversationItem{
			Kind: models.ConversationTool, Text: "key " + secret,
			Tool: &models.ToolCall{Name: "Bash", Summary: "echo " + secret, Input: secret, Output: "got " + secret, State: models.ToolDone},
		})
		cut = engine.Converse("a1", models.ConversationItem{
			Kind: models.ConversationTool, Text: long,
			Tool: &models.ToolCall{Output: strings.Repeat("x", models.ConversationToolLimit+1)},
		})
	})
	for _, text := range []string{told.Text, told.Tool.Summary, told.Tool.Input, told.Tool.Output} {
		if strings.Contains(text, secret) {
			t.Fatalf("a secret got through: %q", text)
		}
	}
	if told.Clipped {
		t.Fatal("short text was marked as cut")
	}
	if !cut.Clipped || len([]rune(cut.Text)) != models.ConversationTextLimit || len(cut.Tool.Output) != models.ConversationToolLimit {
		t.Fatalf("not cut to the limits: %v, %d, %d", cut.Clipped, len([]rune(cut.Text)), len(cut.Tool.Output))
	}
}

func TestConversationPagesBackFromTheNewest(t *testing.T) {
	engine := conversationEngine(t)
	_ = engine.Do(func() {
		for range 5 {
			engine.Converse("a1", models.ConversationItem{Kind: models.ConversationAssistant, Text: "x"})
		}
	})
	ctx := context.Background()
	newest, more, err := engine.Store().Conversation(ctx, "a1", 0, 2)
	if err != nil {
		t.Fatal(err)
	}
	if !more || len(newest) != 2 || newest[0].Seq != 4 || newest[1].Seq != 5 {
		t.Fatalf("newest page: %+v, more %v", newest, more)
	}
	oldest, more, err := engine.Store().Conversation(ctx, "a1", newest[0].Seq, 10)
	if err != nil {
		t.Fatal(err)
	}
	if more || len(oldest) != 3 || oldest[0].Seq != 1 || oldest[2].Seq != 3 {
		t.Fatalf("older page: %+v, more %v", oldest, more)
	}
}

// A wipe leaves no conversation behind.
func TestWipeClearsConversations(t *testing.T) {
	engine := conversationEngine(t)
	_ = engine.Do(func() {
		engine.Converse("a1", models.ConversationItem{Kind: models.ConversationUser, Text: "x"})
		engine.Wipe()
	})
	items, _, err := engine.Store().Conversation(context.Background(), "a1", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("a wipe left %d items", len(items))
	}
	var next models.ConversationItem
	_ = engine.Do(func() {
		next = engine.Converse("a1", models.ConversationItem{Kind: models.ConversationUser, Text: "y"})
	})
	if next.Seq != 1 {
		t.Fatalf("numbers carried over a wipe: %d", next.Seq)
	}
}

// Retention removes old conversation too: the person said how long Mabari may keep things.
func TestRetentionRemovesOldConversation(t *testing.T) {
	engine := conversationEngine(t)
	_ = engine.Do(func() {
		engine.Converse("a1", models.ConversationItem{Kind: models.ConversationUser, Text: "old", Time: 1000})
		engine.Converse("a1", models.ConversationItem{Kind: models.ConversationUser, Text: "new"})
	})
	if err := engine.RunRetention(context.Background()); err != nil {
		t.Fatal(err)
	}
	items, _, err := engine.Store().Conversation(context.Background(), "a1", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Text != "new" {
		t.Fatalf("after retention: %+v", items)
	}
}

func TestConversationDeltaIsBroadcastNotStored(t *testing.T) {
	engine := conversationEngine(t)
	joined := engine.Subscribe(events.Resume{})
	defer engine.Unsubscribe(joined.Sub)
	_ = engine.Do(func() { engine.ConverseDelta("a1", "item", "hel") })
	message := <-joined.Sub.C
	if message.Type != models.MsgConversationDelta || message.AgentID != "a1" || message.ID != "item" || message.Text != "hel" {
		t.Fatalf("delta: %+v", message)
	}
	items, _, _ := engine.Store().Conversation(context.Background(), "a1", 0, 10)
	if len(items) != 0 {
		t.Fatalf("a delta was stored: %+v", items)
	}
}
