// SPDX-License-Identifier: Apache-2.0

package server

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/whisper"
)

type modelServer []byte

func (m modelServer) RoundTrip(r *http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(string(m))), Request: r}, nil
}

// voiceOffice serves Mabari with a Whisper whose whisper-cli is a script that prints its
// language, so no real model or microphone is needed.
func voiceOffice(t *testing.T, installed bool) (*office, *whisper.Whisper) {
	t.Helper()
	weights := modelServer("weights")
	sum := sha256.Sum256(weights)
	w := whisper.New(t.TempDir(), whisper.Model{
		Name: "m.bin", URL: "https://example.test/m.bin", SHA256: hex.EncodeToString(sum[:]), Bytes: int64(len(weights)),
	})
	w.SetClient(&http.Client{Transport: weights})
	script := filepath.Join(t.TempDir(), "whisper-cli")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf ' Ask Scout\\n how it is going [BLANK_AUDIO]\\n'\n"), 0o700); err != nil { // #nosec G306
		t.Fatal(err)
	}
	w.Find = func() string {
		if installed {
			return script
		}
		return ""
	}
	o := newOffice(t)
	o.handler = New(Options{Version: "1.2.3", Engine: o.engine, Simulator: o.simulator, Whisper: w})
	return o, w
}

func recording() string {
	return "RIFF\x00\x00\x00\x00WAVEfmt " + strings.Repeat("\x00", 64)
}

func TestWhisperNeedsSettingUp(t *testing.T) {
	o, _ := voiceOffice(t, false)
	status := decode[whisper.Status](t, o.do(t, http.MethodGet, "/api/voice/whisper", ""))
	if status.Installed || status.Ready || status.Total != 7 {
		t.Fatalf("status = %+v", status)
	}
	response := o.do(t, http.MethodPost, "/api/voice/transcribe?lang=en-GB", recording())
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "isn't installed") {
		t.Fatalf("transcribe = %d %s", response.Code, response.Body)
	}
}

func TestWhisperDownloadsThenTranscribes(t *testing.T) {
	o, w := voiceOffice(t, true)
	if response := o.do(t, http.MethodPost, "/api/voice/transcribe", recording()); response.Code != http.StatusConflict ||
		!strings.Contains(response.Body.String(), "Download it in Settings") {
		t.Fatalf("before download = %d %s", response.Code, response.Body)
	}
	if response := o.do(t, http.MethodPost, "/api/voice/whisper/model", ""); response.Code != http.StatusAccepted {
		t.Fatalf("download = %d", response.Code)
	}
	deadline := time.Now().Add(5 * time.Second)
	for !w.Status().Ready && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	response := o.do(t, http.MethodPost, "/api/voice/transcribe?lang=en-GB", recording())
	if body := decode[map[string]string](t, response); response.Code != http.StatusOK || body["text"] != "Ask Scout how it is going" {
		t.Fatalf("transcribe = %d %v", response.Code, body)
	}
	if response := o.do(t, http.MethodPost, "/api/voice/transcribe", "just words, not audio at all, really not................................"); response.Code != http.StatusBadRequest {
		t.Errorf("non WAV = %d", response.Code)
	}
	if response := o.do(t, http.MethodDelete, "/api/voice/whisper/model", ""); response.Code != http.StatusOK ||
		decode[whisper.Status](t, response).Ready {
		t.Errorf("remove = %d %s", response.Code, response.Body)
	}
}

func TestTranscribeRefusesHugeRecordings(t *testing.T) {
	o, _ := voiceOffice(t, true)
	huge := strings.Repeat("x", whisper.MaxAudioBytes+1)
	if response := o.do(t, http.MethodPost, "/api/voice/transcribe", huge); response.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("huge = %d", response.Code)
	}
}

// Another website can't make Mabari download 1.5 GB or listen to a recording it sends.
func TestVoiceRoutesRefuseOtherSites(t *testing.T) {
	o, w := voiceOffice(t, true)
	for _, path := range []string{"/api/voice/whisper/model", "/api/voice/transcribe"} {
		request := httptest.NewRequest(http.MethodPost, "http://localhost:4317"+path, strings.NewReader(recording()))
		request.Header.Set("Origin", "https://evil.example")
		recorder := httptest.NewRecorder()
		o.handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusForbidden {
			t.Errorf("%s = %d", path, recorder.Code)
		}
	}
	if w.Status().Downloading || w.Status().Ready {
		t.Error("a download started")
	}
}
