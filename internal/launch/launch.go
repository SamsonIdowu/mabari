// SPDX-License-Identifier: Apache-2.0

// Package launch opens Claude Code in a project's folder, in a new terminal window on this
// computer, so the person has a real interactive session they can watch and type in. Mabari's
// hooks in Claude Code's settings report the session to the office, where it takes a desk and
// joins its project by its folder.
//
// Checked against Claude Code 2.1.318 (`claude --help`): `claude [prompt]` starts an
// interactive session with a first prompt, `--permission-mode plan` starts in plan mode, and
// `--name` sets the session's display name.
package launch

import (
	"context"
	"errors"
	"os/exec"
	"runtime"
	"strings"
)

// Request is one Claude Code session to open.
type Request struct {
	// Folder is the absolute folder the session works in.
	Folder string
	// Name is the session's display name, such as the project's name.
	Name string
	// Prompt is the first thing Claude is asked.
	Prompt string
	// Plan starts the session in plan mode, so it proposes before it changes anything.
	Plan bool
}

// ErrNoTerminal means this computer has no terminal Mabari knows how to open, as in Docker.
var ErrNoTerminal = errors.New("no terminal to open Claude Code in")

// Launcher opens Claude Code sessions. Tests replace it.
type Launcher interface {
	Claude(ctx context.Context, request Request) error
}

// Terminal opens a new terminal window with Claude Code running in the folder.
type Terminal struct{}

// Args is the claude command line for a request. Each argument is passed on its own, never
// through a shell, except where a terminal needs one line, and then every part is quoted.
func Args(request Request) []string {
	args := []string{"claude"}
	if request.Name != "" {
		args = append(args, "--name", request.Name)
	}
	if request.Plan {
		args = append(args, "--permission-mode", "plan")
	}
	if request.Prompt != "" {
		// "--" ends the options, so a prompt that starts with a dash is never read as a flag.
		args = append(args, "--", request.Prompt)
	}
	return args
}

// ShellQuote quotes one word for a POSIX shell: in single quotes, with each single quote closed,
// escaped and reopened, so nothing in it is ever read as shell syntax.
func ShellQuote(word string) string {
	return "'" + strings.ReplaceAll(word, "'", `'\''`) + "'"
}

// ShellLine is the command a terminal runs: change to the folder, then run claude.
func ShellLine(request Request) string {
	quoted := make([]string, 0, 8)
	for _, arg := range Args(request) {
		quoted = append(quoted, ShellQuote(arg))
	}
	return "cd " + ShellQuote(request.Folder) + " && " + strings.Join(quoted, " ")
}

// appleScriptString quotes text for AppleScript: backslashes and double quotes are escaped.
func appleScriptString(text string) string {
	return `"` + strings.ReplaceAll(strings.ReplaceAll(text, `\`, `\\`), `"`, `\"`) + `"`
}

// Command is how this computer opens the session, or nil when it can't. The program is always a
// fixed name (osascript, or a terminal found on PATH by its fixed name), never taken from a
// request. A request's folder, name and prompt only travel as separate arguments, or shell quoted
// where a terminal needs one line, and the prompt follows "--", so none of them can run a command
// or add a flag.
func Command(ctx context.Context, goos string, lookPath func(string) (string, error), request Request) *exec.Cmd {
	switch goos {
	case "darwin":
		script := "tell application \"Terminal\"\nactivate\ndo script " + appleScriptString(ShellLine(request)) + "\nend tell"
		return exec.CommandContext(ctx, "osascript", "-e", script) // #nosec G204 -- fixed program; the line is quoted for the shell and AppleScript
	case "linux":
		if path, err := lookPath("gnome-terminal"); err == nil {
			args := append([]string{"--working-directory=" + request.Folder, "--"}, Args(request)...)
			return exec.CommandContext(ctx, path, args...) // #nosec G204 nosemgrep -- fixed program, exec form, no shell
		}
		if path, err := lookPath("konsole"); err == nil {
			args := append([]string{"--workdir", request.Folder, "-e"}, Args(request)...)
			return exec.CommandContext(ctx, path, args...) // #nosec G204 nosemgrep -- fixed program, exec form, no shell
		}
		if path, err := lookPath("x-terminal-emulator"); err == nil {
			return exec.CommandContext(ctx, path, "-e", "sh", "-c", ShellLine(request)) // #nosec G204 nosemgrep -- fixed program; every part is shell quoted
		}
	}
	return nil
}

// Claude opens a terminal window running Claude Code in the request's folder.
func (Terminal) Claude(ctx context.Context, request Request) error {
	cmd := Command(ctx, runtime.GOOS, exec.LookPath, request)
	if cmd == nil {
		return ErrNoTerminal
	}
	return cmd.Run()
}
