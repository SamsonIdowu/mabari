// SPDX-License-Identifier: Apache-2.0

// Package whisper runs local speech to text with whisper.cpp. The person installs whisper.cpp
// themselves; Mabari only downloads the model, after a click, and runs `whisper-cli` as a
// separate process. Audio never leaves the computer.
package whisper

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/secrets"
)

// Model is the file Mabari downloads. Medium matches the "about 1.5 GB" in Settings and handles
// languages other than English. The size and hash pin the exact file.
type Model struct {
	Name   string
	URL    string
	SHA256 string
	Bytes  int64
}

// Medium is whisper.cpp's ggml-medium model, checked on Hugging Face on 2026-11-04.
var Medium = Model{
	Name:   "ggml-medium.bin",
	URL:    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
	SHA256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
	Bytes:  1533763059,
}

// MaxAudioBytes caps one recording: about eight minutes of 16 kHz mono 16 bit audio.
const MaxAudioBytes = 16 << 20

// Timeout bounds one transcription, so a stuck whisper-cli can't hold the request forever.
const Timeout = 2 * time.Minute

var (
	// ErrNoBinary means whisper.cpp isn't installed where Mabari can find it.
	ErrNoBinary = errors.New("whisper.cpp isn't installed. Install it, for example with brew install whisper-cpp")
	// ErrNoModel means the model hasn't been downloaded yet.
	ErrNoModel = errors.New("the Whisper model isn't downloaded yet. Download it in Settings")
	// ErrNotWAV means the upload isn't the 16 kHz WAV the web app records.
	ErrNotWAV = errors.New("the recording isn't a WAV file")
	// ErrBusy means a download is already running.
	ErrBusy = errors.New("the model is already downloading")
)

// Status is what Settings shows.
type Status = models.WhisperStatus

// Whisper finds whisper-cli, keeps the model in its folder and runs transcriptions one at a time.
type Whisper struct {
	dir    string
	model  Model
	client *http.Client
	// Find returns the whisper-cli path, or "". Tests replace it.
	Find func() string

	run sync.Mutex // one transcription at a time; each one uses every core

	mu       sync.Mutex
	loading  bool
	done     int64
	failure  string
	cancelDL context.CancelFunc
}

// New keeps the model in dir, which is created on first download.
func New(dir string, model Model) *Whisper {
	return &Whisper{
		dir: dir, model: model, Find: findBinary,
		client: &http.Client{CheckRedirect: httpsOnly},
	}
}

// SetClient replaces the HTTP client, for tests.
func (w *Whisper) SetClient(client *http.Client) { w.client = client }

func httpsOnly(request *http.Request, via []*http.Request) error {
	if len(via) >= 10 {
		return errors.New("too many redirects")
	}
	if request.URL.Scheme != "https" {
		return errors.New("refusing a redirect away from https")
	}
	return nil
}

// findBinary looks on PATH and then in Homebrew's folders, because a login service starts
// with a short PATH. whisper.cpp names its tool whisper-cli; older builds called it main.
func findBinary() string {
	if path, err := exec.LookPath("whisper-cli"); err == nil {
		return path
	}
	for _, dir := range []string{"/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"} {
		path := filepath.Join(dir, "whisper-cli")
		if info, err := os.Stat(path); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return path
		}
	}
	return ""
}

func (w *Whisper) modelPath() string { return filepath.Join(w.dir, w.model.Name) }

// ready says whether the model file is in place at its full size. The hash was checked when it
// was downloaded, and the folder is the person's own.
func (w *Whisper) ready() bool {
	info, err := os.Stat(w.modelPath())
	return err == nil && info.Mode().IsRegular() && info.Size() == w.model.Bytes
}

// Status reports what is installed and how a download is going.
func (w *Whisper) Status() Status {
	w.mu.Lock()
	defer w.mu.Unlock()
	return Status{
		Installed: w.Find() != "", Ready: !w.loading && w.ready(),
		Downloading: w.loading, Done: w.done, Total: w.model.Bytes, Error: w.failure,
	}
}

// Download starts fetching the model in the background. Status reports progress.
func (w *Whisper) Download() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.loading {
		return ErrBusy
	}
	ctx, cancel := context.WithCancel(context.Background())
	w.loading, w.done, w.failure, w.cancelDL = true, 0, "", cancel
	go func() {
		err := w.fetch(ctx)
		cancel()
		w.mu.Lock()
		defer w.mu.Unlock()
		w.loading, w.cancelDL = false, nil
		switch {
		case errors.Is(err, context.Canceled):
			w.failure = ""
		case err != nil:
			w.failure = "The download didn't finish: " + err.Error()
		}
	}()
	return nil
}

// Remove stops a download and deletes the model, to free the space.
func (w *Whisper) Remove() error {
	w.mu.Lock()
	if w.cancelDL != nil {
		w.cancelDL()
	}
	w.failure = ""
	w.mu.Unlock()
	err := os.Remove(w.modelPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

type counter struct {
	w *Whisper
}

func (c counter) Write(p []byte) (int, error) {
	c.w.mu.Lock()
	c.w.done += int64(len(p))
	c.w.mu.Unlock()
	return len(p), nil
}

// fetch downloads to a part file, checks size and hash, then moves it into place, so a
// half-downloaded or altered model is never used.
func (w *Whisper) fetch(ctx context.Context) error {
	if err := os.MkdirAll(w.dir, 0o700); err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, w.model.URL, nil)
	if err != nil {
		return err
	}
	response, err := w.client.Do(request) // #nosec G107 -- a fixed, pinned URL
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("the server answered %s", response.Status)
	}
	part := w.modelPath() + ".part"
	file, err := os.OpenFile(part, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600) // #nosec G304
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(part) }()
	hash := sha256.New()
	// One byte past the expected size is enough to know the file is wrong.
	copied, err := io.Copy(io.MultiWriter(file, hash, counter{w}), io.LimitReader(response.Body, w.model.Bytes+1))
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if copied != w.model.Bytes {
		return fmt.Errorf("expected %d bytes, got %d", w.model.Bytes, copied)
	}
	if got := hex.EncodeToString(hash.Sum(nil)); got != w.model.SHA256 {
		return errors.New("the file doesn't match the published checksum")
	}
	return os.Rename(part, w.modelPath())
}

var language = regexp.MustCompile(`^(auto|[a-z]{2,3})$`)

// Language turns a browser language such as en-GB into whisper's two letter code.
func Language(tag string) string {
	code := strings.ToLower(strings.SplitN(strings.TrimSpace(tag), "-", 2)[0])
	if !language.MatchString(code) {
		return "auto"
	}
	return code
}

// Marks whisper.cpp prints in place of speech, which mean nothing was said.
var silence = regexp.MustCompile(`\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE|INAUDIBLE)\]|\((silence|music|inaudible)\)`)

// Clean joins whisper's lines into one sentence and drops its silence marks.
func Clean(output string) string {
	return strings.Join(strings.Fields(silence.ReplaceAllString(output, " ")), " ")
}

func isWAV(audio []byte) bool {
	return len(audio) > 44 && bytes.Equal(audio[0:4], []byte("RIFF")) && bytes.Equal(audio[8:12], []byte("WAVE"))
}

// Transcribe turns a 16 kHz WAV recording into text. It runs whisper-cli with no shell, on a
// private temporary file that is removed afterwards.
func (w *Whisper) Transcribe(ctx context.Context, audio []byte, lang string) (string, error) {
	binary := w.Find()
	if binary == "" {
		return "", ErrNoBinary
	}
	if !w.Status().Ready {
		return "", ErrNoModel
	}
	if !isWAV(audio) {
		return "", ErrNotWAV
	}
	w.run.Lock()
	defer w.run.Unlock()

	file, err := os.CreateTemp("", "mabari-voice-*.wav")
	if err != nil {
		return "", err
	}
	defer func() { _ = os.Remove(file.Name()) }()
	_, err = file.Write(audio)
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}

	ctx, cancel := context.WithTimeout(ctx, Timeout)
	defer cancel()
	threads := fmt.Sprint(max(1, min(8, runtime.NumCPU())))
	// The binary is found by a fixed name, every argument is fixed or checked (Language allows
	// only auto or two or three letters), and there is no shell.
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	cmd := exec.CommandContext(ctx, binary, // #nosec G204 -- the user's whisper-cli, fixed arguments
		"-m", w.modelPath(), "-f", file.Name(), "-l", Language(lang), "-t", threads, "-nt", "-np")
	cmd.Env = secrets.ChildEnv(os.Environ())
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", fmt.Errorf("whisper took too long: %w", ctx.Err())
		}
		return "", fmt.Errorf("whisper-cli failed: %w: %s", err, lastLine(stderr.String()))
	}
	return Clean(stdout.String()), nil
}

func lastLine(text string) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}
