// SPDX-License-Identifier: Apache-2.0

package events

import "github.com/SamsonIdowu/mabari/internal/models"

// clientBuffer is how many messages a client can fall behind before it is told to resync.
const clientBuffer = 1024

// Subscription is one client's feed of changes. C closes if the client falls too far behind.
type Subscription struct {
	C chan models.ServerMessage
}

// Resume says where a reconnecting client got to. Leave it zero for a new client.
type Resume struct {
	BootID string
	Seq    uint64
}

// Joined is what a client needs to start listening.
type Joined struct {
	BootID string
	Seq    uint64
	// Replay is what the client missed, oldest first.
	Replay []models.ServerMessage
	// Resync means the client can't catch up from Replay and must reload the snapshot.
	Resync bool
	Sub    *Subscription
}

// Subscribe starts a feed. Nothing can slip between the replay and the live messages, because
// both are read while broadcasting is held off.
func (e *Engine) Subscribe(resume Resume) Joined {
	e.mu.Lock()
	defer e.mu.Unlock()
	sub := &Subscription{C: make(chan models.ServerMessage, clientBuffer)}
	e.subs[sub] = struct{}{}
	joined := Joined{BootID: e.bootID, Seq: e.seq, Sub: sub}
	if resume.BootID == "" {
		return joined
	}
	if resume.BootID != e.bootID || resume.Seq > e.seq {
		joined.Resync = true
		return joined
	}
	oldest := e.seq + 1
	if len(e.history) > 0 {
		oldest = e.history[0].Seq
	}
	if resume.Seq+1 < oldest {
		joined.Resync = true
		return joined
	}
	for _, message := range e.history {
		if message.Seq > resume.Seq {
			joined.Replay = append(joined.Replay, message)
		}
	}
	return joined
}

// Unsubscribe ends a feed.
func (e *Engine) Unsubscribe(sub *Subscription) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, ok := e.subs[sub]; ok {
		delete(e.subs, sub)
		close(sub.C)
	}
}

// broadcast numbers a message and sends it to every client. A client that can't keep up is
// dropped rather than slowing the office down; it reconnects and resumes.
func (e *Engine) broadcast(message models.ServerMessage) {
	e.seq++
	message.Seq = e.seq
	e.history = append(e.history, message)
	if len(e.history) > historySize {
		e.history = e.history[len(e.history)-historySize:]
	}
	for sub := range e.subs {
		select {
		case sub.C <- message:
		default:
			delete(e.subs, sub)
			close(sub.C)
		}
	}
}

// HasViewers reports whether any page is open on Mabari. With none, nobody could answer an
// approval, so a real agent falls back to its own prompt at once. Call inside Do.
func (e *Engine) HasViewers() bool { return len(e.subs) > 0 }
