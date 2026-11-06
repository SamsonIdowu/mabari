// SPDX-License-Identifier: Apache-2.0

package server

import (
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"gopkg.in/yaml.v2"
)

// What the message box offers to complete: the files in an agent's folder after "@", and the
// folder's and account's commands and skills after "/". The page names an agent or a project,
// never a path, so it can only ever list the folder Mabari already knows for it. Nothing is read
// but names, and the first few lines of a command's file for its description.

const (
	filesShown  = 12
	filesWalked = 20000
	filesDepth  = 6
	filesBudget = 400 * time.Millisecond
	commandsMax = 300
	commandRead = 4096
)

// skippedDirs hold what nobody means to mention: version control, dependencies and build output.
var skippedDirs = map[string]bool{
	".git": true, "node_modules": true, ".venv": true, "venv": true, "__pycache__": true,
	".next": true, ".cache": true, ".gradle": true, "dist": true, "build": true, ".idea": true,
	"vendor": true,
}

// ChatFile is one file or folder that can be mentioned, as a path inside the folder.
type ChatFile struct {
	Path string `json:"path"`
	Dir  bool   `json:"dir"`
}

type chatFilesResult struct {
	Files []ChatFile `json:"files"`
}

// plainName is a name safe to put in a message: valid text with no control characters.
func plainName(name string) bool {
	if !utf8.ValidString(name) {
		return false
	}
	return !strings.ContainsFunc(name, unicode.IsControl)
}

// matchRank scores how well a path fits what was typed, lower is better, or -1 for no match. A
// name that starts with it comes first, then one that holds it, then a path that holds it, then
// one whose letters appear in order.
func matchRank(path, query string) int {
	if query == "" {
		return 4
	}
	lower, base := strings.ToLower(path), strings.ToLower(filepath.Base(path))
	switch {
	case strings.HasPrefix(base, query):
		return 0
	case strings.HasPrefix(lower, query):
		return 1
	case strings.Contains(base, query):
		return 2
	case strings.Contains(lower, query):
		return 3
	}
	at := 0
	for _, letter := range query {
		next := strings.IndexRune(lower[at:], letter)
		if next < 0 {
			return -1
		}
		at += next + utf8.RuneLen(letter)
	}
	return 5
}

// walkFiles lists what in a folder matches a query, within limits that keep a huge folder, or a
// whole home directory, from making the box wait.
func walkFiles(root, query string) []ChatFile {
	query = strings.ToLower(strings.TrimSpace(query))
	showHidden := strings.HasPrefix(query, ".") || strings.Contains(query, "/.")
	deadline := time.Now().Add(filesBudget)
	type ranked struct {
		file ChatFile
		rank int
	}
	var found []ranked
	visited := 0
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			if entry != nil && entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if path == root {
			return nil
		}
		visited++
		if visited > filesWalked || time.Now().After(deadline) {
			return fs.SkipAll
		}
		name := entry.Name()
		relative, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return nil
		}
		relative = filepath.ToSlash(relative)
		if entry.IsDir() {
			if skippedDirs[name] || (strings.HasPrefix(name, ".") && !showHidden) ||
				strings.Count(relative, "/") >= filesDepth {
				return fs.SkipDir
			}
		} else if strings.HasPrefix(name, ".") && !showHidden {
			return nil
		}
		if !plainName(relative) {
			return nil
		}
		// A link could lead out of the folder, so only real files and folders are offered.
		if entry.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		shown := relative
		if entry.IsDir() {
			shown += "/"
		}
		if rank := matchRank(shown, query); rank >= 0 {
			found = append(found, ranked{ChatFile{Path: shown, Dir: entry.IsDir()}, rank})
		}
		return nil
	})
	sort.SliceStable(found, func(i, j int) bool {
		if found[i].rank != found[j].rank {
			return found[i].rank < found[j].rank
		}
		if len(found[i].file.Path) != len(found[j].file.Path) {
			return len(found[i].file.Path) < len(found[j].file.Path)
		}
		return found[i].file.Path < found[j].file.Path
	})
	files := make([]ChatFile, 0, filesShown)
	for _, hit := range found {
		if len(files) == filesShown {
			break
		}
		files = append(files, hit.file)
	}
	return files
}

// chatFiles is GET /api/chat/files?agent=…|project=…&q=…
func (a *api) chatFiles(w http.ResponseWriter, r *http.Request) {
	agent, project := r.URL.Query().Get("agent"), r.URL.Query().Get("project")
	if (agent == "") == (project == "") {
		writeError(w, http.StatusBadRequest, "say whether this is for an agent or a project")
		return
	}
	var root string
	if err := a.engine.Do(func() { root = a.folderOf(agent, project) }); err != nil {
		internalError(w, err)
		return
	}
	result := chatFilesResult{Files: []ChatFile{}}
	if root != "" {
		result.Files = walkFiles(root, r.URL.Query().Get("q"))
	}
	writeJSON(w, http.StatusOK, result)
}

// ChatCommand is a slash command or skill the message box can complete.
type ChatCommand struct {
	Name string `json:"name"`
	// Kind is "command" or "skill".
	Kind string `json:"kind"`
	// Scope is "folder" or "account".
	Scope       string `json:"scope"`
	Description string `json:"description"`
}

type chatCommandsResult struct {
	Commands []ChatCommand `json:"commands"`
	Saved    []Saved       `json:"saved"`
}

// frontMatter reads the description, and for a skill the name, from the top of a Markdown file. A
// file with none uses its first line of text.
func frontMatter(text string) (name, description string) {
	body := text
	if rest, ok := strings.CutPrefix(text, "---\n"); ok {
		if head, after, found := strings.Cut(rest, "\n---"); found {
			var fields map[string]any
			if yaml.Unmarshal([]byte(head), &fields) == nil {
				name, _ = fields["name"].(string)
				description, _ = fields["description"].(string)
			}
			body = after
		}
	}
	if description == "" {
		for _, line := range strings.Split(body, "\n") {
			if line = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(line), "#")); line != "" && line != "---" {
				description = line
				break
			}
		}
	}
	return strings.TrimSpace(name), strings.TrimSpace(ellipsize(strings.Join(strings.Fields(description), " "), 160))
}

// readHead reads the start of a regular file, and nothing if it is a link or anything else.
func readHead(path string) string {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return ""
	}
	file, err := os.Open(path) // #nosec G304 -- a regular file inside a commands or skills folder
	if err != nil {
		return ""
	}
	defer func() { _ = file.Close() }()
	buffer := make([]byte, commandRead)
	count, _ := file.Read(buffer)
	return string(buffer[:count])
}

// commandName is a name that can follow a slash in a message.
func commandName(name string) bool {
	return name != "" && len(name) <= 64 && !strings.ContainsFunc(name, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r) || r == '/' || r == '\\'
	})
}

// commandsIn lists the commands and skills under one `.claude`-style folder.
func commandsIn(root, scope string) []ChatCommand {
	var found []ChatCommand
	if entries, err := os.ReadDir(filepath.Join(root, "commands")); err == nil {
		for _, entry := range entries {
			name, isMarkdown := strings.CutSuffix(entry.Name(), ".md")
			if !isMarkdown || entry.IsDir() || !commandName(name) {
				continue
			}
			_, description := frontMatter(readHead(filepath.Join(root, "commands", entry.Name())))
			found = append(found, ChatCommand{Name: name, Kind: "command", Scope: scope, Description: description})
		}
	}
	if entries, err := os.ReadDir(filepath.Join(root, "skills")); err == nil {
		for _, entry := range entries {
			// A skill is often a link to a folder kept elsewhere.
			if info, err := os.Stat(filepath.Join(root, "skills", entry.Name())); err != nil || !info.IsDir() {
				continue
			}
			name, description := frontMatter(readHead(filepath.Join(root, "skills", entry.Name(), "SKILL.md")))
			if name == "" {
				name = entry.Name()
			}
			if commandName(name) {
				found = append(found, ChatCommand{Name: name, Kind: "skill", Scope: scope, Description: description})
			}
		}
	}
	return found
}

// chatCommands is GET /api/chat/commands?agent=…|project=…: the folder's commands and skills, the
// account's, and the saved instructions. A folder's own win over the account's of the same name.
func (a *api) chatCommands(w http.ResponseWriter, r *http.Request) {
	agent, project := r.URL.Query().Get("agent"), r.URL.Query().Get("project")
	if (agent == "") == (project == "") {
		writeError(w, http.StatusBadRequest, "say whether this is for an agent or a project")
		return
	}
	var root string
	if err := a.engine.Do(func() { root = a.folderOf(agent, project) }); err != nil {
		internalError(w, err)
		return
	}
	result := chatCommandsResult{Commands: []ChatCommand{}, Saved: a.savedInstructions()}
	taken := map[string]bool{}
	add := func(found []ChatCommand) {
		sort.Slice(found, func(i, j int) bool { return found[i].Name < found[j].Name })
		for _, command := range found {
			key := command.Kind + ":" + command.Name
			if taken[key] || len(result.Commands) >= commandsMax {
				continue
			}
			taken[key] = true
			result.Commands = append(result.Commands, command)
		}
	}
	if root != "" {
		add(commandsIn(filepath.Join(root, ".claude"), "folder"))
	}
	if account := a.configDir(); account != "" {
		add(commandsIn(account, "account"))
	}
	writeJSON(w, http.StatusOK, result)
}
