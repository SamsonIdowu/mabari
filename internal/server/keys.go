// SPDX-License-Identifier: Apache-2.0

package server

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"regexp"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// Secret names for keys and the hub token. Each matches its account kind.
const (
	secretHubToken = "hub_token"
)

// keyRules are the shapes each provider's keys take, checked before a key is stored.
var keyRules = map[models.AccountKind]struct {
	pattern *regexp.Regexp
	label   string
}{
	models.AccountAnthropicKey: {regexp.MustCompile(`^sk-ant-[A-Za-z0-9_-]{20,200}$`), "Anthropic API key"},
	models.AccountOpenAIKey:    {regexp.MustCompile(`^sk-[A-Za-z0-9_-]{20,200}$`), "OpenAI API key"},
}

func (a *api) keyRoutes(mux *http.ServeMux) {
	mux.HandleFunc("PUT /api/accounts/{kind}/key", a.saveKey)
	mux.HandleFunc("DELETE /api/accounts/{kind}/key", a.deleteKey)
	mux.HandleFunc("POST /api/accounts/hub/token", a.newHubToken)
	mux.HandleFunc("DELETE /api/accounts/hub/token", a.revokeHubToken)
}

// saveKey stores a key in the secret store. The key is never sent back, logged or kept in the
// database; the account only records that one is set.
func (a *api) saveKey(w http.ResponseWriter, r *http.Request) {
	kind := models.AccountKind(r.PathValue("kind"))
	rule, ok := keyRules[kind]
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	var body struct {
		Key string `json:"key"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if !rule.pattern.MatchString(body.Key) {
		writeError(w, http.StatusBadRequest, "that doesn't look like an "+rule.label)
		return
	}
	if err := a.secrets.Set(string(kind), body.Key); err != nil {
		internalError(w, err)
		return
	}
	a.setAccountStatus(w, kind, models.AccountConnected, "Saved the "+rule.label)
}

func (a *api) deleteKey(w http.ResponseWriter, r *http.Request) {
	kind := models.AccountKind(r.PathValue("kind"))
	rule, ok := keyRules[kind]
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if err := a.secrets.Delete(string(kind)); err != nil {
		internalError(w, err)
		return
	}
	a.setAccountStatus(w, kind, models.AccountOff, "Removed the "+rule.label)
}

// newHubToken makes a hub token and shows it once. Making a new one replaces the old one.
func (a *api) newHubToken(w http.ResponseWriter, _ *http.Request) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		internalError(w, err)
		return
	}
	token := "mab_" + hex.EncodeToString(raw)
	if err := a.secrets.Set(secretHubToken, token); err != nil {
		internalError(w, err)
		return
	}
	if err := a.engine.Do(func() {
		a.setAccount(models.AccountHub, models.AccountConnected)
		a.engine.Log("Everyone", models.LogSession, "Made a hub token", "Connected", "ok")
	}); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": token})
}

func (a *api) revokeHubToken(w http.ResponseWriter, _ *http.Request) {
	if err := a.secrets.Delete(secretHubToken); err != nil {
		internalError(w, err)
		return
	}
	a.setAccountStatus(w, models.AccountHub, models.AccountOff, "Revoked the hub token")
}

func (a *api) setAccountStatus(w http.ResponseWriter, kind models.AccountKind, status models.AccountStatus, logText string) {
	if err := a.engine.Do(func() {
		a.setAccount(kind, status)
		a.engine.Log("Everyone", models.LogSession, logText, string(status), "")
	}); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// setAccount changes one account's status. Call inside Do.
func (a *api) setAccount(kind models.AccountKind, status models.AccountStatus) {
	for _, account := range a.engine.StoredAccounts() {
		if account.Kind == kind {
			account.Status = status
			a.engine.SetAccount(account)
		}
	}
}
