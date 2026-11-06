// SPDX-License-Identifier: Apache-2.0

package events

import (
	"testing"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// toasts reads what has been broadcast to a client that joined before the work.
func toasts(engine *Engine, work func()) []string {
	joined := engine.Subscribe(Resume{})
	defer engine.Unsubscribe(joined.Sub)
	_ = engine.Do(work)
	var texts []string
	for {
		select {
		case message := <-joined.Sub.C:
			if message.Type == models.MsgToast {
				texts = append(texts, message.Text)
			}
		default:
			return texts
		}
	}
}

// A group action holds back the notices its steps would each show, so the person is told once,
// and notices are back the moment it ends.
func TestQuietlyHoldsBackToastsOnlyWhileItRuns(t *testing.T) {
	engine := newEngine(t)
	got := toasts(engine, func() {
		engine.Toast("before")
		engine.Quietly(func() {
			if !engine.Quiet() {
				t.Error("Quiet is false inside Quietly")
			}
			engine.Toast("one agent's notice")
			// Quiet holds through a Quietly inside another, and ends only with the outer one.
			engine.Quietly(func() { engine.Toast("inner") })
			engine.Toast("another agent's notice")
		})
		if engine.Quiet() {
			t.Error("Quiet is still true after Quietly")
		}
		engine.Toast("after")
	})
	if len(got) != 2 || got[0] != "before" || got[1] != "after" {
		t.Errorf("toasts = %q, want only the ones outside Quietly", got)
	}
}

// A panic in the work must not leave the office quiet for good.
func TestQuietlyEndsWhenItsWorkPanics(t *testing.T) {
	engine := newEngine(t)
	func() {
		defer func() { _ = recover() }()
		_ = engine.Do(func() {
			engine.Quietly(func() { panic("boom") })
		})
	}()
	var quiet bool
	_ = engine.Do(func() { quiet = engine.Quiet() })
	if quiet {
		t.Error("the office stayed quiet after a panic")
	}
}
