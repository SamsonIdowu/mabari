// SPDX-License-Identifier: Apache-2.0

package secrets

import (
	"errors"

	"github.com/zalando/go-keyring"
)

// KeychainService is the name Mabari's entries carry in the keychain.
const KeychainService = "dev.mabari"

// Keychain stores secrets in the operating system keychain: Keychain on macOS, the Secret Service
// on Linux and the Credential Manager on Windows.
type Keychain struct{ service string }

// NewKeychain returns a keychain store under one service name.
func NewKeychain(service string) *Keychain { return &Keychain{service: service} }

// Get returns a secret or ErrNotFound.
func (k *Keychain) Get(name string) (string, error) {
	value, err := keyring.Get(k.service, name)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", ErrNotFound
	}
	return value, err
}

// Set stores a secret.
func (k *Keychain) Set(name, value string) error { return keyring.Set(k.service, name, value) }

// Delete removes a secret. Removing one that isn't there is not an error.
func (k *Keychain) Delete(name string) error {
	err := keyring.Delete(k.service, name)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}
