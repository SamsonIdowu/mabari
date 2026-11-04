// SPDX-License-Identifier: Apache-2.0

package server

import (
	"io"
	"log/slog"
	"net/http"

	"github.com/SamsonIdowu/mabari/internal/connectors/claudecode"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/secrets"
)

// ClaudeOptions connects the server to Claude Code. Leave it nil and the routes aren't served.
type ClaudeOptions struct {
	Connector *claudecode.Connector
	Secrets   secrets.Store
	// ConfigDir is Claude Code's settings folder. Tests use a scratch folder.
	ConfigDir string
	// Hook is the binary and port written into settings.json.
	Hook claudecode.Hook
}

const maxHookBody = 4 << 20

func (a *api) claudeRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST "+claudecode.HookPath+"{event}", a.claudeHook)
	mux.HandleFunc("GET /api/accounts/claude", a.claudePlan)
	mux.HandleFunc("POST /api/accounts/claude/connect", a.claudeConnect)
	mux.HandleFunc("POST /api/accounts/claude/disconnect", a.claudeDisconnect)
}

// claudeHook takes one hook call. Only a call signed with the install's token gets in, because a
// hook reply can steer Claude, and the reply is signed so the hook knows it came from here.
func (a *api) claudeHook(w http.ResponseWriter, r *http.Request) {
	token, err := a.claude.Secrets.Get(claudecode.TokenName)
	if err != nil || token == "" {
		writeError(w, http.StatusUnauthorized, "Claude Code is not connected")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxHookBody))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "request is too large")
		return
	}
	nonce := r.Header.Get(claudecode.NonceHeader)
	want := claudecode.SignRequest(token, nonce, r.PathValue("event"), body)
	if len(nonce) < 16 || !claudecode.Verify(want, r.Header.Get(claudecode.SignatureHeader)) {
		writeError(w, http.StatusUnauthorized, "this hook call is not signed with the install's token")
		return
	}
	reply := a.claude.Connector.Handle(r.Context(), body)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set(claudecode.SignatureHeader, claudecode.SignReply(token, nonce, reply))
	w.WriteHeader(http.StatusOK)
	if len(reply) > 0 {
		_, _ = w.Write(reply)
	}
}

type claudeStatus struct {
	Attached bool              `json:"attached"`
	Path     string            `json:"path"`
	Diff     []models.DiffLine `json:"diff"`
	Backup   string            `json:"backup"`
}

// claudePlan shows exactly what Connect would change, before anything is written.
func (a *api) claudePlan(w http.ResponseWriter, _ *http.Request) {
	plan, err := claudecode.PlanAttach(a.claude.ConfigDir, a.claude.Hook)
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, claudeStatus{
		Attached: claudecode.Attached(a.claude.ConfigDir),
		Path:     plan.Path,
		Diff:     plan.Diff,
		Backup:   plan.Path + claudecode.BackupSuffix,
	})
}

// claudeConnect writes the hooks into settings.json, after a backup. It needs confirm: true, sent
// only after the user has seen the diff.
func (a *api) claudeConnect(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Confirm bool `json:"confirm"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if !body.Confirm {
		writeError(w, http.StatusBadRequest, "connecting changes settings.json, so it needs confirm: true")
		return
	}
	if a.claude.Hook.Binary == "" {
		writeError(w, http.StatusConflict, "start Mabari from its built binary to connect Claude Code")
		return
	}
	if err := claudecode.EnsureToken(a.claude.Secrets); err != nil {
		internalError(w, err)
		return
	}
	plan, err := claudecode.PlanAttach(a.claude.ConfigDir, a.claude.Hook)
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	if err := claudecode.Apply(plan); err != nil {
		internalError(w, err)
		return
	}
	slog.Info("attached Claude Code hooks", "settings", plan.Path)
	err = a.engine.Do(func() {
		a.setClaudeAccount(models.AccountConnected)
		a.engine.Log("Everyone", models.LogSession, "Connected Claude Code", "Hooks added", "ok")
		a.engine.Toast("Claude Code is connected. New sessions take a desk.")
	})
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// claudeDisconnect takes Mabari's hooks out of settings.json and forgets the hook token.
func (a *api) claudeDisconnect(w http.ResponseWriter, _ *http.Request) {
	if err := a.detachClaude(); err != nil {
		internalError(w, err)
		return
	}
	err := a.engine.Do(func() {
		a.setClaudeAccount(models.AccountOff)
		for _, agent := range append([]*models.LiveAgent{}, a.engine.Agents()...) {
			if agent.Source == claudecode.Source {
				a.engine.RemoveAgent(agent.ID)
			}
		}
		a.engine.Log("Everyone", models.LogSession, "Disconnected Claude Code", "Hooks removed", "")
	})
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *api) detachClaude() error {
	plan, err := claudecode.PlanDetach(a.claude.ConfigDir)
	if err != nil {
		return err
	}
	if err := claudecode.Apply(plan); err != nil {
		return err
	}
	return a.claude.Secrets.Delete(claudecode.TokenName)
}

// setClaudeAccount changes the Claude Code account's status. Call inside Do.
func (a *api) setClaudeAccount(status models.AccountStatus) {
	for _, account := range a.engine.Accounts() {
		if account.Kind == models.AccountClaudeCode {
			account.Status = status
			a.engine.SetAccount(account)
		}
	}
}
