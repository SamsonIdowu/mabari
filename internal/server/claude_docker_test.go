// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/connectors/claudecode"
	"github.com/SamsonIdowu/mabari/internal/connectors/simulator"
	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/secrets"
	"github.com/SamsonIdowu/mabari/internal/store"
)

// In Docker, Claude Code on the host signs hooks with a token file shared as a Docker secret,
// and Mabari never tries to change settings it can't see.
func TestClaudeCodeOnTheHostWithMabariInDocker(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	engine, err := events.New(ctx, s, nil)
	if err != nil {
		t.Fatal(err)
	}
	connector := claudecode.New(engine)
	engine.AddConnector(claudecode.Source, connector)
	tokenFile := filepath.Join(t.TempDir(), "hook_token")
	if err := claudecode.EnsureTokenFile(tokenFile); err != nil {
		t.Fatal(err)
	}
	token, err := claudecode.ReadTokenFile(tokenFile)
	if err != nil {
		t.Fatal(err)
	}
	sim := simulator.New(engine, simulator.Mulberry32(7), 0)
	handler := New(Options{Engine: engine, Simulator: sim, Claude: &ClaudeOptions{
		Connector: connector, Secrets: secrets.NewMemory(), TokenFile: tokenFile,
	}})
	o := &claudeOffice{office: &office{handler: handler, engine: engine, simulator: sim}}

	body := `{"session_id":"00000000-0000-4000-8000-000000000001","cwd":"/tmp/shop","hook_event_name":"SessionStart"}`
	if response := o.hook(t, token, "SessionStart", body); response.Code != http.StatusOK {
		t.Fatalf("hook = %d %s", response.Code, response.Body)
	}
	if response := o.hook(t, "mab_hook_wrong_wrong_wrong_wrong_wrong", "SessionStart", body); response.Code != http.StatusUnauthorized {
		t.Errorf("wrong token = %d", response.Code)
	}
	for _, path := range []string{"/api/accounts/claude", "/api/accounts/claude/connect", "/api/accounts/claude/disconnect"} {
		method, payload := http.MethodPost, `{"confirm":true}`
		if path == "/api/accounts/claude" {
			method, payload = http.MethodGet, ""
		}
		if strings.HasSuffix(path, "disconnect") {
			payload = ""
		}
		response := o.do(t, method, path, payload)
		if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), HostCommand) {
			t.Errorf("%s = %d %s", path, response.Code, response.Body)
		}
	}
}
