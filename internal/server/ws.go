// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/coder/websocket"
)

const writeTimeout = 5 * time.Second

func (a *api) websocket(w http.ResponseWriter, r *http.Request) {
	// localOnly has already checked Host and Origin. This library's own check compares them with
	// each other, which also holds here, so it stays on as a second lock.
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		slog.Debug("websocket upgrade failed", "error", err)
		return
	}
	defer func() { _ = conn.CloseNow() }()

	resume := events.Resume{BootID: r.URL.Query().Get("boot")}
	if since := r.URL.Query().Get("since"); since != "" {
		seq, err := strconv.ParseUint(since, 10, 64)
		if err != nil {
			resume = events.Resume{}
		} else {
			resume.Seq = seq
		}
	}
	joined := a.engine.Subscribe(resume)
	defer a.engine.Unsubscribe(joined.Sub)

	// Clients only listen, so reading just notices when they leave.
	ctx := conn.CloseRead(r.Context())

	hello := models.ServerMessage{Type: models.MsgHello, BootID: joined.BootID, Seq: joined.Seq}
	if !send(ctx, conn, hello) {
		return
	}
	if joined.Resync {
		send(ctx, conn, models.ServerMessage{Type: models.MsgResync})
	}
	for _, message := range joined.Replay {
		if !send(ctx, conn, message) {
			return
		}
	}
	for {
		select {
		case <-ctx.Done():
			return
		case message, open := <-joined.Sub.C:
			if !open {
				// This client fell too far behind. It reconnects and resumes.
				_ = conn.Close(websocket.StatusTryAgainLater, "fell behind")
				return
			}
			if !send(ctx, conn, message) {
				return
			}
		}
	}
}

func send(ctx context.Context, conn *websocket.Conn, message models.ServerMessage) bool {
	data, err := json.Marshal(message)
	if err != nil {
		slog.Error("could not encode message", "error", err)
		return false
	}
	writeCtx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return conn.Write(writeCtx, websocket.MessageText, data) == nil
}
