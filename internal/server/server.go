// SPDX-License-Identifier: Apache-2.0

// Package server is Mabari's HTTP API, WebSocket and web app host.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net/http"

	"github.com/SamsonIdowu/mabari/internal/agentdefs"
	"github.com/SamsonIdowu/mabari/internal/answer"
	"github.com/SamsonIdowu/mabari/internal/connectors/codex"
	"github.com/SamsonIdowu/mabari/internal/connectors/hub"
	"github.com/SamsonIdowu/mabari/internal/connectors/simulator"
	"github.com/SamsonIdowu/mabari/internal/dispatch"
	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/launch"
	"github.com/SamsonIdowu/mabari/internal/secrets"
	"github.com/SamsonIdowu/mabari/internal/whisper"
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
	// Answerer makes the client that writes query answers from a key. Nil uses Claude.
	Answerer func(key string) QueryAnswerer
	// Whisper turns recordings into text on this computer. With nil, those routes aren't served.
	Whisper *whisper.Whisper
	// Access asks for the access key whenever a request might not be the person at this computer.
	// With nil, as in most tests, Mabari answers only under local names and asks for nothing.
	Access *Access
	// AnyHost is true when Mabari listens beyond loopback, as in Docker or with --bind.
	AnyHost bool
	// Defs keeps reusable agents as files. With nil, the builder's routes aren't served.
	Defs *agentdefs.Library
	// Launcher opens Claude Code in a project's folder. With nil, Mabari says how to start it.
	Launcher launch.Launcher
	// Login runs Mabari at login. With nil, Settings shows LoginReason instead.
	Login       LoginService
	LoginReason string
}

type api struct {
	engine      *events.Engine
	simulator   *simulator.Simulator
	router      dispatch.Router
	claude      *ClaudeOptions
	secrets     secrets.Store
	hub         *hub.Connector
	codex       *codex.Connector
	answerer    func(key string) QueryAnswerer
	whisper     *whisper.Whisper
	login       LoginService
	loginReason string
	access      *Access
	anyHost     func() bool
	defs        *agentdefs.Library
	launcher    launch.Launcher
}

// QueryAnswerer writes a query answer from an agent's facts.
type QueryAnswerer interface {
	Answer(ctx context.Context, model, question, facts string) (string, error)
}

// New builds the handler. It is separate from listening so tests can drive it directly.
func New(options Options) http.Handler {
	a := &api{
		engine: options.Engine, simulator: options.Simulator, router: dispatch.Rules{},
		claude: options.Claude, secrets: options.Secrets, hub: options.Hub, codex: options.Codex,
		answerer: options.Answerer, whisper: options.Whisper,
		login: options.Login, loginReason: options.LoginReason, access: options.Access,
		defs: options.Defs, launcher: options.Launcher,
	}
	if a.answerer == nil {
		a.answerer = func(key string) QueryAnswerer { return answer.NewAnthropic(key) }
	}
	a.engine.SetAccountNotes(a.accountNotes)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": options.Version})
	})
	a.routes(mux)
	a.projectStartRoutes(mux)
	a.loginRoutes(mux)
	if a.claude != nil {
		a.claudeRoutes(mux)
		a.sessionRoutes(mux)
	}
	if a.codex != nil {
		a.codexRoutes(mux)
	}
	if a.whisper != nil {
		a.voiceRoutes(mux)
	}
	if a.defs != nil {
		a.defsRoutes(mux)
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
	a.anyHost = func() bool { return false }
	if a.access == nil {
		return localOnly(mux, a.anyHost)
	}
	a.anyHost = func() bool { return options.AnyHost || a.access.lan.Load() }
	a.accessRoutes(mux)
	if err := a.engine.Do(func() { _ = a.access.apply(a.engine.Settings()) }); err != nil {
		slog.Warn("could not read the access settings", "error", err)
	}
	return localOnly(a.access.guard(mux), a.anyHost)
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
