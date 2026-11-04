// SPDX-License-Identifier: Apache-2.0

// Package server is Mabari's HTTP API and web app host.
package server

import (
	"encoding/json"
	"io/fs"
	"log/slog"
	"net/http"
)

// New builds the handler. It is separate from listening so tests can drive it directly. webFiles
// is the built web app, or nil in development, where Vite serves it instead.
func New(version string, webFiles fs.FS) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": version})
	})
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	})
	if webFiles != nil {
		mux.Handle("/", http.FileServerFS(webFiles))
	}
	return mux
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		slog.Warn("could not write response", "error", err)
	}
}
