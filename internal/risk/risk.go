// SPDX-License-Identifier: Apache-2.0

// Package risk decides whether an agent's action is low risk or risky. Low risk auto approve
// passes only what this package allows, so the rule is simple: an action is risky unless it is
// recognised as safe. Anything that can't be understood completely is risky.
//
// This is the piece of logic a person should review. The tables are at the top of the file.
package risk

import (
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// Kind is what an agent wants to do.
type Kind string

// Kinds of action.
const (
	KindRead    Kind = "read"
	KindEdit    Kind = "edit"
	KindCommand Kind = "command"
	KindOther   Kind = "other"
)

// Action is one thing an agent wants to do.
type Action struct {
	Kind Kind
	// Command is the shell command, for KindCommand.
	Command string
	// Path is the file, for KindRead and KindEdit.
	Path string
	// Folder is the agent's working folder.
	Folder string
}

// Verdict is the classifier's answer, with the reason in plain words for the approval card.
type Verdict struct {
	Level  models.RiskLevel
	Reason string
}

// lowRisk lists the commands that may pass low risk auto approve. A nil list allows any
// arguments, and otherwise the first word after the command must be on the list.
var lowRisk = map[string][]string{
	"cat": nil, "cd": nil, "echo": nil, "find": nil, "grep": nil, "head": nil, "ls": nil,
	"pwd": nil, "rg": nil, "sed": nil, "tail": nil, "true": nil, "wc": nil,
	"bun":    {"add", "ci", "i", "install", "lint", "run", "test", "typecheck"},
	"cargo":  {"build", "check", "clippy", "fmt", "test"},
	"git":    {"add", "commit", "diff", "log", "show", "status"},
	"go":     {"build", "fmt", "mod", "test", "vet"},
	"make":   {"build", "lint", "test", "typecheck"},
	"npm":    {"add", "ci", "i", "install", "lint", "run", "test", "typecheck"},
	"pnpm":   {"add", "i", "install", "lint", "run", "test", "typecheck"},
	"pytest": nil,
	"yarn":   {"add", "install", "lint", "run", "test", "typecheck"},
}

// lowRiskScripts are the only package scripts `npm run` and friends may start.
var lowRiskScripts = []string{"build", "format", "lint", "test", "typecheck"}

// lowRiskGoMod are the only `go mod` commands allowed.
var lowRiskGoMod = []string{"download", "tidy", "verify"}

// riskyFlags turn an allowed command into something else.
var riskyFlags = map[string][]string{
	"bun":  {"-g", "--global"},
	"find": {"-delete", "-exec", "-execdir", "-fprint", "-ok", "-okdir"},
	"git":  {"--amend", "--force", "-f", "--no-verify", "-n", "-c", "-C"},
	"npm":  {"-g", "--global", "--prefix"},
	"pnpm": {"-g", "--global", "-C", "--dir"},
	"sed":  {"-i", "--in-place"},
	"yarn": {"global", "--cwd"},
}

// sensitive paths always need a person, even inside the working folder.
var sensitive = regexp.MustCompile(
	`(?i)(^|/)(\.env[^/]*|\.git|\.ssh|\.aws|\.gnupg|\.claude|\.codex|\.npmrc|\.netrc|\.kube|` +
		`credentials[^/]*|secrets?[^/]*|id_rsa[^/]*|id_ed25519[^/]*|[^/]*\.pem|[^/]*\.key)(/|$)`)

// reasons explain well-known dangerous words. They only choose the wording: anything not on
// the low risk list is risky whether or not it appears here.
var reasons = []struct {
	pattern *regexp.Regexp
	reason  string
}{
	{regexp.MustCompile(`(^|\s)(rm|rmdir|shred|unlink|truncate)(\s|$)`), "This deletes files."},
	{regexp.MustCompile(`\bgit\s+push\b`), "This pushes code to a remote."},
	{regexp.MustCompile(`\bgit\s+(reset|clean|checkout|restore)\b`), "This can throw away work."},
	{regexp.MustCompile(`(^|\s)sudo(\s|$)`), "This runs with administrator rights."},
	{
		regexp.MustCompile(`(?i)\b(migrate|psql|mysql|mongosh|sqlite3|redis-cli|drop\s+table)\b`),
		"This could change a database.",
	},
	{regexp.MustCompile(`(?i)\b(prod|production|deploy|terraform|kubectl|helm)\b`), "This could change a live system."},
	{regexp.MustCompile(`\b(curl|wget)\b`), "This talks to the internet and may run what it fetches."},
}

// Classify decides how risky an action is.
func Classify(action Action) Verdict {
	switch action.Kind {
	case KindRead:
		return classifyPath(action, "Reads a file in the working folder.")
	case KindEdit:
		return classifyPath(action, "Changes a file in the working folder.")
	case KindCommand:
		return classifyCommand(action)
	}
	return risky("Mabari doesn't recognise this action, so it needs a check.")
}

func low(reason string) Verdict   { return Verdict{Level: models.RiskLow, Reason: reason} }
func risky(reason string) Verdict { return Verdict{Level: models.RiskHigh, Reason: reason} }

// inside reports whether path stays in folder, following symbolic links where they exist.
func inside(path, folder string) bool {
	if path == "" || folder == "" {
		return false
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(folder, path)
	}
	root := resolve(filepath.Clean(folder))
	target := resolve(filepath.Clean(path))
	return target == root || strings.HasPrefix(target, root+string(filepath.Separator))
}

// resolve follows links in the part of the path that exists, so a new file in a linked folder
// is still judged by where it would really land.
func resolve(path string) string {
	rest := ""
	for current := path; ; {
		if real, err := filepath.EvalSymlinks(current); err == nil {
			return filepath.Join(real, rest)
		}
		parent := filepath.Dir(current)
		if parent == current {
			return path
		}
		rest = filepath.Join(filepath.Base(current), rest)
		current = parent
	}
}

func classifyPath(action Action, safe string) Verdict {
	if sensitive.MatchString(filepath.ToSlash(action.Path)) {
		return risky("This file may hold secrets or settings.")
	}
	if !inside(action.Path, action.Folder) {
		return risky("This is outside the agent's working folder.")
	}
	return low(safe)
}

func explain(command string) string {
	for _, known := range reasons {
		if known.pattern.MatchString(command) {
			return known.reason
		}
	}
	return "Mabari doesn't recognise this command, so it needs a check."
}

func classifyCommand(action Action) Verdict {
	commands, ok := split(action.Command)
	if !ok || len(commands) == 0 {
		return risky(orShellReason(action.Command))
	}
	for _, words := range commands {
		if !allowed(words, action.Folder) {
			return risky(explain(action.Command))
		}
	}
	return low("A routine command inside the working folder.")
}

func orShellReason(command string) string {
	if reason := explain(command); !strings.HasPrefix(reason, "Mabari") {
		return reason
	}
	return "This command is too complex for Mabari to be sure about."
}

func allowed(words []string, folder string) bool {
	name, args := words[0], words[1:]
	allowedFirst, known := lowRisk[name]
	if !known {
		return false
	}
	for _, arg := range args {
		if !safeArgument(arg, folder) || slices.Contains(riskyFlags[name], arg) {
			return false
		}
		// A short flag group such as -delete or -rf must not slip past the exact match.
		if name == "git" && strings.HasPrefix(arg, "--force") {
			return false
		}
	}
	if allowedFirst != nil {
		if len(args) == 0 || !slices.Contains(allowedFirst, args[0]) {
			return false
		}
	}
	switch {
	case name == "cd":
		return len(args) == 1
	case name == "go" && args[0] == "mod":
		return len(args) == 2 && slices.Contains(lowRiskGoMod, args[1])
	case len(args) > 0 && args[0] == "run" && name != "go" && name != "cargo":
		return len(args) >= 2 && slices.Contains(lowRiskScripts, args[1])
	}
	return true
}

func safeArgument(arg, folder string) bool {
	path := arg
	if index := strings.IndexByte(arg, '='); strings.HasPrefix(arg, "-") && index > 0 {
		path = arg[index+1:]
	}
	if sensitive.MatchString(filepath.ToSlash(path)) {
		return false
	}
	if filepath.IsAbs(path) {
		return inside(path, folder)
	}
	for part := range strings.SplitSeq(filepath.ToSlash(path), "/") {
		if part == ".." {
			return false
		}
	}
	return true
}

// split breaks a command at && into words. It reports false for anything the shell would treat
// specially, because then the words seen here may not be what actually runs.
func split(command string) ([][]string, bool) {
	var commands [][]string
	var words []string
	var word strings.Builder
	inWord := false
	end := func() {
		if inWord {
			words = append(words, word.String())
			word.Reset()
			inWord = false
		}
	}
	runes := []rune(command)
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		switch {
		case r == ' ' || r == '\t':
			end()
		case r == '\'':
			closing := slices.Index(runes[i+1:], '\'')
			if closing < 0 {
				return nil, false
			}
			word.WriteString(string(runes[i+1 : i+1+closing]))
			inWord = true
			i += closing + 1
		case r == '"':
			closing := slices.Index(runes[i+1:], '"')
			if closing < 0 {
				return nil, false
			}
			text := string(runes[i+1 : i+1+closing])
			if strings.ContainsAny(text, "$`\\!") {
				return nil, false
			}
			word.WriteString(text)
			inWord = true
			i += closing + 1
		case r == '&' && i+1 < len(runes) && runes[i+1] == '&':
			end()
			if len(words) == 0 {
				return nil, false
			}
			commands = append(commands, words)
			words = nil
			i++
		case strings.ContainsRune("|;&<>$`\\()[]{}*?~#!\n\r", r):
			return nil, false
		case r == '=' && !inWord:
			return nil, false
		default:
			word.WriteRune(r)
			inWord = true
		}
	}
	end()
	if len(words) == 0 {
		return nil, false
	}
	// FOO=bar npm test changes how the command runs, for example through PATH or LD_PRELOAD.
	if strings.Contains(words[0], "=") {
		return nil, false
	}
	return append(commands, words), true
}
