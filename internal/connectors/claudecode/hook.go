// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/SamsonIdowu/mabari/internal/secrets"
)

// TokenName is the secret holding the token hooks send to the server.
const TokenName = "claude_hook_token"

// HookPath is where the server takes hook calls. The event name follows it.
const HookPath = "/api/hooks/claude/"

// maxHookInput is the most a hook reads from Claude Code. Tool inputs can carry whole files.
const maxHookInput = 4 << 20

// quickWait is how long an ordinary hook waits for Mabari, well inside Claude Code's 5 second
// timeout, so a slow or stopped Mabari barely delays Claude.
const quickWait = 1500 * time.Millisecond

// RunHook is `mabari hook <event>`. It passes Claude Code's input to the local server and prints
// the reply. Whatever goes wrong, it prints nothing and succeeds, so Claude Code carries on as if
// Mabari weren't there. It never approves anything by itself.
func RunHook(event string, port int, stdin io.Reader, stdout io.Writer, token func() (string, error)) {
	wait := func(body []byte) time.Duration {
		if waitsForPerson(event, body) {
			return PermissionWait*time.Second + 2*time.Second
		}
		return quickWait
	}
	callHook(event, port, stdin, stdout, token, wait, false)
}

// RunSessionHook is `mabari hook --run <event>`, the hook of a session Mabari runs. It reports
// whether Mabari answered. Unlike RunHook it must not leave Claude Code to carry on when it can't
// reach Mabari, so for an event that gates an action the caller blocks the action on false.
func RunSessionHook(event string, port int, stdin io.Reader, stdout io.Writer, token func() (string, error)) bool {
	wait := func([]byte) time.Duration {
		switch event {
		case "PermissionRequest":
			return SessionPermissionWait*time.Second + 2*time.Second
		case "PreToolUse":
			return gateWait
		}
		return quickWait
	}
	return callHook(event, port, stdin, stdout, token, wait, true)
}

// Gates reports whether a hook event decides if an action goes ahead.
func Gates(event string) bool { return event == "PermissionRequest" || event == "PreToolUse" }

// callHook makes the call and reports whether a signed answer came back, printing it if it has
// anything to say. fromRun marks it as a run's, with RunHeader naming the token it is signed with.
func callHook(
	event string, port int, stdin io.Reader, stdout io.Writer, token func() (string, error),
	wait func(body []byte) time.Duration, fromRun bool,
) bool {
	body, err := io.ReadAll(io.LimitReader(stdin, maxHookInput))
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), wait(body))
	defer cancel()
	// Reading the token can stall, such as a keychain waiting to be unlocked. Claude Code waits
	// up to two minutes for PreToolUse, so the read is held to the same short wait as the call.
	secret, ok := readToken(ctx, token)
	if !ok {
		return false
	}
	url := "http://127.0.0.1:" + strconv.Itoa(port) + HookPath + event
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return false
	}
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return false
	}
	nonceText := hex.EncodeToString(nonce)
	sent := strconv.FormatInt(time.Now().Unix(), 10)
	run := ""
	if fromRun {
		run = RunKey(secret)
		request.Header.Set(RunHeader, run)
	}
	request.Header.Set(NonceHeader, nonceText)
	request.Header.Set(TimeHeader, sent)
	request.Header.Set(SignatureHeader, SignRequest(secret, nonceText, sent, event, run, body))
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return false
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return false
	}
	reply, err := io.ReadAll(io.LimitReader(response.Body, maxHookInput))
	if err != nil {
		return false
	}
	// Only a reply signed with the token, for this call, counts, and an empty one is signed too.
	if !Verify(SignReply(secret, nonceText, reply), response.Header.Get(SignatureHeader)) {
		return false
	}
	if len(bytes.TrimSpace(reply)) == 0 {
		return true
	}
	if !json.Valid(reply) {
		return false
	}
	_, _ = stdout.Write(reply)
	return true
}

// readToken reads the hook token, giving up when ctx ends.
func readToken(ctx context.Context, token func() (string, error)) (string, bool) {
	type result struct {
		secret string
		err    error
	}
	done := make(chan result, 1)
	go func() {
		secret, err := token()
		done <- result{secret, err}
	}()
	select {
	case got := <-done:
		return got.secret, got.err == nil && got.secret != ""
	case <-ctx.Done():
		return "", false
	}
}

// waitsForPerson reports whether the hook waits for someone in Mabari: a permission request, or
// a question Claude asks. Every other call, other tools' PreToolUse included, stays quick.
func waitsForPerson(event string, body []byte) bool {
	if event == "PermissionRequest" {
		return true
	}
	if event != "PreToolUse" {
		return false
	}
	var call struct {
		ToolName string `json:"tool_name"`
	}
	return json.Unmarshal(body, &call) == nil && call.ToolName == AskTool
}

// EnsureToken keeps the install's hook token in the secret store, making one the first time.
func EnsureToken(store secrets.Store) error {
	if _, err := store.Get(TokenName); err == nil {
		return nil
	} else if !errors.Is(err, secrets.ErrNotFound) {
		return err
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return err
	}
	return store.Set(TokenName, "mab_hook_"+hex.EncodeToString(raw))
}

// ReadTokenFile reads a hook token kept in a file, for Mabari in Docker with Claude Code on the
// host. The same file is the container's mabari_hook_token secret.
func ReadTokenFile(path string) (string, error) {
	content, err := os.ReadFile(path) // #nosec G304 -- the person's own token file
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(content))
	if len(token) < 32 {
		return "", errors.New("the hook token file is too short")
	}
	return token, nil
}

// EnsureTokenFile makes the token file the first time, readable only by its owner.
func EnsureTokenFile(path string) error {
	if _, err := ReadTokenFile(path); err == nil {
		return nil
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, []byte("mab_hook_"+hex.EncodeToString(raw)+"\n"), 0o600)
}
