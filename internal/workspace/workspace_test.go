// SPDX-License-Identifier: Apache-2.0

package workspace

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestPathsAreCleanedAndChecked(t *testing.T) {
	cases := map[string]string{
		`  "~/code/shop/"  `:          "~/code/shop",
		"file:///Users/me/My%20Shop/": "/Users/me/My Shop",
		"file://localhost/srv/app":    "/srv/app",
		`'C:\code\shop'`:              `C:\code\shop`,
		"/":                           "/",
	}
	for in, want := range cases {
		if got := Clean(in); got != want {
			t.Errorf("Clean(%q) = %q, want %q", in, got, want)
		}
	}
	for value, want := range map[string]bool{
		"~/code/shop": true, "/srv/app": true, `C:\code`: true, "code/shop": false, "": false,
		"https://github.com/you/shop": false,
	} {
		if Valid(value, false) != want {
			t.Errorf("Valid(%q) = %v", value, !want)
		}
	}
	if !Valid("https://github.com/you/shop", true) || !Valid("git@github.com:you/shop.git", true) {
		t.Error("Git URLs are refused where they are allowed")
	}
}

func TestOnlyPlainGitURLsAndBranches(t *testing.T) {
	good := []string{"https://github.com/you/shop", "https://github.com/you/shop.git", "git@github.com:you/shop.git",
		"https://git.example.com:8443/team/app"}
	bad := []string{"http://github.com/you/shop", "ext::sh -c touch% /tmp/pwned", "--upload-pack=touch /tmp/x",
		"file:///etc", "https://github.com/you/shop;rm -rf ~", "https://github.com/../etc", "git@github.com:-oProxyCommand=x",
		"https://user:pass@github.com/you/shop", "/srv/repo", "https://github.com/you/shop name"}
	for _, raw := range good {
		if err := CheckGitURL(raw); err != nil {
			t.Errorf("%s refused: %v", raw, err)
		}
	}
	for _, raw := range bad {
		if err := CheckGitURL(raw); err == nil {
			t.Errorf("%s accepted", raw)
		}
	}
	for branch, ok := range map[string]bool{"main": true, "feature/login": true, "": true, "-x": false,
		"a..b": false, "x.lock": false, "has space": false} {
		if (CheckBranch(branch) == nil) != ok {
			t.Errorf("branch %q", branch)
		}
	}
	if RepoName("git@github.com:you/coffee-shop.git") != "coffee-shop" || RepoName("https://x.dev/a/b/") != "b" {
		t.Error("repo names")
	}
}

func TestLookFindsProjectFilesAndInstructions(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{
		"go.mod": "module x", "CLAUDE.md": "# How we work\n- Run the tests.", "main.go": "package main",
		"node_modules/a/index.js": "x", ".git/HEAD": "ref",
	} {
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	scan, err := Look(dir)
	if err != nil {
		t.Fatal(err)
	}
	if scan.Lang != "Go" || scan.Count != 3 || scan.InstructionsFrom != "CLAUDE.md" ||
		!strings.Contains(scan.Instructions, "Run the tests") {
		t.Errorf("scan = %+v", scan)
	}
	if _, err := Look(filepath.Join(dir, "missing")); err == nil {
		t.Error("a missing folder was accepted")
	}
	if _, err := Look(filepath.Join(dir, "go.mod")); err == nil {
		t.Error("a file was accepted as a folder")
	}
}

func TestCloneRefusesBadInputBeforeRunningGit(t *testing.T) {
	dest := filepath.Join(t.TempDir(), "x")
	if err := Clone(context.Background(), "--upload-pack=touch /tmp/x", "", dest); err == nil {
		t.Error("an option was cloned")
	}
	if err := Clone(context.Background(), "https://github.com/you/shop", "-x", dest); err == nil {
		t.Error("a bad branch was cloned")
	}
	existing := t.TempDir()
	if err := Clone(context.Background(), "https://github.com/you/shop", "main", existing); err == nil {
		t.Error("cloned over an existing folder")
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git isn't installed")
	}
}

func TestRecentFolders(t *testing.T) {
	recent := Remember([]string{"~/a", "~/b"}, "~/b")
	if strings.Join(recent, ",") != "~/b,~/a" {
		t.Errorf("recent = %v", recent)
	}
	if got := Remember(recent, "https://github.com/x/y"); len(got) != 2 {
		t.Error("a URL was kept as a folder")
	}
	for index := range 12 {
		recent = Remember(recent, "~/f"+string(rune('a'+index)))
	}
	if len(recent) != maxRecent {
		t.Errorf("%d kept", len(recent))
	}
}

func TestLookListsTheFoldersAgents(t *testing.T) {
	dir := t.TempDir()
	agents := filepath.Join(dir, ".claude", "agents")
	if err := os.MkdirAll(agents, 0o750); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"billing.md", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(agents, name), []byte("---\nname: x\n---\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	scan, err := Look(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(scan.Agents) != 1 || scan.Agents[0] != "billing" {
		t.Errorf("agents = %v", scan.Agents)
	}
}
