// SPDX-License-Identifier: Apache-2.0

// Package workspace checks the folders and repositories agents work in: typed or pasted paths,
// the native folder picker, a quick look inside a folder, and Git clones restricted to https and
// ssh URLs, run without a shell.
package workspace

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// Clean tidies a pasted path, as the prototype's cleanPath does: quotes, a file:// prefix and
// trailing slashes go.
func Clean(value string) string {
	value = strings.Trim(strings.TrimSpace(value), `"'`)
	if lower := strings.ToLower(value); strings.HasPrefix(lower, "file://") {
		rest := value[len("file://"):]
		rest = strings.TrimPrefix(rest, "localhost")
		if decoded, err := url.PathUnescape(rest); err == nil {
			rest = decoded
		}
		value = rest
	}
	if trimmed := strings.TrimRight(value, "/"); trimmed != "" {
		return trimmed
	}
	return value
}

var (
	fullPath = regexp.MustCompile(`^(~/|~$|/|[A-Za-z]:\\)`)
	urlLike  = regexp.MustCompile(`^(https?://|git@)`)
)

// IsURL reports whether the value is a Git URL rather than a folder.
func IsURL(value string) bool { return urlLike.MatchString(value) }

// Valid reports whether the value is a full path, or a Git URL when those are allowed.
func Valid(value string, allowURL bool) bool {
	return fullPath.MatchString(value) || (allowURL && IsURL(value))
}

// Expand turns ~ into the home folder and makes the path absolute.
func Expand(path string) (string, error) {
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		path = filepath.Join(home, strings.TrimPrefix(path, "~"))
	}
	if !filepath.IsAbs(path) {
		return "", errors.New("use a full path such as ~/code/shop")
	}
	return filepath.Clean(path), nil
}

// Scan is a quick look inside a working folder.
type Scan struct {
	Root     string   `json:"root"`
	Path     string   `json:"path"`
	Count    int      `json:"count"`
	Markers  []string `json:"markers"`
	Lang     string   `json:"lang"`
	Manifest string   `json:"manifest"`
	Tests    string   `json:"tests"`
	// Instructions is the folder's CLAUDE.md or AGENTS.md, shortened, if it has one.
	Instructions     string `json:"instructions"`
	InstructionsFrom string `json:"instructionsFrom"`
	// Agents are the agent files in the folder's .claude/agents, by name. Mabari loads them with
	// the project once it starts.
	Agents []string `json:"agents"`
}

// scanLimit stops counting in very large folders.
const scanLimit = 20000

// maxInstructions is as much of an instructions file as is offered.
const maxInstructions = 4000

var markerNames = []string{"package.json", "pyproject.toml", "go.mod", "CLAUDE.md", "AGENTS.md", "README.md"}

// skipped are folders a scan doesn't walk into.
var skipped = map[string]bool{".git": true, "node_modules": true, ".venv": true, "vendor": true, "dist": true}

// Look scans a folder: how many files, which project files it has, and its instructions.
func Look(path string) (Scan, error) {
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return Scan{}, errors.New("there is no folder at " + path)
		}
		return Scan{}, err
	}
	if !info.IsDir() {
		return Scan{}, errors.New(path + " is a file, not a folder")
	}
	scan := Scan{Root: filepath.Base(path), Path: path, Markers: []string{}, Agents: []string{}}
	if entries, err := os.ReadDir(filepath.Join(path, ".claude", "agents")); err == nil {
		for _, entry := range entries {
			if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".md") {
				scan.Agents = append(scan.Agents, strings.TrimSuffix(entry.Name(), ".md"))
			}
		}
	}
	for _, name := range markerNames {
		if _, err := os.Stat(filepath.Join(path, name)); err == nil {
			scan.Markers = append(scan.Markers, name)
		}
	}
	_ = filepath.WalkDir(path, func(_ string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			if skipped[entry.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		scan.Count++
		if scan.Count >= scanLimit {
			return filepath.SkipAll
		}
		return nil
	})
	has := func(name string) bool {
		for _, marker := range scan.Markers {
			if marker == name {
				return true
			}
		}
		return false
	}
	switch {
	case has("pyproject.toml"):
		scan.Lang, scan.Manifest, scan.Tests = "Python", "pyproject.toml", "pytest"
	case has("go.mod"):
		scan.Lang, scan.Manifest, scan.Tests = "Go", "go.mod", "go test"
	case has("package.json"):
		scan.Lang, scan.Manifest, scan.Tests = "TypeScript", "package.json", "vitest"
	default:
		scan.Lang, scan.Manifest, scan.Tests = "Mixed", "no manifest found", "not detected"
	}
	for _, name := range []string{"CLAUDE.md", "AGENTS.md"} {
		if !has(name) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(path, name)) // #nosec G304 -- the user's own folder
		if err != nil {
			continue
		}
		text := string(data)
		if runes := []rune(text); len(runes) > maxInstructions {
			text = string(runes[:maxInstructions])
		}
		scan.Instructions, scan.InstructionsFrom = text, name
		break
	}
	return scan, nil
}

var (
	httpsURL  = regexp.MustCompile(`^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._~/-]+$`)
	sshURL    = regexp.MustCompile(`^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$`)
	branchRef = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$`)
)

// CheckGitURL allows only https and ssh URLs, with no options, transports or odd characters a
// URL could use to make git run something.
func CheckGitURL(raw string) error {
	if strings.Contains(raw, "..") || (!httpsURL.MatchString(raw) && !sshURL.MatchString(raw)) {
		return errors.New("use an https or ssh Git URL, such as https://github.com/you/shop")
	}
	return nil
}

// CheckBranch allows ordinary branch names only.
func CheckBranch(branch string) error {
	if branch == "" {
		return nil
	}
	if !branchRef.MatchString(branch) || strings.Contains(branch, "..") || strings.HasSuffix(branch, ".lock") {
		return errors.New("that branch name isn't valid")
	}
	return nil
}

// RepoName is the folder name a URL clones into.
func RepoName(raw string) string {
	name := strings.TrimSuffix(strings.TrimRight(raw, "/"), ".git")
	if cut := strings.LastIndexAny(name, "/:"); cut >= 0 {
		name = name[cut+1:]
	}
	if name == "" {
		return "project"
	}
	return name
}

// cloneWait is the longest a clone may take.
const cloneWait = 10 * time.Minute

// Clone runs git clone with separate arguments, never through a shell, into a folder that must
// not exist yet. Git never asks for a password, so it can't hang waiting.
func Clone(ctx context.Context, raw, branch, dest string) error {
	if err := CheckGitURL(raw); err != nil {
		return err
	}
	if err := CheckBranch(branch); err != nil {
		return err
	}
	if _, err := os.Stat(dest); err == nil {
		return fmt.Errorf("%s already exists", dest)
	}
	args := []string{"clone", "--depth", "1"}
	if branch != "" {
		args = append(args, "--branch", branch)
	}
	args = append(args, "--", raw, dest)
	ctx, cancel := context.WithTimeout(ctx, cloneWait)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...) // #nosec G204 -- checked URL and branch, no shell
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=echo")
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("git clone failed: %s", strings.TrimSpace(string(output)))
	}
	return nil
}

// ErrNoPicker means this computer has no folder picker Mabari can open.
var ErrNoPicker = errors.New("there's no folder picker here: type or paste the path instead")

// ErrCancelled means the person closed the picker without choosing.
var ErrCancelled = errors.New("no folder was chosen")

// Pick opens the system's own folder picker and returns the chosen folder.
func Pick(ctx context.Context) (string, error) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.CommandContext(ctx, "osascript", "-e",
			`POSIX path of (choose folder with prompt "Choose a working folder for your agents")`)
	case "windows":
		cmd = exec.CommandContext(ctx, "powershell", "-NoProfile", "-Command",
			`Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }`)
	default:
		if path, err := exec.LookPath("zenity"); err == nil {
			cmd = exec.CommandContext(ctx, path, "--file-selection", "--directory") // #nosec G204
		} else if path, err := exec.LookPath("kdialog"); err == nil {
			cmd = exec.CommandContext(ctx, path, "--getexistingdirectory") // #nosec G204
		} else {
			return "", ErrNoPicker
		}
	}
	output, err := cmd.Output()
	chosen := Clean(string(output))
	if err != nil || chosen == "" {
		var exit *exec.ExitError
		if errors.As(err, &exit) || chosen == "" {
			return "", ErrCancelled
		}
		return "", ErrNoPicker
	}
	return chosen, nil
}

// maxRecent is how many recent folders are kept.
const maxRecent = 8

// Remember puts a folder first in the recent list. URLs aren't folders, so they aren't kept.
func Remember(recent []string, folder string) []string {
	if folder == "" || IsURL(folder) {
		return recent
	}
	out := []string{folder}
	for _, existing := range recent {
		if existing != folder && len(out) < maxRecent {
			out = append(out, existing)
		}
	}
	return out
}
