// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var testHook = Hook{Binary: "/usr/local/bin/mabari", Port: 4317}

const existing = `{
  "model": "claude-sonnet-4-5",
  "permissions": {"allow": ["Bash(npm test)"]},
  "hooks": {
    "PreToolUse": [
      {"matcher": "Bash", "hooks": [{"type": "command", "command": "./check.sh"}]}
    ]
  },
  "theme": "dark"
}
`

func scratch(t *testing.T, settings string) string {
	t.Helper()
	dir := t.TempDir()
	if settings != "" {
		if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(settings), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func read(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestAttachKeepsEverythingAndBacksUp(t *testing.T) {
	dir := scratch(t, existing)
	plan, err := PlanAttach(dir, testHook)
	if err != nil {
		t.Fatal(err)
	}
	if err := Apply(plan); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "settings.json")
	if read(t, path+BackupSuffix) != existing {
		t.Error("the backup is not the original file")
	}
	after := read(t, path)
	// Other settings and the user's own hook stay, in their order.
	for _, want := range []string{`"model": "claude-sonnet-4-5"`, `"./check.sh"`, `"Bash(npm test)"`} {
		if !strings.Contains(after, want) {
			t.Errorf("lost %s", want)
		}
	}
	if strings.Index(after, `"model"`) > strings.Index(after, `"theme"`) {
		t.Error("keys were reordered")
	}
	var parsed struct {
		Hooks map[string][]struct {
			Matcher string `json:"matcher"`
			Hooks   []struct {
				Command string   `json:"command"`
				Args    []string `json:"args"`
				Timeout int      `json:"timeout"`
				Failure string   `json:"onFailure"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal([]byte(after), &parsed); err != nil {
		t.Fatal(err)
	}
	if len(parsed.Hooks) != len(hookEvents) {
		t.Errorf("%d events", len(parsed.Hooks))
	}
	pre := parsed.Hooks["PreToolUse"]
	if len(pre) != 2 || pre[0].Hooks[0].Command != "./check.sh" {
		t.Fatalf("PreToolUse = %+v", pre)
	}
	ours := pre[1].Hooks[0]
	if pre[1].Matcher != "*" || ours.Command != testHook.Binary ||
		strings.Join(ours.Args, " ") != "hook --port 4317 PreToolUse" || ours.Timeout != 5 {
		t.Errorf("our hook = %+v", pre[1])
	}
	// Mabari never makes a failed hook block Claude Code.
	for event, groups := range parsed.Hooks {
		for _, group := range groups {
			for _, handler := range group.Hooks {
				if handler.Failure != "" {
					t.Errorf("%s sets onFailure", event)
				}
			}
		}
	}
	if parsed.Hooks["PermissionRequest"][0].Hooks[0].Timeout <= PermissionWait {
		t.Error("the permission hook can time out before Mabari answers")
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o640 {
		t.Errorf("mode = %v", info.Mode().Perm())
	}
	if !Attached(dir) {
		t.Error("not reported as attached")
	}
}

func TestAttachTwiceChangesNothing(t *testing.T) {
	dir := scratch(t, existing)
	first, _ := PlanAttach(dir, testHook)
	if err := Apply(first); err != nil {
		t.Fatal(err)
	}
	second, err := PlanAttach(dir, testHook)
	if err != nil {
		t.Fatal(err)
	}
	if second.Changed() {
		t.Errorf("second attach changes:\n%s", second.After)
	}
}

func TestDetachRestoresTheOriginal(t *testing.T) {
	dir := scratch(t, existing)
	plan, _ := PlanAttach(dir, testHook)
	if err := Apply(plan); err != nil {
		t.Fatal(err)
	}
	detach, err := PlanDetach(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := Apply(detach); err != nil {
		t.Fatal(err)
	}
	after := read(t, filepath.Join(dir, "settings.json"))
	if after != existing {
		t.Errorf("the original bytes did not come back:\n%s", after)
	}
	var want, got any
	_ = json.Unmarshal([]byte(existing), &want)
	_ = json.Unmarshal([]byte(after), &got)
	if mustString(want) != mustString(got) {
		t.Errorf("after detach:\n%s", after)
	}
	if Attached(dir) {
		t.Error("still attached")
	}
}

// A change the user made while attached survives detaching.
func TestDetachKeepsLaterChanges(t *testing.T) {
	dir := scratch(t, existing)
	plan, _ := PlanAttach(dir, testHook)
	_ = Apply(plan)
	path := filepath.Join(dir, "settings.json")
	edited := strings.Replace(read(t, path), `"theme": "dark"`, `"theme": "light"`, 1)
	if err := os.WriteFile(path, []byte(edited), 0o640); err != nil {
		t.Fatal(err)
	}
	detach, _ := PlanDetach(dir)
	_ = Apply(detach)
	if !strings.Contains(read(t, path), `"theme": "light"`) {
		t.Error("the later change was lost")
	}
}

func TestAttachWithNoSettingsFile(t *testing.T) {
	dir := scratch(t, "")
	plan, err := PlanAttach(dir, testHook)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Existed || len(plan.Diff) == 0 || plan.Diff[0].Kind != "add" {
		t.Errorf("plan = %+v", plan.Diff[:1])
	}
	if err := Apply(plan); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "settings.json"+BackupSuffix)); err == nil {
		t.Error("a backup was made of a file that didn't exist")
	}
	if !Attached(dir) {
		t.Error("not attached")
	}
}

func TestInvalidSettingsAreRefused(t *testing.T) {
	for _, bad := range []string{`{"hooks": [}`, `[1,2]`, `{"hooks": "nope"}`} {
		if _, err := PlanAttach(scratch(t, bad), testHook); err == nil {
			t.Errorf("%s was accepted", bad)
		}
	}
}

func TestDiffShowsOnlyTheChange(t *testing.T) {
	before := []byte("a\nb\nc\nd\ne\nf\ng\nh\ni\n")
	after := []byte("a\nb\nc\nd\nNEW\ne\nf\ng\nh\ni\n")
	diff := Diff(before, after)
	var adds, dels int
	for _, line := range diff {
		switch line.Kind {
		case "add":
			adds++
		case "del":
			dels++
		}
	}
	if adds != 1 || dels != 0 || len(diff) > 9 {
		t.Errorf("diff = %+v", diff)
	}
}

func TestOnlyMabariHooksCountAsOurs(t *testing.T) {
	cases := map[string]bool{
		`{"command":"/opt/mabari","args":["hook","PreToolUse"]}`: true,
		`{"command":"C:\\mabari.exe","args":["hook","Stop"]}`:    true,
		`{"command":"/opt/mabari","args":["serve"]}`:             false,
		`{"command":"/opt/other","args":["hook","PreToolUse"]}`:  false,
		`{"command":"mabari hook PreToolUse"}`:                   false,
	}
	for handler, want := range cases {
		if got := isOurs(json.RawMessage(handler)); got != want {
			t.Errorf("%s = %v", handler, got)
		}
	}
}

func mustString(value any) string {
	data, _ := json.Marshal(value)
	return string(data)
}

func TestHookWithATokenFile(t *testing.T) {
	hook := Hook{Binary: "/usr/local/bin/mabari", Port: 4317, TokenFile: "/Users/a/.mabari/hook_token"}
	if got := strings.Join(hook.args("Stop"), " "); got != "hook --port 4317 --token-file /Users/a/.mabari/hook_token Stop" {
		t.Errorf("args = %q", got)
	}
	if got := strings.Join(Hook{Binary: "/m", Port: 9}.args("Stop"), " "); got != "hook --port 9 Stop" {
		t.Errorf("args = %q", got)
	}
}

func TestTokenFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "hook_token")
	if _, err := ReadTokenFile(path); err == nil {
		t.Error("read a missing file")
	}
	if err := EnsureTokenFile(path); err != nil {
		t.Fatal(err)
	}
	first, err := ReadTokenFile(path)
	if err != nil || !strings.HasPrefix(first, "mab_hook_") {
		t.Fatalf("token = %q %v", first, err)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v", info.Mode())
	}
	if err := EnsureTokenFile(path); err != nil {
		t.Fatal(err)
	}
	if again, _ := ReadTokenFile(path); again != first {
		t.Error("the token changed")
	}
	_ = os.WriteFile(path, []byte("short"), 0o600)
	if _, err := ReadTokenFile(path); err == nil {
		t.Error("a short token was accepted")
	}
}
