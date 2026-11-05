// SPDX-License-Identifier: Apache-2.0

package launch

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"
)

func TestArgs(t *testing.T) {
	got := Args(Request{Folder: "/x", Name: "Shop", Prompt: "Hi there", Plan: true})
	want := []string{"claude", "--name", "Shop", "--permission-mode", "plan", "Hi there"}
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
	want := `cd '/tmp/it'\''s here' && 'claude' '$(rm -rf ~); ` + "`x`" + ` "y"'`
	if line != want {
		t.Errorf("line = %s\nwant = %s", line, want)
	}
	// A shell reads it back as exactly the words that went in.
	out, err := exec.Command("sh", "-c", "printf '%s\\n' "+ShellQuote("a'b $(c)")).Output()
	if err != nil || string(out) != "a'b $(c)\n" {
		t.Errorf("round trip = %q, %v", out, err)
	}
}

func TestCommandPerSystem(t *testing.T) {
	request := Request{Folder: "/w", Prompt: `say "hi" \ bye`}
	none := func(string) (string, error) { return "", errors.New("missing") }
	mac := Command(context.Background(), "darwin", none, request)
	if mac == nil || mac.Args[0] != "osascript" || !strings.Contains(mac.Args[2], `do script "cd '/w' && 'claude' 'say \"hi\" \\ bye'"`) {
		t.Errorf("darwin = %q", mac.Args)
	}
	gnome := Command(context.Background(), "linux", func(name string) (string, error) {
		if name == "gnome-terminal" {
			return "/usr/bin/gnome-terminal", nil
		}
		return "", errors.New("missing")
	}, request)
	if gnome == nil || strings.Join(gnome.Args[1:], "|") != "--working-directory=/w|--|claude|"+request.Prompt {
		t.Errorf("gnome = %q", gnome.Args)
	}
	if Command(context.Background(), "linux", none, request) != nil || Command(context.Background(), "windows", none, request) != nil {
		t.Error("a command with no terminal")
	}
}
