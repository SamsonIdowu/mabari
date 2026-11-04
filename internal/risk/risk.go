// SPDX-License-Identifier: Apache-2.0

// Package risk decides whether an agent's action is low risk or risky. Low risk auto approve
// passes only what this package allows, so the rule is simple: an action is risky unless it is
// recognised as safe. Anything that can't be understood completely is risky.
//
// This is the piece of logic a person should review. The tables are at the top of the file.
package risk

import (
	"errors"
	"io/fs"
	"os"
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

// commandRule says how a command may be used and pass low risk auto approve. Everything is an
// allowlist, because these tools have flags that run code: an unknown flag makes a command risky.
type commandRule struct {
	// first lists the allowed subcommands. Nil means the command takes none.
	first []string
	// flags lists the allowed flags, by subcommand where there are subcommands. A trailing = means
	// the flag takes a value, as in -run=Total.
	flags map[string][]string
	// noArguments means only flags may follow.
	noArguments bool
	// numbers allows counts such as -5.
	numbers bool
}

const anySubcommand = ""

var packageManager = commandRule{
	first: []string{"ci", "i", "install", "lint", "run", "test", "typecheck"},
}

var lowRisk = map[string]commandRule{
	"cat":  {},
	"cd":   {},
	"echo": {},
	"find": {flags: map[string][]string{anySubcommand: {"-iname", "-maxdepth", "-mindepth", "-name", "-path", "-type"}}},
	"grep": {flags: map[string][]string{anySubcommand: {"-E", "-F", "-c", "-i", "-l", "-n", "-v", "-w"}}},
	"head": {numbers: true, flags: map[string][]string{anySubcommand: {"-n"}}},
	"ls":   {flags: map[string][]string{anySubcommand: {"-1", "-a", "-al", "-l", "-la", "-lah", "-lh"}}},
	"pwd":  {noArguments: true},
	"tail": {numbers: true, flags: map[string][]string{anySubcommand: {"-n"}}},
	"true": {noArguments: true},
	"wc":   {flags: map[string][]string{anySubcommand: {"-c", "-l", "-w"}}},
	"bun":  packageManager,
	"npm":  packageManager,
	"pnpm": packageManager,
	"yarn": packageManager,
	"cargo": {
		first: []string{"build", "check", "clippy", "fmt", "test"},
		flags: map[string][]string{anySubcommand: {"--all", "--all-features", "--all-targets", "--release", "--workspace"}},
	},
	"git": {
		numbers: true,
		first:   []string{"add", "commit", "diff", "log", "show", "status"},
		flags: map[string][]string{
			"add":    {"--all", "-A", "-u"},
			"commit": {"-m"},
			"diff":   {"--cached", "--name-only", "--stat", "--staged"},
			"log":    {"--oneline", "--stat", "-n"},
			"show":   {"--name-only", "--stat"},
			"status": {"--branch", "--porcelain", "--short", "-b", "-s"},
		},
	},
	"go": {
		first: []string{"build", "fmt", "mod", "test", "vet"},
		flags: map[string][]string{"test": {"-count=", "-cover", "-race", "-run=", "-short", "-timeout=", "-v"}},
	},
	"make":   {first: []string{"build", "lint", "test", "typecheck"}, noArguments: true},
	"pytest": {flags: map[string][]string{anySubcommand: {"-k", "-q", "-v", "-x"}}},
}

// lowRiskScripts are the only package scripts `npm run` and friends may start.
var lowRiskScripts = []string{"build", "format", "lint", "test", "typecheck"}

// lowRiskGoMod are the only `go mod` commands allowed.
var lowRiskGoMod = []string{"download", "tidy", "verify"}

// sedPrint is the one form of sed allowed: printing lines. sed scripts can run commands and write
// files, so nothing else is safe to pass.
var sedPrint = regexp.MustCompile(`^[0-9]+(,[0-9]+)?p$`)

// number is a count such as -5.
var number = regexp.MustCompile(`^-[0-9]+$`)

// sensitive paths always need a person, even inside the working folder. Workflow and editor
// folders count, because what is in them runs without anyone asking.
var sensitive = regexp.MustCompile(
	`(?i)(^|/)(\.env[^/]*|\.git|\.github|\.husky|\.vscode|\.ssh|\.aws|\.gnupg|\.claude|\.codex|` +
		`\.npmrc|\.netrc|\.kube|credentials[^/]*|secrets?[^/]*|id_rsa[^/]*|id_ed25519[^/]*|` +
		`[^/]*\.pem|[^/]*\.key)(/|$)`)

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

// maxLinks stops a loop of symbolic links.
const maxLinks = 32

// resolved finds where a path really lands. It walks one part at a time, so a link is followed
// even when its target doesn't exist. It reports false for anything it can't be sure of.
func resolved(path string, links *int) (string, bool) {
	volume := filepath.VolumeName(path)
	current := volume + string(filepath.Separator)
	parts := strings.Split(filepath.ToSlash(path[len(volume):]), "/")
	for index, part := range parts {
		if part == "" {
			continue
		}
		next := filepath.Join(current, part)
		info, err := os.Lstat(next)
		if errors.Is(err, fs.ErrNotExist) {
			return filepath.Join(append([]string{current}, parts[index:]...)...), true
		}
		if err != nil {
			return "", false
		}
		if info.Mode()&fs.ModeSymlink == 0 {
			current = next
			continue
		}
		if *links++; *links > maxLinks {
			return "", false
		}
		target, err := os.Readlink(next)
		if err != nil {
			return "", false
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(current, target)
		}
		through, ok := resolved(target, links)
		if !ok {
			return "", false
		}
		current = through
	}
	return current, true
}

// relativeTo returns where path really lands inside folder. It reports false if that is outside
// the folder or can't be worked out. A path with .. in it is never accepted, because what .. means
// depends on links in the part before it.
func relativeTo(path, folder string) (string, bool) {
	if path == "" || !filepath.IsAbs(folder) {
		return "", false
	}
	if slices.Contains(strings.Split(filepath.ToSlash(path), "/"), "..") {
		return "", false
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(folder, path)
	}
	var links int
	root, ok := resolved(filepath.Clean(folder), &links)
	if !ok {
		return "", false
	}
	target, ok := resolved(path, &links)
	if !ok {
		return "", false
	}
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", false
	}
	return filepath.ToSlash(relative), true
}

func classifyPath(action Action, safe string) Verdict {
	if sensitive.MatchString(filepath.ToSlash(action.Path)) {
		return risky("This file may hold secrets or settings.")
	}
	relative, ok := relativeTo(action.Path, action.Folder)
	if !ok {
		return risky("This is outside the agent's working folder.")
	}
	if sensitive.MatchString(relative) {
		return risky("This file may hold secrets or settings.")
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
	cwd := action.Folder
	for _, words := range commands {
		if !allowed(words, &cwd) {
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

// allowed checks one command. It updates cwd when the command is cd, so that later commands in a
// chain are judged from where they will really run.
func allowed(words []string, cwd *string) bool {
	name, args := words[0], words[1:]
	switch name {
	case "cd":
		return moveTo(args, cwd)
	case "sed":
		return len(args) == 3 && args[0] == "-n" && sedPrint.MatchString(args[1]) && safePath(args[2], *cwd)
	}
	rule, known := lowRisk[name]
	if !known {
		return false
	}
	subcommand := anySubcommand
	if rule.first != nil {
		if len(args) == 0 || !slices.Contains(rule.first, args[0]) {
			return false
		}
		subcommand, args = args[0], args[1:]
	}
	if rule.noArguments && len(args) > 0 {
		return false
	}
	switch {
	case name == "go" && subcommand == "mod":
		return len(args) == 1 && slices.Contains(lowRiskGoMod, args[0])
	case subcommand == "run" && name != "go" && name != "cargo":
		return len(args) == 1 && slices.Contains(lowRiskScripts, args[0])
	case isPackageManager(name) && slices.Contains([]string{"i", "install"}, subcommand):
		// Installing from the lockfile is routine. A named package runs a stranger's install scripts.
		return len(args) == 0
	case name == "git" && subcommand == "commit":
		return len(args) == 2 && args[0] == "-m"
	}
	return argumentsAllowed(rule, subcommand, args, *cwd)
}

func isPackageManager(name string) bool {
	return slices.Contains([]string{"bun", "npm", "pnpm", "yarn"}, name)
}

func moveTo(args []string, cwd *string) bool {
	if len(args) != 1 {
		return false
	}
	relative, ok := relativeTo(args[0], *cwd)
	if !ok || sensitive.MatchString(relative) {
		return false
	}
	*cwd = filepath.Join(*cwd, args[0])
	return true
}

func argumentsAllowed(rule commandRule, subcommand string, args []string, cwd string) bool {
	for _, arg := range args {
		if !strings.HasPrefix(arg, "-") {
			if !safePath(arg, cwd) {
				return false
			}
			continue
		}
		if !flagAllowed(rule, subcommand, arg) {
			return false
		}
	}
	return true
}

func flagAllowed(rule commandRule, subcommand, flag string) bool {
	if rule.numbers && number.MatchString(flag) {
		return true
	}
	flags := rule.flags[subcommand]
	if index := strings.IndexByte(flag, '='); index > 0 {
		return slices.Contains(flags, flag[:index+1])
	}
	return slices.Contains(flags, flag)
}

// safePath checks a word that may be a path. It also looks after a colon, because git reads
// HEAD:.env as a file.
func safePath(arg, cwd string) bool {
	for part := range strings.SplitSeq(arg, ":") {
		if sensitive.MatchString(filepath.ToSlash(part)) {
			return false
		}
	}
	relative, ok := relativeTo(arg, cwd)
	return ok && !sensitive.MatchString(relative)
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
