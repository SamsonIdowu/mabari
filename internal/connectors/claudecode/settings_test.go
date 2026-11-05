// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"bytes"
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
		strings.Join(ours.Args, " ") != "hook --port 4317 PreToolUse" || ours.Timeout <= PermissionWait {
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
	// Claude's questions are answered in PreToolUse, so it waits as long; other events stay quick.
	if timeout := parsed.Hooks["PostToolUse"][0].Hooks[0].Timeout; timeout != 5 {
		t.Errorf("PostToolUse timeout = %d", timeout)
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
		`{"command":"/opt/mabari","args":["hook","--port","4317","PreToolUse"]}`: true,
		`{"command":"C:\\mabari.exe","args":["hook","--port","4317","Stop"]}`:    true,
		`{"command":"/opt/mabari","args":["serve"]}`:                             false,
		`{"command":"/opt/other","args":["hook","--port","4317","PreToolUse"]}`:  false,
		`{"command":"mabari hook PreToolUse"}`:                                   false,
		// A copy or wrapper of the binary under another name still starts with mabari, such as the
		// bin/mabari-run a login service runs.
		`{"command":"/code/mabari/bin/mabari-run","args":["hook","--port","4317","Stop"]}`: true,
		`{"command":"C:\\Mabari-Run.EXE","args":["hook","--port","4317","Stop"]}`:          true,
		`{"command":"/code/mabari/bin/mabari-run","args":["serve"]}`:                       false,
		`{"command":"/opt/mabari-notes/other","args":["hook","--port","4317","Stop"]}`:     false,
		// With a token file, which Mabari in Docker writes.
		`{"command":"/opt/mabari","args":["hook","--port","4317","--token-file","/h/hook_token","Stop"]}`: true,
	}
	for handler, want := range cases {
		if got := isOurs(json.RawMessage(handler)); got != want {
			t.Errorf("%s = %v", handler, got)
		}
	}
}

// A stranger's program whose name starts with mabari, and that takes "hook" as its first argument,
// is not Mabari's unless the rest of the command is Mabari's too: the port, the optional token
// file, and one of the events Mabari listens to. Anything less is left exactly as it is (rule 5).
func TestAStrangersMabariNamedHookIsNotOurs(t *testing.T) {
	strangers := []string{
		// The reviewer's example: a linter that happens to be called mabari-lint.
		`{"command":"/usr/local/bin/mabari-lint","args":["hook","pre-commit"]}`,
		`{"command":"/usr/local/bin/mabari-lint","args":["hook","Stop"]}`,
		`{"command":"/usr/local/bin/mabari-lint","args":["hook","--strict"]}`,
		`{"command":"/usr/local/bin/mabari","args":["hook"]}`,
		`{"command":"/usr/local/bin/mabari","args":["hook","--port","4317"]}`,
		`{"command":"/usr/local/bin/mabari","args":["hook","--port","abc","Stop"]}`,
		`{"command":"/usr/local/bin/mabari","args":["hook","--port","","Stop"]}`,
		`{"command":"/usr/local/bin/mabari","args":["hook","--port","-1","Stop"]}`,
		`{"command":"/usr/local/bin/mabari","args":["hook","--port","99999","Stop"]}`,
		`{"command":"/usr/local/bin/mabari","args":["hook","--port","4317","pre-commit"]}`,
		`{"command":"/usr/local/bin/mabari","args":["hook","--port","4317","stop"]}`,
		`{"command":"/usr/local/bin/mabari","args":["hook","--port","4317","--token-file","Stop"]}`,
		`{"command":"/usr/local/bin/mabari","args":["hook","--port","4317","--token-file","","Stop"]}`,
		`{"command":"/usr/local/bin/mabari","args":["hook","--port","4317","--other","x","Stop"]}`,
		`{"command":"/usr/local/bin/mabari","args":["hook","--port","4317","Stop","--extra"]}`,
		`{"command":"/usr/local/bin/mabari","args":["hook","--port","4317","Stop","Stop"]}`,
		`{"command":"/usr/local/bin/mabari","args":["hook","Stop","--port","4317"]}`,
	}
	for _, handler := range strangers {
		if isOurs(json.RawMessage(handler)) {
			t.Errorf("%s was taken for Mabari's", handler)
		}
		// Even the configured binary is not enough without the shape.
		var h struct{ Command string }
		_ = json.Unmarshal([]byte(handler), &h)
		if isOurs(json.RawMessage(handler), h.Command) {
			t.Errorf("%s was taken for Mabari's because its program was configured", handler)
		}
	}
}

// Every event Mabari registers is recognised, with and without a token file, so no hook it wrote
// can be left behind.
func TestEveryHookMabariWritesIsOurs(t *testing.T) {
	for _, hook := range []Hook{
		testHook, runHook, {Binary: "/usr/local/bin/mb", Port: 1},
		{Binary: "/usr/local/bin/mabari", Port: 65535, TokenFile: "/Users/a/.mabari/hook_token"},
	} {
		for _, event := range hookEvents {
			handler := mustJSON(map[string]any{"type": "command", "command": hook.Binary, "args": hook.args(event)})
			if !isOurs(handler, hook.Binary) {
				t.Errorf("%s %v was not recognised", hook.Binary, hook.args(event))
			}
		}
	}
}

// A binary that doesn't start with mabari is still Mabari's when it is the one configured.
func TestTheConfiguredBinaryIsOurs(t *testing.T) {
	handler := json.RawMessage(`{"command":"/usr/local/bin/mb","args":["hook","--port","4317","Stop"]}`)
	if isOurs(handler) {
		t.Error("an unknown binary was taken for Mabari's")
	}
	if !isOurs(handler, "/usr/local/bin/mb") {
		t.Error("the configured binary was not recognised")
	}
	if isOurs(json.RawMessage(`{"command":"/usr/local/bin/mb","args":["run"]}`), "/usr/local/bin/mb") {
		t.Error("the configured binary doing something else was taken for a hook")
	}
}

var runHook = Hook{Binary: "/code/mabari/bin/mabari-run", Port: 4317}

func countOurs(t *testing.T, path string) int {
	t.Helper()
	var settings struct {
		Hooks map[string][]struct {
			Hooks []json.RawMessage `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal([]byte(read(t, path)), &settings); err != nil {
		t.Fatal(err)
	}
	var ours int
	for _, groups := range settings.Hooks {
		for _, group := range groups {
			for _, handler := range group.Hooks {
				if isOurs(handler) {
					ours++
				}
			}
		}
	}
	return ours
}

// The login service runs bin/mabari-run, so that is the name written into settings.json. Attaching
// reports attached, attaching again changes nothing, and a detach gives back the original bytes.
func TestAttachWithABinaryNamedMabariRun(t *testing.T) {
	dir := scratch(t, existing)
	path := filepath.Join(dir, "settings.json")
	plan, err := PlanAttach(dir, runHook)
	if err != nil {
		t.Fatal(err)
	}
	if err := Apply(plan); err != nil {
		t.Fatal(err)
	}
	if !Attached(dir) {
		t.Fatal("hooks written by mabari-run are not reported as attached")
	}
	if !HookWaits(dir) {
		t.Error("the mabari-run hooks are called outdated")
	}
	if got := countOurs(t, path); got != len(hookEvents) {
		t.Fatalf("%d hooks after attaching, want %d", got, len(hookEvents))
	}
	again, err := PlanAttach(dir, runHook)
	if err != nil {
		t.Fatal(err)
	}
	if again.Changed() || len(again.Diff) != 0 {
		t.Errorf("attaching again changes the file or shows a diff:\n%s", again.After)
	}
	detach, err := PlanDetach(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := Apply(detach); err != nil {
		t.Fatal(err)
	}
	if Attached(dir) {
		t.Error("still attached after detaching")
	}
	if got := read(t, path); got != existing {
		t.Errorf("the original bytes did not come back:\n%s", got)
	}
}

// Hooks left by an older install, under another path, are replaced when the hooks are attached,
// never added to, even when earlier attaches had stacked up.
func TestStaleHooksAreReplacedNotStacked(t *testing.T) {
	// Every event holds the user's own hook and then two stale sets of Mabari's, by older paths.
	events := map[string]any{}
	for _, event := range hookEvents {
		groups := []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": "./mine.sh"}}}}
		for _, binary := range []string{"/old/place/mabari", "/old/place/mabari-run"} {
			groups = append(groups, map[string]any{"hooks": []any{map[string]any{
				"type": "command", "command": binary, "args": Hook{Port: 4317}.args(event), "timeout": 5,
			}}})
		}
		events[event] = groups
	}
	stacked, err := json.MarshalIndent(map[string]any{"model": "claude-sonnet-4-5", "hooks": events}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	dir := scratch(t, string(stacked)+"\n")
	path := filepath.Join(dir, "settings.json")
	if got := countOurs(t, path); got != 2*len(hookEvents) {
		t.Fatalf("the scratch file has %d Mabari hooks, want two sets", got)
	}
	plan, err := PlanAttach(dir, runHook)
	if err != nil {
		t.Fatal(err)
	}
	if err := Apply(plan); err != nil {
		t.Fatal(err)
	}
	if got := countOurs(t, path); got != len(hookEvents) {
		t.Errorf("%d Mabari hooks after reattaching, want %d", got, len(hookEvents))
	}
	after := read(t, path)
	if strings.Contains(after, "/old/place/") {
		t.Errorf("a stale path is still in settings.json:\n%s", after)
	}
	if got := strings.Count(after, `"./mine.sh"`); got != len(hookEvents) {
		t.Errorf("the user's own hook appears %d times, want %d", got, len(hookEvents))
	}
}

func compact(t *testing.T, text string) string {
	t.Helper()
	var out bytes.Buffer
	if err := json.Compact(&out, []byte(text)); err != nil {
		t.Fatal(err)
	}
	return out.String()
}

// Other people's hooks stay exactly as written, whatever they are called and wherever they sit:
// the same keys in the same order with the same values, and, on detaching, the same file.
func TestOtherPeoplesHooksStayAsWritten(t *testing.T) {
	// Not the shape of a Mabari hook in any way that matters, though it takes "hook" as an argument
	// and sits in the same event.
	theirs := `{"matcher": "Bash", "hooks": [{"type": "command", "command": "/opt/linter/lint", "args": ["hook", "--strict"], "timeout": 9}]}`
	settings := `{
  "hooks": {
    "PreToolUse": [
      ` + theirs + `
    ]
  }
}
`
	dir := scratch(t, settings)
	plan, err := PlanAttach(dir, runHook)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(compact(t, string(plan.After)), compact(t, theirs)) {
		t.Errorf("their hook changed:\n%s", plan.After)
	}
	if err := Apply(plan); err != nil {
		t.Fatal(err)
	}
	detach, err := PlanDetach(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(compact(t, string(detach.After)), compact(t, theirs)) {
		t.Errorf("their hook changed on detach:\n%s", detach.After)
	}
	if err := Apply(detach); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(dir, "settings.json")); got != settings {
		t.Errorf("detach did not restore the original:\n%s", got)
	}
}

// REV-2: a program called mabari-lint that takes "hook" as its first argument is someone else's.
// Attaching keeps it, a detach keeps it, and it never makes Mabari look attached.
func TestAMabariNamedStrangerSurvivesAttachAndDetach(t *testing.T) {
	theirs := `{"command": "/usr/local/bin/mabari-lint", "args": ["hook", "pre-commit"], "timeout": 30}`
	settings := `{
  "hooks": {
    "Stop": [
      {"hooks": [` + theirs + `]}
    ]
  }
}
`
	dir := scratch(t, settings)
	path := filepath.Join(dir, "settings.json")
	if Attached(dir) {
		t.Fatal("mabari-lint hook pre-commit made Mabari look attached")
	}
	plan, err := PlanAttach(dir, runHook)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(compact(t, string(plan.After)), compact(t, theirs)) {
		t.Fatalf("attaching dropped the stranger's hook:\n%s", plan.After)
	}
	if err := Apply(plan); err != nil {
		t.Fatal(err)
	}
	if got := countOurs(t, path); got != len(hookEvents) {
		t.Errorf("%d Mabari hooks, want %d, with the stranger's not among them", got, len(hookEvents))
	}
	detach, err := PlanDetach(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := Apply(detach); err != nil {
		t.Fatal(err)
	}
	if got := read(t, path); got != settings {
		t.Errorf("detaching did not leave the stranger's file as it was:\n%s", got)
	}
}

// The configured binary, even one not called mabari, is recognised when it is given, and replaced
// by an attach and removed by a detach.
func TestAConfiguredBinaryWithAnyName(t *testing.T) {
	dir := scratch(t, existing)
	hook := Hook{Binary: "/usr/local/bin/mb", Port: 4317}
	plan, err := PlanAttach(dir, hook)
	if err != nil {
		t.Fatal(err)
	}
	if err := Apply(plan); err != nil {
		t.Fatal(err)
	}
	if Attached(dir) {
		t.Fatal("an unknown name was recognised without being told it")
	}
	if !Attached(dir, hook.Binary) {
		t.Fatal("the configured binary was not recognised")
	}
	again, _ := PlanAttach(dir, hook)
	if again.Changed() {
		t.Error("attaching again changed the file")
	}
	detach, err := PlanDetach(dir, hook.Binary)
	if err != nil {
		t.Fatal(err)
	}
	if err := Apply(detach); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(dir, "settings.json")); got != existing {
		t.Errorf("the original bytes did not come back:\n%s", got)
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
