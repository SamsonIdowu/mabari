// SPDX-License-Identifier: Apache-2.0

package events

import (
	"context"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/store"
)

// A page that stops reading is dropped, so it can never slow the office down, while a page that
// keeps up gets every message. The dropped page reconnects and resumes from its last number.
func TestASlowPageIsDroppedNotWaitedFor(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	engine, err := New(ctx, s, nil)
	if err != nil {
		t.Fatal(err)
	}
	slow := engine.Subscribe(Resume{}).Sub
	fast := engine.Subscribe(Resume{}).Sub
	// The page reads between sends, so it keeps up however the machine schedules things. A reader on
	// its own goroutine may not run at all during the burst, and is then rightly dropped too.
	got := 0
	total := clientBuffer + 10
	for range total {
		if err := engine.Do(func() { engine.Toast("hello") }); err != nil {
			t.Fatal(err)
		}
		select {
		case _, open := <-fast.C:
			if !open {
				t.Fatalf("the page that kept up was dropped after %d messages", got)
			}
			got++
		default:
			t.Fatalf("the page that kept up has nothing to read after %d messages", got)
		}
	}
	if !closedAfterDraining(slow) {
		t.Error("the slow page is still subscribed")
	}
	engine.Unsubscribe(fast)
	for range fast.C {
		got++
	}
	if got != total {
		t.Errorf("the page that kept up got %d of %d", got, total)
	}
	// Resuming from before the drop replays what it missed, or asks for a fresh snapshot.
	joined := engine.Subscribe(Resume{BootID: engine.Snapshot().BootID, Seq: uint64(clientBuffer)})
	if !joined.Resync && len(joined.Replay) == 0 {
		t.Error("resuming got nothing")
	}
}

// closedAfterDraining reads what is buffered and reports whether the feed was then closed.
func closedAfterDraining(sub *Subscription) bool {
	for {
		select {
		case _, open := <-sub.C:
			if !open {
				return true
			}
		default:
			return false
		}
	}
}
