// SPDX-License-Identifier: Apache-2.0

package models_test

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/gzuidhof/tygo/tygo"
	"gopkg.in/yaml.v2"
)

func TestGeneratedTypesAreCurrent(t *testing.T) {
	const root = "../.."
	raw, err := os.ReadFile(filepath.Join(root, "tygo.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var cfg tygo.Config
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Packages) != 1 {
		t.Fatalf("expected one package in tygo.yaml, got %d", len(cfg.Packages))
	}

	committed := filepath.Join(root, cfg.Packages[0].OutputPath)
	fresh := filepath.Join(t.TempDir(), "models.ts")
	cfg.Packages[0].OutputPath = fresh
	if err := tygo.New(&cfg).Generate(); err != nil {
		t.Fatalf("generate: %v", err)
	}

	want, err := os.ReadFile(fresh)
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(committed)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("%s is stale: run `make gen`", committed)
	}
}
