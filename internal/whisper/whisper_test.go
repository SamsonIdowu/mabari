// SPDX-License-Identifier: Apache-2.0

package whisper

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// TestMain lets the test binary stand in for whisper-cli, so no real model is needed.
func TestMain(m *testing.M) {
	if mode := os.Getenv("MABARI_FAKE_WHISPER"); mode != "" {
		os.Exit(fakeWhisper(mode, os.Args[1:]))
	}
	os.Exit(m.Run())
}

func fakeWhisper(mode string, args []string) int {
	if mode == "fail" {
		_, _ = fmt.Fprintln(os.Stderr, "loading model\nerror: failed to read WAV file")
		return 1
	}
	at := func(flag string) string {
		if i := slices.Index(args, flag); i >= 0 && i+1 < len(args) {
			return args[i+1]
		}
		return ""
	}
	if !slices.Contains(args, "-nt") || !slices.Contains(args, "-np") {
		return 2
	}
	audio, err := os.ReadFile(at("-f"))
	if err != nil || !strings.HasPrefix(string(audio), "RIFF") {
		return 3
	}
	if mode == "silent" {
		fmt.Println(" [BLANK_AUDIO]")
		return 0
	}
	fmt.Printf(" tell Scout to fix\n the endpoint (%s)\n", at("-l"))
	return 0
}

func wav() []byte {
	header := []byte("RIFF\x00\x00\x00\x00WAVEfmt ")
	return append(header, make([]byte, 64)...)
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func serving(body []byte, status int) *http.Client {
	return &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: status, Status: fmt.Sprint(status),
			Body: io.NopCloser(strings.NewReader(string(body))), Request: r,
		}, nil
	})}
}

func testModel(body []byte) Model {
	sum := sha256.Sum256(body)
	return Model{Name: "model.bin", URL: "https://example.test/model.bin", SHA256: hex.EncodeToString(sum[:]), Bytes: int64(len(body))}
}

func waitIdle(t *testing.T, w *Whisper) Status {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if status := w.Status(); !status.Downloading {
			return status
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("download never finished")
	return Status{}
}

func ready(t *testing.T, mode string) *Whisper {
	t.Helper()
	body := []byte("model weights")
	w := New(t.TempDir(), testModel(body))
	w.SetClient(serving(body, http.StatusOK))
	t.Setenv("MABARI_FAKE_WHISPER", mode)
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	w.Find = func() string { return self }
	if err := w.Download(); err != nil {
		t.Fatal(err)
	}
	if status := waitIdle(t, w); !status.Ready {
		t.Fatalf("not ready: %+v", status)
	}
	return w
}

func TestDownloadChecksTheFile(t *testing.T) {
	body := []byte("model weights")
	for name, tc := range map[string]struct {
		served []byte
		status int
		want   string
	}{
		"good":      {body, http.StatusOK, ""},
		"altered":   {[]byte("model weightz"), http.StatusOK, "checksum"},
		"short":     {body[:5], http.StatusOK, "expected 13 bytes"},
		"too long":  {append(slices.Clone(body), 'x'), http.StatusOK, "expected 13 bytes"},
		"not found": {nil, http.StatusNotFound, "answered 404"},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			w := New(dir, testModel(body))
			w.Find = func() string { return "" }
			w.SetClient(serving(tc.served, tc.status))
			if err := w.Download(); err != nil {
				t.Fatal(err)
			}
			status := waitIdle(t, w)
			if tc.want == "" {
				if !status.Ready || status.Error != "" || status.Done != int64(len(body)) {
					t.Fatalf("status = %+v", status)
				}
			} else if status.Ready || !strings.Contains(status.Error, tc.want) {
				t.Fatalf("status = %+v, want error with %q", status, tc.want)
			}
			// No part file is ever left behind.
			if _, err := os.Stat(filepath.Join(dir, "model.bin.part")); !errors.Is(err, os.ErrNotExist) {
				t.Errorf("part file left: %v", err)
			}
		})
	}
}

func TestRedirectsStayOnHTTPS(t *testing.T) {
	plain, _ := http.NewRequest(http.MethodGet, "http://example.test/x", nil)
	secure, _ := http.NewRequest(http.MethodGet, "https://cdn.example.test/x", nil)
	if httpsOnly(plain, nil) == nil {
		t.Error("followed a redirect to http")
	}
	if err := httpsOnly(secure, nil); err != nil {
		t.Error(err)
	}
}

func TestRemoveDeletesTheModel(t *testing.T) {
	w := ready(t, "speak")
	if err := w.Remove(); err != nil {
		t.Fatal(err)
	}
	if w.Status().Ready {
		t.Error("still ready")
	}
	if err := w.Remove(); err != nil {
		t.Errorf("second remove: %v", err)
	}
}

func TestTranscribe(t *testing.T) {
	w := ready(t, "speak")
	text, err := w.Transcribe(context.Background(), wav(), "en-GB")
	if err != nil || text != "tell Scout to fix the endpoint (en)" {
		t.Fatalf("text = %q, err = %v", text, err)
	}
	if _, err := w.Transcribe(context.Background(), []byte("not audio at all, just some text here....................."), "en"); !errors.Is(err, ErrNotWAV) {
		t.Errorf("non WAV: %v", err)
	}
	// The temporary recording is gone afterwards.
	left, _ := filepath.Glob(filepath.Join(os.TempDir(), "mabari-voice-*.wav"))
	if len(left) != 0 {
		t.Errorf("recordings left: %v", left)
	}
}

func TestSilenceIsNothing(t *testing.T) {
	text, err := ready(t, "silent").Transcribe(context.Background(), wav(), "en")
	if err != nil || text != "" {
		t.Fatalf("text = %q, err = %v", text, err)
	}
}

func TestFailureSaysWhy(t *testing.T) {
	_, err := ready(t, "fail").Transcribe(context.Background(), wav(), "en")
	if err == nil || !strings.Contains(err.Error(), "failed to read WAV file") {
		t.Fatalf("err = %v", err)
	}
}

func TestNotSetUp(t *testing.T) {
	w := New(t.TempDir(), testModel([]byte("x")))
	w.Find = func() string { return "" }
	if _, err := w.Transcribe(context.Background(), wav(), "en"); !errors.Is(err, ErrNoBinary) {
		t.Errorf("no binary: %v", err)
	}
	w.Find = func() string { return "/bin/true" }
	if _, err := w.Transcribe(context.Background(), wav(), "en"); !errors.Is(err, ErrNoModel) {
		t.Errorf("no model: %v", err)
	}
}

func TestLanguage(t *testing.T) {
	for tag, want := range map[string]string{
		"en-GB": "en", "fr": "fr", "pt-BR": "pt", "": "auto", "auto": "auto",
		"en; rm -rf": "auto", "EN": "en", "x-klingon": "auto",
	} {
		if got := Language(tag); got != want {
			t.Errorf("Language(%q) = %q, want %q", tag, got, want)
		}
	}
}

func TestClean(t *testing.T) {
	for in, want := range map[string]string{
		" Hello there.\n How are you?\n": "Hello there. How are you?",
		" [BLANK_AUDIO]\n":               "",
		"(silence) ok [MUSIC]":           "ok",
	} {
		if got := Clean(in); got != want {
			t.Errorf("Clean(%q) = %q, want %q", in, got, want)
		}
	}
}
