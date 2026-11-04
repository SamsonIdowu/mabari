// SPDX-License-Identifier: Apache-2.0

// Package config resolves settings from flags, then the environment, then defaults.
package config

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
)

// Defaults for a desktop install. Mabari only answers on this computer unless told otherwise.
const (
	DefaultBind    = "127.0.0.1"
	DefaultPort    = 4317
	DefaultSecrets = "keychain"
	DefaultLog     = "info"
)

// Config is the resolved configuration for `mabari serve`.
type Config struct {
	Bind          string
	Port          int
	DataDir       string
	Secrets       string
	MasterKeyFile string
	LogLevel      string
	PrintConfig   bool
}

// Address is the host and port to listen on.
func (c Config) Address() string {
	return net.JoinHostPort(c.Bind, strconv.Itoa(c.Port))
}

// Printable shows the configuration for --print-config. It names the key file but never reads
// it, so no secret value can appear here.
func (c Config) Printable() string {
	keyFile := "(not set)"
	if c.MasterKeyFile != "" {
		keyFile = c.MasterKeyFile
	}
	return fmt.Sprintf(
		"bind=%s\nport=%d\ndata_dir=%s\nsecrets=%s\nmaster_key_file=%s\nlog_level=%s\n",
		c.Bind, c.Port, c.DataDir, c.Secrets, keyFile, c.LogLevel,
	)
}

// Load resolves the configuration. getenv is passed in so tests never read the real environment.
func Load(args []string, getenv func(string) string, output io.Writer) (Config, error) {
	cfg := Config{
		Bind:          orDefault(getenv("MABARI_BIND"), DefaultBind),
		Port:          DefaultPort,
		DataDir:       orDefault(getenv("MABARI_DATA_DIR"), defaultDataDir(getenv)),
		Secrets:       orDefault(getenv("MABARI_SECRETS"), DefaultSecrets),
		MasterKeyFile: getenv("MABARI_MASTER_KEY_FILE"),
		LogLevel:      orDefault(getenv("MABARI_LOG_LEVEL"), DefaultLog),
	}
	if raw := getenv("MABARI_PORT"); raw != "" {
		port, err := strconv.Atoi(raw)
		if err != nil {
			return Config{}, fmt.Errorf("MABARI_PORT must be a number, got %q", raw)
		}
		cfg.Port = port
	}

	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(output)
	flags.StringVar(&cfg.Bind, "bind", cfg.Bind, "address to listen on")
	flags.IntVar(&cfg.Port, "port", cfg.Port, "port to listen on")
	flags.StringVar(&cfg.DataDir, "data-dir", cfg.DataDir, "where Mabari keeps its data")
	flags.StringVar(&cfg.LogLevel, "log-level", cfg.LogLevel, "debug, info, warn or error")
	flags.BoolVar(&cfg.PrintConfig, "print-config", false, "print the configuration and exit")
	if err := flags.Parse(args); err != nil {
		return Config{}, err
	}

	if cfg.Port < 1 || cfg.Port > 65535 {
		return Config{}, fmt.Errorf("port must be between 1 and 65535, got %d", cfg.Port)
	}
	if cfg.Secrets != "keychain" && cfg.Secrets != "encrypted-file" {
		return Config{}, errors.New(`MABARI_SECRETS must be "keychain" or "encrypted-file"`)
	}
	return cfg, nil
}

func orDefault(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

func defaultDataDir(getenv func(string) string) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(getenv("APPDATA"), "Mabari")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".mabari"
	}
	return filepath.Join(home, ".mabari")
}
