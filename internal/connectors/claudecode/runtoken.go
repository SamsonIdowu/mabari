// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
)

// A session Mabari runs doesn't get Mabari's environment, so its hook can't open the secret store:
// that takes the master key, which must not reach the session or any command it runs. Instead each
// process gets a token of its own, in a file only this user can read, and its hook passes
// --token-file. The server knows the token only while the process lives, and takes it only on a call
// marked as a run's. It can sign hook calls and nothing else, so what a command that read the file
// could do is report as that session, which approves nothing. The file's path is under .mabari,
// which needs a click to read.

// RunKey names a run token, so the server can find it without it crossing the wire.
func RunKey(token string) string {
	sum := sha256.Sum256([]byte("mabari-run|" + token))
	return hex.EncodeToString(sum[:8])
}

// RunToken finds the token of a process still alive.
func (c *Connector) RunToken(key string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	token, known := c.runKeys[key]
	return token, known
}

// runToken is a process's token and where it is kept.
type runToken struct {
	key, folder, file string
}

// newRunToken makes a token for a process that is about to start.
func (c *Connector) newRunToken() (*runToken, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	if c.RunTokens != "" {
		if err := os.MkdirAll(c.RunTokens, 0o700); err != nil {
			return nil, fmt.Errorf("couldn't make the folder for session tokens: %w", err)
		}
	}
	folder, err := os.MkdirTemp(c.RunTokens, "run-")
	if err != nil {
		return nil, fmt.Errorf("couldn't make a session token: %w", err)
	}
	token := "mab_run_" + hex.EncodeToString(raw)
	file := filepath.Join(folder, "token")
	if err := os.WriteFile(file, []byte(token+"\n"), 0o600); err != nil {
		_ = os.RemoveAll(folder)
		return nil, fmt.Errorf("couldn't write a session token: %w", err)
	}
	made := &runToken{key: RunKey(token), folder: folder, file: file}
	c.mu.Lock()
	c.runKeys[made.key] = token
	c.mu.Unlock()
	return made, nil
}

// forget ends a token: its process has gone, or never started.
func (c *Connector) forgetRunToken(token *runToken) {
	c.mu.Lock()
	delete(c.runKeys, token.key)
	c.mu.Unlock()
	_ = os.RemoveAll(token.folder)
}
