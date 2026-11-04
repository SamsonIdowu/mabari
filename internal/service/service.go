// SPDX-License-Identifier: Apache-2.0

// Package service runs Mabari at login as the logged-in user: a LaunchAgent on macOS, a systemd
// user unit on Linux and a per-user scheduled task on Windows. Each writes one file, shown before
// it is written, and uninstalling removes only that file.
package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"unicode/utf16"
)

// Marker is in every file install writes, so uninstall never removes a file it didn't write.
const Marker = "Managed by mabari service install"

// Runner runs a system tool such as launchctl and returns what it printed. Tests replace it.
type Runner func(ctx context.Context, name string, args ...string) (string, error)

// Exec runs the tool for real, with no shell.
func Exec(ctx context.Context, name string, args ...string) (string, error) {
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput() // #nosec G204 -- fixed system tools
	return strings.TrimSpace(string(out)), err
}

// Service describes one install of Mabari as a login service.
type Service struct {
	// OS is runtime.GOOS: darwin, linux or windows.
	OS string
	// Home is the user's home folder. AppData is %APPDATA% on Windows. ConfigHome is
	// $XDG_CONFIG_HOME on Linux, or empty for ~/.config.
	Home, AppData, ConfigHome string
	// UID is the user's id, for launchctl's gui/<uid> domain.
	UID int
	// Binary is the absolute path of the mabari to run.
	Binary string
	// Env is passed to Mabari: PATH, so it finds git, codex and whisper-cli, and the MABARI_
	// settings in use when it was installed. Never a secret.
	Env [][2]string
	// Label names the service. Empty means dev.mabari, or Mabari for the Windows task.
	Label string
	Run   Runner
}

// File is what install writes.
type File struct {
	Path    string
	Content []byte
	// Show is the content as the person reads it. It differs from Content only on Windows,
	// where the file is UTF-16.
	Show string
}

// Status is how the service stands.
type Status struct {
	Supported bool   `json:"supported"`
	Installed bool   `json:"installed"`
	Running   bool   `json:"running"`
	Detail    string `json:"detail"`
}

// ErrUnsupported means this system has no login service Mabari knows how to make.
var ErrUnsupported = errors.New("running at login isn't supported on this system")

// Passed lists the settings copied into the service. MABARI_MASTER_KEY is left out on purpose:
// the service file is plain text, so the key must come from MABARI_MASTER_KEY_FILE instead.
var Passed = []string{"MABARI_PORT", "MABARI_DATA_DIR", "MABARI_SECRETS", "MABARI_MASTER_KEY_FILE", "MABARI_LOG_LEVEL"}

// Environment picks what to pass to the service from the current environment.
func Environment(getenv func(string) string) [][2]string {
	env := [][2]string{{"PATH", getenv("PATH")}}
	for _, key := range Passed {
		if value := getenv(key); value != "" {
			env = append(env, [2]string{key, value})
		}
	}
	return env
}

func (s Service) label() string {
	if s.Label != "" {
		return s.Label
	}
	if s.OS == "windows" {
		return "Mabari"
	}
	return "dev.mabari"
}

// LogPath is where the service writes its log.
func (s Service) LogPath() string {
	if s.OS == "windows" {
		return filepath.Join(s.AppData, "Mabari", "logs", "mabari.log")
	}
	return filepath.Join(s.Home, ".mabari", "logs", "mabari.log")
}

// File returns what install would write, without writing it.
func (s Service) File() (File, error) {
	if !absolute(s.OS, s.Binary) {
		return File{}, fmt.Errorf("the mabari path must be absolute, got %q", s.Binary)
	}
	switch s.OS {
	case "darwin":
		text := launchAgent(s.label(), s.Binary, s.LogPath(), s.Env)
		return File{Path: filepath.Join(s.Home, "Library", "LaunchAgents", s.label()+".plist"), Content: []byte(text), Show: text}, nil
	case "linux":
		config := s.ConfigHome
		if config == "" {
			config = filepath.Join(s.Home, ".config")
		}
		text := systemdUnit(s.Binary, s.LogPath(), s.Env)
		return File{Path: filepath.Join(config, "systemd", "user", s.unitName()), Content: []byte(text), Show: text}, nil
	case "windows":
		text := windowsTask(s.Binary, s.LogPath(), s.Env)
		return File{Path: filepath.Join(s.AppData, "Mabari", "mabari-task.xml"), Content: utf16File(text), Show: text}, nil
	default:
		return File{}, ErrUnsupported
	}
}

// absolute checks the path by the target system's rules, so tests can describe any system.
func absolute(goos, path string) bool {
	if goos == "windows" {
		return len(path) > 2 && path[1] == ':' && (path[2] == '\\' || path[2] == '/') || strings.HasPrefix(path, `\\`)
	}
	return strings.HasPrefix(path, "/")
}

func (s Service) unitName() string {
	if s.Label != "" {
		return s.Label + ".service"
	}
	return "mabari.service"
}

func (s Service) domain() string { return fmt.Sprintf("gui/%d", s.UID) }

// Enable writes the file and registers it to start at login. With startNow it also starts
// Mabari straight away; without, as when Settings turns it on, the running Mabari carries on.
func (s Service) Enable(ctx context.Context, startNow bool) error {
	file, err := s.File()
	if err != nil {
		return err
	}
	if err := write(file); err != nil {
		return err
	}
	switch s.OS {
	case "darwin":
		if !startNow {
			return nil // launchd loads ~/Library/LaunchAgents at the next login
		}
		_, _ = s.Run(ctx, "launchctl", "bootout", s.domain()+"/"+s.label())
		return s.run(ctx, "launchctl", "bootstrap", s.domain(), file.Path)
	case "linux":
		if err := s.run(ctx, "systemctl", "--user", "daemon-reload"); err != nil {
			return err
		}
		if startNow {
			return s.run(ctx, "systemctl", "--user", "enable", "--now", s.unitName())
		}
		return s.run(ctx, "systemctl", "--user", "enable", s.unitName())
	default: // windows
		if err := s.run(ctx, "schtasks", "/Create", "/TN", s.label(), "/XML", file.Path, "/F"); err != nil {
			return err
		}
		if startNow {
			return s.run(ctx, "schtasks", "/Run", "/TN", s.label())
		}
		return nil
	}
}

// Disable stops Mabari starting at login and removes the file. With stopNow it also stops the
// running service; without, as when Settings turns it off, Mabari keeps running until it quits.
func (s Service) Disable(ctx context.Context, stopNow bool) error {
	file, err := s.File()
	if err != nil {
		return err
	}
	switch s.OS {
	case "darwin":
		if stopNow {
			_, _ = s.Run(ctx, "launchctl", "bootout", s.domain()+"/"+s.label())
		}
	case "linux":
		args := []string{"--user", "disable", s.unitName()}
		if stopNow {
			args = []string{"--user", "disable", "--now", s.unitName()}
		}
		_, _ = s.Run(ctx, "systemctl", args...)
	default:
		if stopNow {
			_, _ = s.Run(ctx, "schtasks", "/End", "/TN", s.label())
		}
		_, _ = s.Run(ctx, "schtasks", "/Delete", "/TN", s.label(), "/F")
	}
	if err := remove(file.Path); err != nil {
		return err
	}
	if s.OS == "linux" {
		_, _ = s.Run(ctx, "systemctl", "--user", "daemon-reload")
	}
	return nil
}

// Start, Stop and Restart act on an installed service.
func (s Service) Start(ctx context.Context) error {
	if err := s.need(); err != nil {
		return err
	}
	switch s.OS {
	case "darwin":
		return s.run(ctx, "launchctl", "kickstart", s.domain()+"/"+s.label())
	case "linux":
		return s.run(ctx, "systemctl", "--user", "start", s.unitName())
	default:
		return s.run(ctx, "schtasks", "/Run", "/TN", s.label())
	}
}

// Stop ends the running service. It starts again at the next login.
func (s Service) Stop(ctx context.Context) error {
	if err := s.need(); err != nil {
		return err
	}
	switch s.OS {
	case "darwin":
		// A clean exit isn't restarted, because KeepAlive only restarts after a crash.
		return s.run(ctx, "launchctl", "kill", "SIGTERM", s.domain()+"/"+s.label())
	case "linux":
		return s.run(ctx, "systemctl", "--user", "stop", s.unitName())
	default:
		return s.run(ctx, "schtasks", "/End", "/TN", s.label())
	}
}

// Restart stops and starts the service, as package upgrades do.
func (s Service) Restart(ctx context.Context) error {
	if err := s.need(); err != nil {
		return err
	}
	switch s.OS {
	case "darwin":
		return s.run(ctx, "launchctl", "kickstart", "-k", s.domain()+"/"+s.label())
	case "linux":
		return s.run(ctx, "systemctl", "--user", "restart", s.unitName())
	default:
		_, _ = s.Run(ctx, "schtasks", "/End", "/TN", s.label())
		return s.run(ctx, "schtasks", "/Run", "/TN", s.label())
	}
}

// Status says whether the service is installed and running.
func (s Service) Status(ctx context.Context) Status {
	file, err := s.File()
	if err != nil {
		return Status{Detail: err.Error()}
	}
	status := Status{Supported: true, Installed: ours(file.Path)}
	if !status.Installed {
		status.Detail = "Not installed"
		return status
	}
	var out string
	switch s.OS {
	case "darwin":
		out, err = s.Run(ctx, "launchctl", "print", s.domain()+"/"+s.label())
		status.Running = err == nil && strings.Contains(out, "state = running")
	case "linux":
		out, err = s.Run(ctx, "systemctl", "--user", "is-active", s.unitName())
		status.Running = err == nil && strings.TrimSpace(out) == "active"
	default:
		out, err = s.Run(ctx, "schtasks", "/Query", "/TN", s.label(), "/FO", "LIST")
		status.Running = err == nil && strings.Contains(out, "Running")
	}
	if status.Running {
		status.Detail = "Installed and running"
	} else {
		status.Detail = "Installed, not running"
	}
	return status
}

func (s Service) need() error {
	file, err := s.File()
	if err != nil {
		return err
	}
	if !ours(file.Path) {
		return errors.New("Mabari isn't installed as a service. Run mabari service install first")
	}
	return nil
}

func (s Service) run(ctx context.Context, name string, args ...string) error {
	out, err := s.Run(ctx, name, args...)
	if err != nil {
		if out != "" {
			return fmt.Errorf("%s %s: %w: %s", name, args[0], err, out)
		}
		return fmt.Errorf("%s %s: %w", name, args[0], err)
	}
	return nil
}

// ours reports whether the file at path was written by install.
func ours(path string) bool {
	content, err := os.ReadFile(path) // #nosec G304 -- the service's own fixed path
	if err != nil {
		return false
	}
	return strings.Contains(string(content), Marker) || strings.Contains(fromUTF16(content), Marker)
}

// write puts the file in place. Someone else's file at the same path is kept as .backup first.
func write(file File) error {
	if err := os.MkdirAll(filepath.Dir(file.Path), 0o700); err != nil {
		return err
	}
	if _, err := os.Stat(file.Path); err == nil && !ours(file.Path) {
		if err := os.Rename(file.Path, file.Path+".backup"); err != nil {
			return fmt.Errorf("back up %s: %w", file.Path, err)
		}
	}
	return os.WriteFile(file.Path, file.Content, 0o600)
}

// remove deletes the file only if install wrote it, and puts back a backup it made.
func remove(path string) error {
	if !ours(path) {
		return nil
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	if _, err := os.Stat(path + ".backup"); err == nil {
		return os.Rename(path+".backup", path)
	}
	return nil
}

func utf16File(text string) []byte {
	var out bytes.Buffer
	out.Write([]byte{0xFF, 0xFE})
	for _, unit := range utf16.Encode([]rune(text)) {
		out.WriteByte(byte(unit))
		out.WriteByte(byte(unit >> 8))
	}
	return out.Bytes()
}

func fromUTF16(content []byte) string {
	if len(content) < 2 || content[0] != 0xFF || content[1] != 0xFE {
		return ""
	}
	units := make([]uint16, 0, len(content)/2)
	for i := 2; i+1 < len(content); i += 2 {
		units = append(units, uint16(content[i])|uint16(content[i+1])<<8)
	}
	return string(utf16.Decode(units))
}
