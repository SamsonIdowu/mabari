// SPDX-License-Identifier: Apache-2.0

// Package server is Mabari's HTTP API, WebSocket and web app host.
package server

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net/http"

	"github.com/SamsonIdowu/mabari/internal/connectors/codex"
	"github.com/SamsonIdowu/mabari/internal/connectors/hub"
	"github.com/SamsonIdowu/mabari/internal/connectors/simulator"
	"github.com/SamsonIdowu/mabari/internal/dispatch"
	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/secrets"
)

const maxBodyBytes = 1 << 20

// Options configures the server.
type Options struct {
	Version   string
	Engine    *events.Engine
	Simulator *simulator.Simulator
	// WebFiles is the built web app, or nil in development, where Vite serves it instead.
	WebFiles fs.FS
	// Claude connects Claude Code sessions, or is nil.
	Claude *ClaudeOptions
	// Secrets holds API keys and the hub token. With nil, those routes aren't served.
	Secrets secrets.Store
	// Hub takes reports from people's own apps. It needs Secrets.
	Hub *hub.Connector
	// Codex runs agents as Codex threads, or is nil.
	Codex *codex.Connector
}

type api struct {
	engine    *events.Engine
	simulator *simulator.Simulator
	router    dispatch.Router
	claude    *ClaudeOptions
	secrets   secrets.Store
	hub       *hub.Connector
	codex     *codex.Connector
}

// New builds the handler. It is separate from listening so tests can drive it directly.
func New(options Options) http.Handler {
	a := &api{
		engine: options.Engine, simulator: options.Simulator, router: dispatch.Rules{},
		claude: options.Claude, secrets: options.Secrets, hub: options.Hub, codex: options.Codex,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": options.Version})
	})
	a.routes(mux)
	if a.claude != nil {
		a.claudeRoutes(mux)
	}
	if a.codex != nil {
		a.codexRoutes(mux)
	}
	if a.secrets != nil {
		a.keyRoutes(mux)
		if a.hub != nil {
			a.hubRoutes(mux)
		}
	}
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "not found")
	})
	if options.WebFiles != nil {
		mux.Handle("/", http.FileServerFS(options.WebFiles))
	}
	return localOnly(mux)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		slog.Warn("could not write response", "error", err)
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

// readJSON decodes a size-limited body, refusing fields the route doesn't know.
func readJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "request is too large")
			return false
		}
		if errors.Is(err, io.EOF) {
			writeError(w, http.StatusBadRequest, "request body is empty")
			return false
		}
		writeError(w, http.StatusBadRequest, "request body is not valid")
		return false
	}
	return true
}

// internalError logs the cause and tells the client nothing about it.
func internalError(w http.ResponseWriter, err error) {
	slog.Error("request failed", "error", err)
	writeError(w, http.StatusInternalServerError, "something went wrong")
}
