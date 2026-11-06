// SPDX-License-Identifier: Apache-2.0

package launch

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// An agent file's name goes in as its own argument, and the prompt still comes after "--".
func TestArgsRunAsAnAgentFile(t *testing.T) {
	got := strings.Join(Args(Request{Name: "Shop", Agent: "planner", Prompt: "-x"}), " ")
	if got != "claude --name Shop --agent planner -- -x" {
		t.Errorf("args = %q", got)
	}
}

func TestArgs(t *testing.T) {
	got := Args(Request{Folder: "/x", Name: "Shop", Prompt: "Hi there", Plan: true})
	want := []string{"claude", "--name", "Shop", "--permission-mode", "plan", "--", "Hi there"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("args = %q", got)
	}
	if got := Args(Request{Folder: "/x"}); len(got) != 1 || got[0] != "claude" {
		t.Errorf("bare = %q", got)
	}
}

// Every part of the line is quoted, so a folder or prompt can never run its own commands.
func TestShellLineQuotesEverything(t *testing.T) {
	line := ShellLine(Request{Folder: "/tmp/it's here", Prompt: "$(rm -rf ~); `x` \"y\""})
	want := `cd '/tmp/it'\''s here' && 'claude' '--' '$(rm -rf ~); ` + "`x`" + ` "y"'`
	if line != want {
		t.Errorf("line = %s\nwant = %s", line, want)
	}
	// A shell reads it back as exactly the words that went in.
	out, err := exec.Command("sh", "-c", "printf '%s\\n' "+ShellQuote("a'b $(c)")).Output()
	if err != nil || string(out) != "a'b $(c)\n" {
		t.Errorf("round trip = %q, %v", out, err)
	}
}

// A prompt that looks like a flag stays the prompt.
func TestAPromptIsNeverAFlag(t *testing.T) {
	args := Args(Request{Prompt: "--dangerously-skip-permissions"})
	if strings.Join(args, "|") != "claude|--|--dangerously-skip-permissions" {
		t.Errorf("args = %q", args)
	}
}

func TestCommandPerSystem(t *testing.T) {
	request := Request{Folder: "/w", Prompt: `say "hi" \ bye`}
	none := func(string) (string, error) { return "", errors.New("missing") }
	// On macOS Terminal is given only "sh <script>": nothing from the request is typed into it.
	mac := Command(context.Background(), "darwin", none, request, "/tmp/mabari-claude-1.sh")
	if mac == nil || mac.Args[0] != "osascript" || !strings.Contains(mac.Args[2], `do script "sh '/tmp/mabari-claude-1.sh'"`) ||
		strings.Contains(mac.Args[2], "hi") {
		t.Errorf("darwin = %q", mac.Args)
	}
	gnome := Command(context.Background(), "linux", func(name string) (string, error) {
		if name == "gnome-terminal" {
			return "/usr/bin/gnome-terminal", nil
		}
		return "", errors.New("missing")
	}, request, "")
	if gnome == nil || gnome.Args[0] != "gnome-terminal" || strings.Join(gnome.Args[1:], "|") != "--working-directory=/w|--|claude|--|"+request.Prompt {
		t.Errorf("gnome = %q", gnome.Args)
	}
	if Command(context.Background(), "linux", none, request, "") != nil || Command(context.Background(), "windows", none, request, "") != nil {
		t.Error("a command with no terminal")
	}
}

// The script runs the quoted line, then is gone.
func TestTheScriptRunsTheSessionAndDeletesItself(t *testing.T) {
	path, err := script(Request{Folder: "/tmp", Prompt: "hi\u0003 there"})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path) // #nosec G304 -- the script just written
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(data), "rm -f -- '"+path+"'\n") || !strings.Contains(string(data), "'claude' '--' 'hi\u0003 there'") {
		t.Errorf("script = %q", data)
	}
	_ = os.Remove(path)
}

func TestSlashCommands(t *testing.T) {
	for text, want := range map[string]string{
		"/ux-audit https://x.io/a": "ux-audit|https://x.io/a",
		"/review":                  "review|",
		"/plugin:cmd a\nb":         "plugin:cmd|a\nb",
		"/Users/me/shop is broken": "",
		"/ nothing":                "",
		"fix /etc/hosts":           "",
	} {
		name, args, ok := SlashCommand(text)
		got := ""
		if ok {
			got = name + "|" + args
		}
		if got != want {
			t.Errorf("%q = %q", text, got)
		}
	}
}

// The command is run by hand, so it reads plainly, and is quoted only where a shell needs it.
func TestContinueCommand(t *testing.T) {
	const session = "550e8400-e29b-41d4-a716-446655440000"
	if got := ContinueCommand("/Users/me/shop", session); got != "cd /Users/me/shop && claude --resume "+session {
		t.Errorf("command = %q", got)
	}
	if got := ContinueCommand("/Users/me/my shop", session); got != "cd '/Users/me/my shop' && claude --resume "+session {
		t.Errorf("command = %q", got)
	}
	if got := ContinueCommand("/x/$(rm -rf ~)", "a;b"); got != `cd '/x/$(rm -rf ~)' && claude --resume 'a;b'` {
		t.Errorf("command = %q", got)
	}
}

func TestASessionIdThatIsAFlagHasNoContinueCommand(t *testing.T) {
	for _, session := range []string{"--dangerously-skip-permissions", "-p", "-"} {
		if got := ContinueCommand("/Users/me/shop", session); got != "" {
			t.Errorf("%q = %q", session, got)
		}
	}
}

func TestOnlyAUUIDIsASessionId(t *testing.T) {
	for _, id := range []string{"550e8400-e29b-41d4-a716-446655440000", "550E8400-E29B-41D4-A716-446655440000"} {
		if !ValidSession(id) {
			t.Errorf("%q was refused", id)
		}
	}
	for _, id := range []string{
		"", "abc123", "--dangerously-skip-permissions", "-550e8400-e29b-41d4-a716-446655440000",
		"550e8400-e29b-41d4-a716-446655440000\n", "550e8400-e29b-41d4-a716-44665544000g",
		"550e8400e29b41d4a716446655440000", "../../550e8400-e29b-41d4-a716-446655440000",
	} {
		if ValidSession(id) {
			t.Errorf("%q was accepted", id)
		}
	}
}

func TestATerminalGetsNothingOfMabaris(t *testing.T) {
	t.Setenv("MABARI_MASTER_KEY", "a-key-the-session-must-never-see")
	cmd := Command(context.Background(), "darwin", nil, Request{Folder: "/x"}, "/tmp/s.sh")
	if cmd == nil || cmd.Env == nil {
		t.Fatalf("cmd = %+v", cmd)
	}
	for _, entry := range cmd.Env {
		if strings.HasPrefix(entry, "MABARI_") {
			t.Fatalf("env has %q", entry)
		}
	}
}
