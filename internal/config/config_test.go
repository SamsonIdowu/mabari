// SPDX-License-Identifier: Apache-2.0

package config

import (
	"io"
	"strings"
	"testing"
)

func env(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func load(t *testing.T, args []string, values map[string]string) Config {
	t.Helper()
	cfg, err := Load(args, env(values), io.Discard)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return cfg
}

func TestDefaultsOnlyListenOnThisComputer(t *testing.T) {
	cfg := load(t, nil, nil)
	if cfg.Address() != "127.0.0.1:4317" {
		t.Errorf("Address() = %q, want 127.0.0.1:4317", cfg.Address())
	}
}

func TestEnvironmentOverridesDefaults(t *testing.T) {
	cfg := load(t, nil, map[string]string{
		"MABARI_BIND": "127.0.0.2", "MABARI_PORT": "9000", "MABARI_DATA_DIR": "/data",
		"MABARI_SECRETS": "encrypted-file", "MABARI_LOG_LEVEL": "debug",
	})
	if cfg.Address() != "127.0.0.2:9000" || cfg.DataDir != "/data" ||
		cfg.Secrets != "encrypted-file" || cfg.LogLevel != "debug" {
		t.Errorf("environment not applied: %+v", cfg)
	}
}

func TestFlagsOverrideEnvironment(t *testing.T) {
	cfg := load(t,
		[]string{"--port", "9001", "--bind", "::1", "--data-dir", "/flag"},
		map[string]string{"MABARI_PORT": "9000", "MABARI_BIND": "localhost", "MABARI_DATA_DIR": "/env"},
	)
	if cfg.Port != 9001 || cfg.Bind != "::1" || cfg.DataDir != "/flag" {
		t.Errorf("flags did not win: %+v", cfg)
	}
}

func TestContainersMayBindToAllInterfaces(t *testing.T) {
	cfg := load(t, nil, map[string]string{"MABARI_BIND": "0.0.0.0", "MABARI_IN_CONTAINER": "1"})
	if cfg.Bind != "0.0.0.0" {
		t.Errorf("Bind = %q", cfg.Bind)
	}
}

func TestRejectsBadValues(t *testing.T) {
	cases := map[string]struct {
		args []string
		env  map[string]string
	}{
		"non-numeric port": {env: map[string]string{"MABARI_PORT": "abc"}},
		"port too high":    {args: []string{"--port", "70000"}},
		"port zero":        {args: []string{"--port", "0"}},
		"unknown secrets":  {env: map[string]string{"MABARI_SECRETS": "plain"}},
		"unknown flag":     {args: []string{"--nope"}},
		"all interfaces":   {args: []string{"--bind", "0.0.0.0"}},
		"a network host":   {env: map[string]string{"MABARI_BIND": "192.168.1.24"}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Load(tc.args, env(tc.env), io.Discard); err == nil {
				t.Error("expected an error")
			}
		})
	}
}

func TestPrintableNamesTheKeyFileButNeverItsContents(t *testing.T) {
	cfg := load(t, nil, map[string]string{"MABARI_MASTER_KEY_FILE": "/run/secrets/mabari_master_key"})
	printed := cfg.Printable()
	if !strings.Contains(printed, "master_key_file=/run/secrets/mabari_master_key") {
		t.Errorf("Printable() = %q", printed)
	}
	if strings.Contains(load(t, nil, nil).Printable(), "master_key_file=\n") {
		t.Error("an unset key file should read as (not set)")
	}
}
