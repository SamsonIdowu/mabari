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
