// SPDX-License-Identifier: Apache-2.0

package secrets

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/zalando/go-keyring"
)

const testKey = "a-test-master-key-that-is-long-enough-0123456789"

// Every backend that runs here behaves the same way.
func TestBackendsBehaveAlike(t *testing.T) {
	file, err := NewFile(t.TempDir(), testKey)
	if err != nil {
		t.Fatal(err)
	}
	for name, store := range map[string]Store{"memory": NewMemory(), "file": file} {
		t.Run(name, func(t *testing.T) {
			if _, err := store.Get("anthropic_key"); !errors.Is(err, ErrNotFound) {
				t.Errorf("missing: %v", err)
			}
			if err := store.Set("anthropic_key", "sk-ant-1"); err != nil {
				t.Fatal(err)
			}
			if err := store.Set("hub_token", "mab_2"); err != nil {
				t.Fatal(err)
			}
			if got, err := store.Get("anthropic_key"); err != nil || got != "sk-ant-1" {
				t.Errorf("get = %q, %v", got, err)
			}
			if err := store.Delete("anthropic_key"); err != nil {
				t.Fatal(err)
			}
			if err := store.Delete("anthropic_key"); err != nil {
				t.Errorf("second delete: %v", err)
			}
			if _, err := store.Get("anthropic_key"); !errors.Is(err, ErrNotFound) {
				t.Errorf("after delete: %v", err)
			}
			if got, _ := store.Get("hub_token"); got != "mab_2" {
				t.Errorf("the other secret = %q", got)
			}
		})
	}
}

func TestFileIsEncryptedAndPrivate(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFile(dir, testKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Set("openai_key", "sk-proj-visible-text"); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, FileName)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("sk-proj")) || bytes.Contains(raw, []byte("openai_key")) {
		t.Error("the file holds plain text")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v", info.Mode().Perm())
	}
	// A reopened store with the same key reads it back.
	again, err := NewFile(dir, testKey)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := again.Get("openai_key"); got != "sk-proj-visible-text" {
		t.Errorf("reopened = %q", got)
	}
}

func TestFileRefusesAMissingShortOrWrongKey(t *testing.T) {
	dir := t.TempDir()
	if _, err := NewFile(dir, ""); !errors.Is(err, ErrNoMasterKey) {
		t.Errorf("no key: %v", err)
	}
	if _, err := NewFile(dir, "short"); err == nil {
		t.Error("a short key was accepted")
	}
	store, err := NewFile(dir, testKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Set("k", "v"); err != nil {
		t.Fatal(err)
	}
	if _, err := NewFile(dir, testKey+"-but-different"); err == nil {
		t.Error("a wrong key opened the file")
	}
}

func TestFileRefusesATamperedFile(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFile(dir, testKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Set("k", "v"); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, FileName)
	raw, _ := os.ReadFile(path)
	raw[len(raw)-1] ^= 1
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get("k"); err == nil {
		t.Error("a changed file was read")
	}
}

func TestMasterKeyOrder(t *testing.T) {
	keyFile := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(keyFile, []byte("  from-the-file \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	env := func(string) string { return "from-the-environment" }
	if got, err := MasterKey(keyFile, env); err != nil || got != "from-the-file" {
		t.Errorf("file = %q, %v", got, err)
	}
	if got, err := MasterKey("", env); err != nil || got != "from-the-environment" {
		t.Errorf("environment = %q, %v", got, err)
	}
	if _, err := MasterKey(filepath.Join(t.TempDir(), "missing"), env); err == nil {
		t.Error("a missing key file was ignored")
	}
}

func TestOpenRefusesAnUnknownBackend(t *testing.T) {
	if _, err := Open(Options{Backend: "plain"}); err == nil {
		t.Error("an unknown backend was accepted")
	}
}

// The keychain wrapper runs against go-keyring's in-memory mock, never the real keychain.
func TestKeychainThroughTheMock(t *testing.T) {
	keyring.MockInit()
	store := NewKeychain("dev.mabari.test")
	if _, err := store.Get("k"); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing: %v", err)
	}
	if err := store.Set("k", "v"); err != nil {
		t.Fatal(err)
	}
	if got, err := store.Get("k"); err != nil || got != "v" {
		t.Errorf("get = %q, %v", got, err)
	}
	if err := store.Delete("k"); err != nil {
		t.Fatal(err)
	}
	if err := store.Delete("k"); err != nil {
		t.Errorf("second delete: %v", err)
	}
}
