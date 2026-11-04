// SPDX-License-Identifier: Apache-2.0

// Package claudecode connects Claude Code sessions to Mabari through Claude Code's hooks. The hook
// is the mabari binary itself (`mabari hook <event>`), registered in Claude Code's settings.json.
// Mabari never reads the Claude sign-in token.
package claudecode

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// BackupSuffix is added to settings.json for the copy saved before the first change.
const BackupSuffix = ".mabari-backup"

// Hook events Mabari listens to, from Claude Code 2.1.318.
var hookEvents = []string{
	"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest",
	"Notification", "Stop", "SubagentStart", "SubagentStop", "SessionEnd",
}

// toolEvents take a matcher; "*" matches every tool.
var toolEvents = map[string]bool{"PreToolUse": true, "PostToolUse": true, "PermissionRequest": true}

// PermissionWait is how long a hook waits for a click in Mabari before Claude Code shows its own
// prompt. The hook's timeout is a little longer, so Mabari always answers first.
const PermissionWait = 120

// hookTimeout is each event's timeout in seconds. A timed-out hook only loses its output: the
// action goes ahead through Claude Code's normal rules, because Mabari never sets onFailure.
func hookTimeout(event string) int {
	if event == "PermissionRequest" {
		return PermissionWait + 10
	}
	return 5
}

// ConfigDir is Claude Code's settings folder: CLAUDE_CONFIG_DIR, or ~/.claude.
func ConfigDir(getenv func(string) string) (string, error) {
	if dir := getenv("CLAUDE_CONFIG_DIR"); dir != "" {
		return dir, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude"), nil
}

// Hook is how Claude Code should run Mabari's hook: the binary and the port the server listens on.
type Hook struct {
	Binary string
	Port   int
	// TokenFile, when set, is where the hook reads its token, instead of the secret store. Used
	// when Mabari runs in Docker and Claude Code on the host.
	TokenFile string
}

func (hook Hook) args(event string) []string {
	args := []string{"hook", "--port", strconv.Itoa(hook.Port)}
	if hook.TokenFile != "" {
		args = append(args, "--token-file", hook.TokenFile)
	}
	return append(args, event)
}

// Plan is a change to settings.json, shown before it is made.
type Plan struct {
	Path    string
	Before  []byte
	After   []byte
	Diff    []models.DiffLine
	Existed bool
}

// Changed reports whether applying the plan would change anything.
func (p Plan) Changed() bool { return !bytes.Equal(p.Before, p.After) }

func readSettings(path string) ([]byte, bool, error) {
	data, err := os.ReadFile(path) // #nosec G304 -- Claude Code's own settings file
	if errors.Is(err, fs.ErrNotExist) {
		return []byte("{}"), false, nil
	}
	return data, err == nil, err
}

// PlanAttach works out the settings with Mabari's hooks added, keeping every other entry and the
// order of the keys. Any earlier Mabari hooks are replaced, so attaching twice changes nothing.
func PlanAttach(configDir string, hook Hook) (Plan, error) {
	path := filepath.Join(configDir, "settings.json")
	before, existed, err := readSettings(path)
	if err != nil {
		return Plan{}, err
	}
	settings, err := parseObject(before)
	if err != nil {
		return Plan{}, fmt.Errorf("%s is not valid JSON: %w", path, err)
	}
	hooks, err := withoutOurHooks(settings)
	if err != nil {
		return Plan{}, err
	}
	for _, event := range hookEvents {
		groups, err := groupsOf(hooks, event)
		if err != nil {
			return Plan{}, err
		}
		group := &object{}
		if toolEvents[event] {
			group.set("matcher", mustJSON("*"))
		}
		group.set("hooks", mustJSON([]map[string]any{{
			"type":    "command",
			"command": hook.Binary,
			"args":    hook.args(event),
			"timeout": hookTimeout(event),
		}}))
		groups = append(groups, mustJSON(group))
		hooks.set(event, mustJSON(groups))
	}
	settings.set("hooks", mustJSON(hooks))
	after, err := indent(settings)
	if err != nil {
		return Plan{}, err
	}
	shown := before
	if !existed {
		shown = nil
	}
	return Plan{Path: path, Before: shown, After: after, Diff: Diff(pretty(before), after),
		Existed: existed}, nil
}

// PlanDetach works out the settings with Mabari's hooks taken out and nothing else changed.
func PlanDetach(configDir string) (Plan, error) {
	path := filepath.Join(configDir, "settings.json")
	before, existed, err := readSettings(path)
	if err != nil {
		return Plan{}, err
	}
	if !existed {
		return Plan{Path: path, Before: nil, After: nil}, nil
	}
	settings, err := parseObject(before)
	if err != nil {
		return Plan{}, fmt.Errorf("%s is not valid JSON: %w", path, err)
	}
	hooks, err := withoutOurHooks(settings)
	if err != nil {
		return Plan{}, err
	}
	if len(hooks.keys) == 0 {
		settings.remove("hooks")
	} else {
		settings.set("hooks", mustJSON(hooks))
	}
	after, err := indent(settings)
	if err != nil {
		return Plan{}, err
	}
	// Nothing of Mabari's was there, so the file is left exactly as it is. If what is left matches
	// the backup, the backup's own bytes go back, formatting and all.
	if bytes.Equal(pretty(before), after) {
		after = before
	} else if backup, err := os.ReadFile(path + BackupSuffix); err == nil && sameJSON(backup, after) { // #nosec G304 -- our own backup
		after = backup
	}
	return Plan{Path: path, Before: before, After: after, Diff: Diff(pretty(before), after),
		Existed: true}, nil
}

// Apply backs up the settings the first time, then writes the plan in one step, keeping the
// file's permissions.
func Apply(plan Plan) error {
	if !plan.Changed() {
		return nil
	}
	mode := fs.FileMode(0o600)
	if plan.Existed {
		info, err := os.Stat(plan.Path)
		if err != nil {
			return err
		}
		mode = info.Mode().Perm()
		backup := plan.Path + BackupSuffix
		if _, err := os.Stat(backup); errors.Is(err, fs.ErrNotExist) {
			if err := os.WriteFile(backup, plan.Before, 0o600); err != nil {
				return fmt.Errorf("back up settings: %w", err)
			}
		}
	}
	if err := os.MkdirAll(filepath.Dir(plan.Path), 0o700); err != nil {
		return err
	}
	temp := plan.Path + ".mabari-tmp"
	if err := os.WriteFile(temp, plan.After, mode); err != nil {
		return err
	}
	return os.Rename(temp, plan.Path)
}

// Attached reports whether Mabari's hooks are in the settings.
func Attached(configDir string) bool {
	data, existed, err := readSettings(filepath.Join(configDir, "settings.json"))
	if err != nil || !existed {
		return false
	}
	settings, err := parseObject(data)
	if err != nil {
		return false
	}
	raw, ok := settings.values["hooks"]
	if !ok {
		return false
	}
	hooks, err := parseObject(raw)
	if err != nil {
		return false
	}
	for _, event := range hooks.keys {
		var groups []struct {
			Hooks []json.RawMessage `json:"hooks"`
		}
		if json.Unmarshal(hooks.values[event], &groups) != nil {
			continue
		}
		for _, group := range groups {
			for _, handler := range group.Hooks {
				if isOurs(handler) {
					return true
				}
			}
		}
	}
	return false
}

// isOurs reports whether a hook handler runs `mabari hook`.
func isOurs(handler json.RawMessage) bool {
	var h struct {
		Command string   `json:"command"`
		Args    []string `json:"args"`
	}
	if json.Unmarshal(handler, &h) != nil || len(h.Args) == 0 || h.Args[0] != "hook" {
		return false
	}
	// Settings written on Windows use backslashes, whichever system reads them.
	name := h.Command[strings.LastIndexAny(h.Command, `/\`)+1:]
	return strings.TrimSuffix(strings.ToLower(name), ".exe") == "mabari"
}

// withoutOurHooks returns the settings' hooks object with every Mabari handler removed, dropping
// groups and events left empty. Other people's hooks stay exactly as written.
func withoutOurHooks(settings *object) (*object, error) {
	hooks := &object{}
	raw, ok := settings.values["hooks"]
	if !ok {
		return hooks, nil
	}
	parsed, err := parseObject(raw)
	if err != nil {
		return nil, errors.New(`"hooks" in settings.json is not an object`)
	}
	for _, event := range parsed.keys {
		var groups []json.RawMessage
		if err := json.Unmarshal(parsed.values[event], &groups); err != nil {
			hooks.set(event, parsed.values[event])
			continue
		}
		kept := []json.RawMessage{}
		for _, rawGroup := range groups {
			group, err := parseObject(rawGroup)
			if err != nil {
				kept = append(kept, rawGroup)
				continue
			}
			var handlers []json.RawMessage
			if json.Unmarshal(group.values["hooks"], &handlers) != nil {
				kept = append(kept, rawGroup)
				continue
			}
			theirs := []json.RawMessage{}
			for _, handler := range handlers {
				if !isOurs(handler) {
					theirs = append(theirs, handler)
				}
			}
			switch {
			case len(theirs) == len(handlers):
				kept = append(kept, rawGroup)
			case len(theirs) > 0:
				group.set("hooks", mustJSON(theirs))
				kept = append(kept, mustJSON(group))
			}
		}
		if len(kept) > 0 {
			hooks.set(event, mustJSON(kept))
		}
	}
	return hooks, nil
}

func groupsOf(hooks *object, event string) ([]json.RawMessage, error) {
	raw, ok := hooks.values[event]
	if !ok {
		return nil, nil
	}
	var groups []json.RawMessage
	if err := json.Unmarshal(raw, &groups); err != nil {
		return nil, fmt.Errorf("hooks.%s in settings.json is not a list", event)
	}
	return groups, nil
}

func mustJSON(value any) json.RawMessage {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err) // Only Mabari's own values reach here.
	}
	return data
}

func indent(value any) ([]byte, error) {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

// pretty re-indents JSON the way Mabari writes it, so a diff shows only real changes.
func pretty(data []byte) []byte {
	var out bytes.Buffer
	if json.Indent(&out, bytes.TrimSpace(data), "", "  ") != nil {
		return data
	}
	out.WriteByte('\n')
	return out.Bytes()
}

// object is a JSON object that keeps its keys in order, so rewriting settings.json doesn't shuffle
// the user's file.
type object struct {
	keys   []string
	values map[string]json.RawMessage
}

func parseObject(data []byte) (*object, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	if delim, ok := token.(json.Delim); !ok || delim != '{' {
		return nil, errors.New("not an object")
	}
	o := &object{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := token.(string)
		if !ok {
			return nil, errors.New("not an object")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		o.set(key, value)
	}
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	return o, nil
}

func (o *object) set(key string, value json.RawMessage) {
	if o.values == nil {
		o.values = map[string]json.RawMessage{}
	}
	if _, ok := o.values[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.values[key] = value
}

func (o *object) remove(key string) {
	delete(o.values, key)
	for index, existing := range o.keys {
		if existing == key {
			o.keys = append(o.keys[:index], o.keys[index+1:]...)
			return
		}
	}
}

// MarshalJSON writes the keys in their original order.
func (o *object) MarshalJSON() ([]byte, error) {
	var out bytes.Buffer
	out.WriteByte('{')
	for index, key := range o.keys {
		if index > 0 {
			out.WriteByte(',')
		}
		name, err := json.Marshal(key)
		if err != nil {
			return nil, err
		}
		out.Write(name)
		out.WriteByte(':')
		out.Write(o.values[key])
	}
	out.WriteByte('}')
	return out.Bytes(), nil
}

// Diff compares two texts line by line, keeping three lines of context around each change.
func Diff(before, after []byte) []models.DiffLine {
	a := strings.Split(strings.TrimSuffix(string(before), "\n"), "\n")
	b := strings.Split(strings.TrimSuffix(string(after), "\n"), "\n")
	if len(before) == 0 {
		a = nil
	}
	// Longest common subsequence, from the end, so the walk below goes forwards.
	lcs := make([][]int, len(a)+1)
	for i := range lcs {
		lcs[i] = make([]int, len(b)+1)
	}
	for i := len(a) - 1; i >= 0; i-- {
		for j := len(b) - 1; j >= 0; j-- {
			if a[i] == b[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else {
				lcs[i][j] = max(lcs[i+1][j], lcs[i][j+1])
			}
		}
	}
	var all []models.DiffLine
	i, j := 0, 0
	for i < len(a) || j < len(b) {
		switch {
		case i < len(a) && j < len(b) && a[i] == b[j]:
			all = append(all, models.DiffLine{Kind: "ctx", Text: a[i]})
			i, j = i+1, j+1
		case j < len(b) && (i == len(a) || lcs[i][j+1] >= lcs[i+1][j]):
			all = append(all, models.DiffLine{Kind: "add", Text: b[j]})
			j++
		default:
			all = append(all, models.DiffLine{Kind: "del", Text: a[i]})
			i++
		}
	}
	const context = 3
	keep := make([]bool, len(all))
	for index, line := range all {
		if line.Kind == "ctx" {
			continue
		}
		for k := max(0, index-context); k <= min(len(all)-1, index+context); k++ {
			keep[k] = true
		}
	}
	shown := []models.DiffLine{}
	for index, line := range all {
		if keep[index] {
			shown = append(shown, line)
		} else if index > 0 && keep[index-1] {
			shown = append(shown, models.DiffLine{Kind: "ctx", Text: "…"})
		}
	}
	return shown
}

// sameJSON reports whether two documents hold the same values, ignoring spacing.
func sameJSON(a, b []byte) bool {
	var left, right bytes.Buffer
	return json.Compact(&left, a) == nil && json.Compact(&right, b) == nil &&
		bytes.Equal(left.Bytes(), right.Bytes())
}
