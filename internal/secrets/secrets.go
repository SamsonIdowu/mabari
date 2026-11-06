// SPDX-License-Identifier: Apache-2.0

// Package secrets keeps tokens and API keys out of plain files and out of the database. On a
// desktop they go to the operating system keychain. Where there is no keychain, such as Docker,
// they go to one file encrypted with a master key the user supplies, and Mabari refuses to start
// that backend without one.
package secrets

import (
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"sync"
)

// ErrNotFound means no secret is stored under that name.
var ErrNotFound = errors.New("secret not found")

// Store holds named secrets. Names are short identifiers such as "anthropic_key".
type Store interface {
	Get(name string) (string, error)
	Set(name, value string) error
	Delete(name string) error
}

// Backends a user can choose with MABARI_SECRETS.
const (
	BackendKeychain      = "keychain"
	BackendEncryptedFile = "encrypted-file"
)

// Options chooses and configures a backend.
type Options struct {
	Backend string
	// DataDir holds the encrypted file.
	DataDir string
	// MasterKey is the raw master key text for the encrypted file. Load it with MasterKey.
	MasterKey string
}

// Open returns the chosen backend.
func Open(options Options) (Store, error) {
	switch options.Backend {
	case BackendKeychain:
		return NewKeychain(KeychainService), nil
	case BackendEncryptedFile:
		return NewFile(options.DataDir, options.MasterKey)
	default:
		return nil, fmt.Errorf("unknown secrets backend %q", options.Backend)
	}
}

// Memory keeps secrets in memory, for tests.
type Memory struct {
	mu     sync.Mutex
	values map[string]string
}

// NewMemory returns an empty in-memory store.
func NewMemory() *Memory { return &Memory{values: map[string]string{}} }

// Get returns a secret or ErrNotFound.
func (m *Memory) Get(name string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	value, ok := m.values[name]
	if !ok {
		return "", ErrNotFound
	}
	return value, nil
}

// Set stores a secret.
func (m *Memory) Set(name, value string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.values[name] = value
	return nil
}

// Delete removes a secret. Removing one that isn't there is not an error.
func (m *Memory) Delete(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.values, name)
	return nil
}

// Names lists what is stored, for tests.
func (m *Memory) Names() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	names := make([]string, 0, len(m.values))
	for name := range maps.Keys(m.values) {
		names = append(names, name)
	}
	return names
}

// ChildEnv is the environment for a program Mabari starts that runs other people's code, such as a
// Claude Code session and every command in it: this one, without anything of Mabari's. The master
// key opens every secret, and nothing a session runs has a use for it, or for where it is kept.
func ChildEnv(environ []string) []string {
	return slices.DeleteFunc(slices.Clone(environ), func(entry string) bool {
		return strings.HasPrefix(strings.ToUpper(entry), "MABARI_")
	})
}
