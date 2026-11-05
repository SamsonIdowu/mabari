// SPDX-License-Identifier: Apache-2.0

package models

import (
	"slices"
	"strings"
	"testing"
)

func demoAccounts() []Account {
	accounts := []Account{}
	for _, kind := range AccountKinds {
		accounts = append(accounts, Account{ID: string(kind), Kind: kind, Models: Models[kind]})
	}
	return accounts
}

// Every default the app starts with is a model its own account offers, so a select can always show
// the stored value.
func TestEveryDefaultIsOneOfItsAccountsModels(t *testing.T) {
	settings := DefaultSettings()
	for kind, key := range DefaultsKey {
		value, ok := settings.Defaults[key]
		if !ok {
			t.Errorf("no default for %s", kind)
			continue
		}
		if !slices.Contains(Models[kind], value) {
			t.Errorf("the %s default %q is not one of its models %v", key, value, Models[kind])
		}
	}
	if len(settings.Defaults) != len(DefaultsKey) {
		t.Errorf("defaults %v and keys %v differ", settings.Defaults, DefaultsKey)
	}
	// The hub's placeholder is not a model, so it can never be a choice.
	var every []string
	for _, account := range demoAccounts() {
		if account.Kind != AccountHub {
			every = append(every, account.Models...)
		}
	}
	if !slices.Contains(every, settings.QueryModel) {
		t.Errorf("the query model %q is not offered by any account", settings.QueryModel)
	}
	if corrected, changes := CorrectModels(settings, demoAccounts()); len(changes) != 0 || corrected.QueryModel != settings.QueryModel {
		t.Errorf("the standard settings need correcting: %v", changes)
	}
}

func TestCorrectModels(t *testing.T) {
	// What an earlier version stored: an Anthropic default that is a Claude Code model, and a query
	// model nobody offers.
	stale := DefaultSettings()
	stale.Defaults["anthropic"] = "claude-sonnet-4-5"
	stale.Defaults["openai"] = "gpt-9"
	stale.QueryModel = "model-from-nowhere"
	fixed, changes := CorrectModels(stale, demoAccounts())
	if fixed.Defaults["anthropic"] != "claude-sonnet-5-5" || fixed.Defaults["openai"] != "gpt-5" ||
		!slices.Contains(Models[AccountCodex], fixed.QueryModel) {
		t.Errorf("fixed = %+v", fixed)
	}
	if len(changes) != 3 {
		t.Fatalf("changes = %q", changes)
	}
	for _, want := range []string{"Anthropic API key default was claude-sonnet-4-5", "now claude-sonnet-5-5", "OpenAI API key default was gpt-9", "answers queries was model-from-nowhere"} {
		if !strings.Contains(strings.Join(changes, "\n"), want) {
			t.Errorf("no sentence says %q: %q", want, changes)
		}
	}
	// The original is left alone: settings are copied, never changed in place.
	if stale.Defaults["anthropic"] != "claude-sonnet-4-5" {
		t.Error("the settings passed in were changed")
	}

	// A choice that is valid stays, whether or not its account is connected.
	kept := DefaultSettings()
	kept.QueryModel = "gpt-5-mini"
	kept.Defaults["claude"] = "claude-haiku-4-5"
	if again, changes := CorrectModels(kept, demoAccounts()); len(changes) != 0 || again.QueryModel != "gpt-5-mini" ||
		again.Defaults["claude"] != "claude-haiku-4-5" {
		t.Errorf("valid choices were changed: %q %+v", changes, again)
	}

	// With no account offering the standard default, the first model offered is used.
	odd := []Account{{Kind: AccountCodex, Models: []string{"gpt-6", "gpt-6-mini"}}}
	moved, _ := CorrectModels(DefaultSettings(), odd)
	if moved.Defaults["codex"] != "gpt-6" || moved.QueryModel != "gpt-6" {
		t.Errorf("moved = %+v", moved)
	}

	// With no models known at all nothing can be said to be wrong.
	if same, changes := CorrectModels(stale, nil); len(changes) != 0 || same.Defaults["anthropic"] != "claude-sonnet-4-5" {
		t.Errorf("settings changed with no accounts to check against: %q", changes)
	}
}

// The hub's placeholder text is never a choice for the query model.
func TestTheHubPlaceholderIsNeverTheQueryModel(t *testing.T) {
	settings := DefaultSettings()
	settings.QueryModel = Models[AccountHub][0]
	fixed, changes := CorrectModels(settings, demoAccounts())
	if fixed.QueryModel == Models[AccountHub][0] || len(changes) != 1 {
		t.Errorf("query model = %q, changes = %q", fixed.QueryModel, changes)
	}
}

func TestPickModel(t *testing.T) {
	offered := []string{"a", "b", "c"}
	for _, tc := range []struct {
		name      string
		offered   []string
		preferred string
		want      string
	}{
		{"the preference is offered", offered, "b", "b"},
		{"the preference is not, so the first offered", offered, "z", "a"},
		{"nothing is offered, so the preference stands", nil, "z", "z"},
	} {
		if got := PickModel(tc.offered, tc.preferred); got != tc.want {
			t.Errorf("%s: PickModel = %q, want %q", tc.name, got, tc.want)
		}
	}
}
