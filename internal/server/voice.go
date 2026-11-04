// SPDX-License-Identifier: Apache-2.0

package server

import (
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/SamsonIdowu/mabari/internal/whisper"
)

// Local Whisper: Settings reads its status and downloads the model with a click, and the voice
// card sends a recording to be turned into text on this computer.
func (a *api) voiceRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/voice/whisper", a.whisperStatus)
	mux.HandleFunc("POST /api/voice/whisper/model", a.downloadWhisper)
	mux.HandleFunc("DELETE /api/voice/whisper/model", a.removeWhisper)
	mux.HandleFunc("POST /api/voice/transcribe", a.transcribe)
}

func (a *api) whisperStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, a.whisper.Status())
}

func (a *api) downloadWhisper(w http.ResponseWriter, _ *http.Request) {
	if err := a.whisper.Download(); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, a.whisper.Status())
}

func (a *api) removeWhisper(w http.ResponseWriter, _ *http.Request) {
	if err := a.whisper.Remove(); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, a.whisper.Status())
}

// transcribe takes a WAV recording as the body and answers {"text": ...}. The language comes
// from the browser, as ?lang=en-GB.
func (a *api) transcribe(w http.ResponseWriter, r *http.Request) {
	audio, err := io.ReadAll(http.MaxBytesReader(w, r.Body, whisper.MaxAudioBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "That recording is too long. Keep it under eight minutes.")
			return
		}
		writeError(w, http.StatusBadRequest, "request body is not valid")
		return
	}
	text, err := a.whisper.Transcribe(r.Context(), audio, r.URL.Query().Get("lang"))
	switch {
	case errors.Is(err, whisper.ErrNoBinary), errors.Is(err, whisper.ErrNoModel):
		writeError(w, http.StatusConflict, "Local Whisper isn't ready: "+err.Error()+".")
	case errors.Is(err, whisper.ErrNotWAV):
		writeError(w, http.StatusBadRequest, err.Error())
	case err != nil:
		slog.Warn("whisper failed", "error", err)
		writeError(w, http.StatusBadGateway, "Local Whisper couldn't turn that into text. Try again.")
	default:
		writeJSON(w, http.StatusOK, map[string]string{"text": text})
	}
}
