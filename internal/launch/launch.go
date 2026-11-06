// SPDX-License-Identifier: Apache-2.0

// Package launch opens Claude Code in a project's folder, in a new terminal window on this
// computer, so the person has a real interactive session they can watch and type in. Mabari's
// hooks in Claude Code's settings report the session to the office, where it takes a desk and
// joins its project by its folder.
//
// Checked against Claude Code 2.1.318 (`claude --help`): `claude [prompt]` starts an
// interactive session with a first prompt, `--permission-mode plan` starts in plan mode, and
// `--name` sets the session's display name, and `--agent <agent>` runs one of the agents
// from ~/.claude/agents or the project's .claude/agents as the session's main agent.
package launch

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/secrets"
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
	// Agent is the agent file the session runs as, by name, or empty for Claude Code's own.
	Agent string
}

// slashCommand is a Claude Code command or skill at the start of a message, such as /ux-audit or
// /plugin:command. A path such as /Users/me/shop is not one: a command name has no slash in it.
var slashCommand = regexp.MustCompile(`^/([A-Za-z0-9][A-Za-z0-9:_.-]*)(?:\s+([\s\S]*))?$`)

// SlashCommand splits a message that is a slash command into the command's name and what follows.
func SlashCommand(text string) (name, args string, ok bool) {
	match := slashCommand.FindStringSubmatch(strings.TrimSpace(text))
	if match == nil {
		return "", "", false
	}
	return match[1], strings.TrimSpace(match[2]), true
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
	if request.Agent != "" {
		args = append(args, "--agent", request.Agent)
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

// shellSafe matches a word a shell reads as it is, so it needs no quotes.
var shellSafe = regexp.MustCompile(`^[A-Za-z0-9_./:=@%+,-]+$`)

func shellWord(word string) string {
	if shellSafe.MatchString(word) {
		return word
	}
	return ShellQuote(word)
}

// sessionShape is what a Claude Code session id looks like: a UUID, which `--session-id` requires
// and every transcript is named with. The hook docs show "abc123", which is only a placeholder.
var sessionShape = regexp.MustCompile(`^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$`)

// ValidSession reports whether an id can be a Claude Code session's. It comes from a hook's input,
// and ends up on a command line, where anything else could be read as a flag.
func ValidSession(id string) bool { return sessionShape.MatchString(id) }

// ContinueCommand is the exact command that carries a session on in a terminal, or nothing for a
// session id that would be read as a flag, which quoting can't prevent.
func ContinueCommand(folder, session string) string {
	if strings.HasPrefix(session, "-") {
		return ""
	}
	return "cd " + shellWord(folder) + " && claude --resume " + shellWord(session)
}

// appleScriptString quotes text for AppleScript: backslashes and double quotes are escaped.
func appleScriptString(text string) string {
	return `"` + strings.ReplaceAll(strings.ReplaceAll(text, `\`, `\\`), `"`, `\"`) + `"`
}

// script is a shell script that runs the session and then deletes itself. On macOS Terminal types
// the command it is given into the new shell, where line editing would act on control keys in it,
// so Terminal is only ever given "sh <this file>", which has no text from the request in it.
func script(request Request) (string, error) {
	file, err := os.CreateTemp("", "mabari-claude-*.sh")
	if err != nil {
		return "", err
	}
	body := "rm -f -- " + ShellQuote(file.Name()) + "\n" + ShellLine(request) + "\n"
	if _, err := file.WriteString(body); err != nil {
		_ = file.Close()
		_ = os.Remove(file.Name())
		return "", err
	}
	if err := file.Close(); err != nil {
		return "", err
	}
	return file.Name(), nil
}

// Command is how this computer opens the session, or nil when it can't. On macOS, path is the
// script that runs it. The program is always a
// fixed name (osascript, or a terminal found on PATH by its fixed name), never taken from a
// request. A request's folder, name and prompt only travel as separate arguments, or shell quoted
// where a terminal needs one line, and the prompt follows "--", so none of them can run a command
// or add a flag.
func Command(ctx context.Context, goos string, lookPath func(string) (string, error), request Request, path string) *exec.Cmd {
	cmd := terminalCommand(ctx, goos, lookPath, request, path)
	if cmd != nil {
		cmd.Env = secrets.ChildEnv(os.Environ())
	}
	return cmd
}

func terminalCommand(ctx context.Context, goos string, lookPath func(string) (string, error), request Request, path string) *exec.Cmd {
	switch goos {
	case "darwin":
		line := "sh " + ShellQuote(path)
		apple := "tell application \"Terminal\"\nactivate\ndo script " + appleScriptString(line) + "\nend tell"
		return exec.CommandContext(ctx, "osascript", "-e", apple) // #nosec G204 -- fixed program; the line names only the script
	case "linux":
		// Each terminal is named literally; lookPath only checks it is installed, and exec finds it
		// on PATH the same way. Arguments go in exec form, so no shell reads them, except the
		// fallback's line, where every part is shell quoted.
		if _, err := lookPath("gnome-terminal"); err == nil {
			args := append([]string{"--working-directory=" + request.Folder, "--"}, Args(request)...)
			return exec.CommandContext(ctx, "gnome-terminal", args...) // #nosec G204 -- fixed program, exec form
		}
		if _, err := lookPath("konsole"); err == nil {
			args := append([]string{"--workdir", request.Folder, "-e"}, Args(request)...)
			return exec.CommandContext(ctx, "konsole", args...) // #nosec G204 -- fixed program, exec form
		}
		if _, err := lookPath("x-terminal-emulator"); err == nil {
			return exec.CommandContext(ctx, "x-terminal-emulator", "-e", "sh", "-c", ShellLine(request)) // #nosec G204 -- fixed program, quoted line
		}
	}
	return nil
}

// Claude opens a terminal window running Claude Code in the request's folder.
func (Terminal) Claude(ctx context.Context, request Request) error {
	path := ""
	if runtime.GOOS == "darwin" {
		var err error
		if path, err = script(request); err != nil {
			return err
		}
	}
	cmd := Command(ctx, runtime.GOOS, exec.LookPath, request, path)
	if cmd == nil {
		return ErrNoTerminal
	}
	if err := cmd.Run(); err != nil {
		if path != "" {
			_ = os.Remove(path)
		}
		return err
	}
	return nil
}
