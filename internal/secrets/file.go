// SPDX-License-Identifier: Apache-2.0

package secrets

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/crypto/chacha20poly1305"
)

// FileName is the encrypted file inside the data folder.
const FileName = "secrets.enc"

// MinMasterKey is the shortest master key accepted. A random key such as the output of
// `openssl rand -base64 32` is 44 characters.
const MinMasterKey = 32

// DockerSecretPath is where Docker mounts a secret named mabari_master_key.
const DockerSecretPath = "/run/secrets/mabari_master_key" // #nosec G101 -- a path, not a credential

// ErrNoMasterKey means the encrypted file was chosen without a master key.
var ErrNoMasterKey = errors.New("the encrypted-file secrets backend needs a master key: " +
	"set MABARI_MASTER_KEY_FILE, mount the Docker secret mabari_master_key, or set MABARI_MASTER_KEY")

// MasterKey finds the master key: a key file first, then a Docker secret, then the environment.
// It returns "" if there is none. Surrounding white space in a file is ignored.
func MasterKey(keyFile string, getenv func(string) string) (string, error) {
	for _, path := range []string{keyFile, DockerSecretPath} {
		if path == "" {
			continue
		}
		raw, err := os.ReadFile(path) // #nosec G304 -- the path is the user's own setting
		if errors.Is(err, fs.ErrNotExist) && path == DockerSecretPath {
			continue
		}
		if err != nil {
			return "", fmt.Errorf("read master key: %w", err)
		}
		return strings.TrimSpace(string(raw)), nil
	}
	return getenv("MABARI_MASTER_KEY"), nil
}

// File keeps every secret in one file, sealed with XChaCha20-Poly1305. The key is the SHA-256 of
// the master key, which must be long and random, so no slow password hash is needed.
type File struct {
	mu   sync.Mutex
	path string
	key  [32]byte
}

// NewFile opens the encrypted file in dir, which need not exist yet.
func NewFile(dir, masterKey string) (*File, error) {
	if masterKey == "" {
		return nil, ErrNoMasterKey
	}
	if len(masterKey) < MinMasterKey {
		return nil, fmt.Errorf("the master key must be at least %d characters", MinMasterKey)
	}
	f := &File{path: filepath.Join(dir, FileName), key: sha256.Sum256([]byte(masterKey))}
	// A wrong key is found now, at start, and not on the first secret read.
	if _, err := f.read(); err != nil {
		return nil, err
	}
	return f, nil
}

func (f *File) read() (map[string]string, error) {
	sealed, err := os.ReadFile(f.path)
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	aead, err := chacha20poly1305.NewX(f.key[:])
	if err != nil {
		return nil, err
	}
	if len(sealed) < aead.NonceSize() {
		return nil, errors.New("the secrets file is damaged")
	}
	nonce, box := sealed[:aead.NonceSize()], sealed[aead.NonceSize():]
	plain, err := aead.Open(nil, nonce, box, []byte(FileName))
	if err != nil {
		return nil, errors.New("the secrets file can't be opened with this master key")
	}
	values := map[string]string{}
	if err := json.Unmarshal(plain, &values); err != nil {
		return nil, errors.New("the secrets file is damaged")
	}
	return values, nil
}

// write seals the values with a fresh nonce and replaces the file in one step.
func (f *File) write(values map[string]string) error {
	plain, err := json.Marshal(values)
	if err != nil {
		return err
	}
	aead, err := chacha20poly1305.NewX(f.key[:])
	if err != nil {
		return err
	}
	nonce := make([]byte, aead.NonceSize(), aead.NonceSize()+len(plain)+aead.Overhead())
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	sealed := aead.Seal(nonce, nonce, plain, []byte(FileName))
	temp := f.path + ".tmp"
	if err := os.WriteFile(temp, sealed, 0o600); err != nil {
		return err
	}
	return os.Rename(temp, f.path)
}

// Get returns a secret or ErrNotFound.
func (f *File) Get(name string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	values, err := f.read()
	if err != nil {
		return "", err
	}
	value, ok := values[name]
	if !ok {
		return "", ErrNotFound
	}
	return value, nil
}

// Set stores a secret.
func (f *File) Set(name, value string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	values, err := f.read()
	if err != nil {
		return err
	}
	values[name] = value
	return f.write(values)
}

// Delete removes a secret. Removing one that isn't there is not an error.
func (f *File) Delete(name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	values, err := f.read()
	if err != nil {
		return err
	}
	if _, ok := values[name]; !ok {
		return nil
	}
	delete(values, name)
	return f.write(values)
}
