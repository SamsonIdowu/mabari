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
	body, err := io.ReadAll(io.LimitReader(stdin, maxHookInput))
	if err != nil {
		return
	}
	secret, err := token()
	if err != nil || secret == "" {
		return
	}
	wait := quickWait
	if event == "PermissionRequest" {
		wait = PermissionWait*time.Second + 2*time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), wait)
	defer cancel()
	url := "http://127.0.0.1:" + strconv.Itoa(port) + HookPath + event
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return
	}
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return
	}
	nonceText := hex.EncodeToString(nonce)
	sent := strconv.FormatInt(time.Now().Unix(), 10)
	request.Header.Set(NonceHeader, nonceText)
	request.Header.Set(TimeHeader, sent)
	request.Header.Set(SignatureHeader, SignRequest(secret, nonceText, sent, event, body))
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return
	}
	reply, err := io.ReadAll(io.LimitReader(response.Body, maxHookInput))
	if err != nil || len(bytes.TrimSpace(reply)) == 0 || !json.Valid(reply) {
		return
	}
	// Only a reply signed with the token, for this call, is printed.
	if !Verify(SignReply(secret, nonceText, reply), response.Header.Get(SignatureHeader)) {
		return
	}
	_, _ = stdout.Write(reply)
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
