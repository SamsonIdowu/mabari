// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func tokenFile(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte(strings.Repeat("t", 40)), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// Port 1 has nothing listening, which is Mabari being down.
func TestASessionsGatingHookBlocksWhenMabariIsDown(t *testing.T) {
	for _, event := range []string{"PermissionRequest", "PreToolUse"} {
		var out bytes.Buffer
		err := runHook([]string{"--run", "--port", "1", "--token-file", tokenFile(t), event}, strings.NewReader(`{}`), &out)
		var blocked actionBlocked
		if !errors.As(err, &blocked) {
			t.Errorf("%s: err = %v", event, err)
		}
		if out.Len() != 0 {
			t.Errorf("%s: printed %q", event, out.String())
		}
	}
}

// Exit 2 means something else on other events: on Stop it keeps Claude working.
func TestASessionsOtherHooksNeverBlock(t *testing.T) {
	for _, event := range []string{"Stop", "UserPromptSubmit", "PostToolUse", "SessionEnd"} {
		if err := runHook([]string{"--run", "--port", "1", "--token-file", tokenFile(t), event}, strings.NewReader(`{}`), &bytes.Buffer{}); err != nil {
			t.Errorf("%s: err = %v", event, err)
		}
	}
}

// A session started elsewhere has its own prompt to fall back on, so its hook stays out of the way.
func TestTheSettingsHookStillNeverBlocks(t *testing.T) {
	err := runHook([]string{"--port", "1", "--token-file", tokenFile(t), "PermissionRequest"}, strings.NewReader(`{}`), &bytes.Buffer{})
	if err != nil {
		t.Fatalf("err = %v", err)
	}
}
