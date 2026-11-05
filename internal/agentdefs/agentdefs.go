// SPDX-License-Identifier: Apache-2.0

// Package agentdefs keeps reusable agents as Markdown files, the format Claude Code reads:
// ~/.claude/agents/<name>.md for the whole account and <project folder>/.claude/agents/<name>.md
// for one project. The files are the source of truth. They are read on every start and watched
// while Mabari runs, so a file added or edited outside Mabari shows up too. They are never tied to
// a connected account, and nothing Mabari does to its own data, such as a wipe, removes them.
//
// Mabari keeps only its own runtime numbers in agents-state.json in its data folder: how many
// times each agent ran, and which ones are turned off.
package agentdefs

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v2"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// MabariName is the built in office manager's file name and agent name.
const MabariName = "mabari"

// Skills Mabari has, as in the prototype.
var mabariSkills = []string{"agent-creator", "agent-improver"}

// mabariDefault is what ~/.claude/agents/mabari.md holds when Mabari writes it for the first time.
var mabariDefault = models.AgentDef{
	Name: MabariName,
	Description: "Office manager. Manages every other agent and helps them improve. Routes every request to the " +
		"right agent, starts one when nobody is free, creates new agents and improves existing ones, and reports " +
		"every reply and update back in the chat.",
	Scope:  models.DefAccount,
	Model:  "haiku",
	Tools:  []string{"Task", "Read", "Grep", "Glob", "Edit", "Write"},
	Skills: mabariSkills,
	Color:  "#0C0C0C",
	Instructions: "You are Mabari, the manager of this office. You manage every other agent and help each one get " +
		"better at its job.\n\nRouting: for each request, pick the best agent from its task, files, state and load, " +
		"or start one from the best matching built agent. Never do the work yourself and never approve risky " +
		"actions.\n\nManaging: watch every agent's progress, retries, errors and approvals. When an agent " +
		"struggles, tell the user what went wrong and what would help.\n\nImproving: use the agent-improver skill " +
		"to suggest clearer instructions, better tools or a better model for an agent. Use the agent-creator skill " +
		"when no agent fits a kind of work that keeps coming up. Always show the user the agent file and wait for " +
		"a yes before saving it.\n\nReporting: pass on every reply from Claude, Codex or any other AI in plain " +
		"language, and keep the user informed about finished tasks, approvals and errors.",
}

// Tools an agent file may list, as Claude Code names them.
var Tools = []string{"Read", "Grep", "Glob", "Edit", "Write", "Bash", "WebSearch", "WebFetch", "Task"}

// Models an agent file may name. "inherit" uses the session's model.
var Models = []string{"inherit", "sonnet", "opus", "haiku"}

// colours maps Mabari's swatches to the colour names Claude Code's files use.
var colours = []struct{ hex, name string }{
	{"#FF6B9A", "pink"}, {"#4FB3FF", "blue"}, {"#FFB547", "orange"}, {"#3FD07F", "green"},
	{"#FF8A5B", "red"}, {"#2DE1C2", "cyan"}, {"#FF8FCF", "purple"}, {"#B5E35B", "yellow"},
}

var validName = regexp.MustCompile(`^[a-z][a-z0-9-]{1,39}$`)

// codexName is a Codex agent's name: Codex's own examples use underscores, as in pr_explorer.
var codexName = regexp.MustCompile(`^[a-z][a-z0-9_-]{1,39}$`)

// plainKey is a front matter key written plainly, as Claude Code's own fields are.
var plainKey = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]*$`)

// Problem is a reason a definition can't be saved, worded for the person.
type Problem string

func (p Problem) Error() string { return string(p) }

// Project is a project's folder on this computer.
type Project struct {
	ID     string
	Folder string
}

// Folders says where the files live.
type Folders struct {
	// Account is Claude Code's agent folder, normally ~/.claude/agents.
	Account string
	// Codex is Codex's agent folder, normally ~/.codex/agents. Empty leaves Codex agents out.
	Codex string
	// State is agents-state.json in Mabari's data folder.
	State string
	// Home is the home folder, used to show paths with ~.
	Home string
}

// Report says how many agents a scan found in each place.
type Report struct {
	// Account counts the Claude account's agents, and Codex the Codex account's.
	Account  int            `json:"account"`
	Codex    int            `json:"codex"`
	Projects map[string]int `json:"projects"`
	// Problems are files that couldn't be read, by path.
	Problems []string `json:"problems"`
}

type stats struct {
	Runs int  `json:"runs"`
	Off  bool `json:"off,omitempty"`
}

// Library reads and writes agent files.
type Library struct {
	folders Folders

	mu       sync.Mutex
	projects []Project
	state    map[string]stats
	// files are the definitions the last scan found, by ID, with their real paths.
	files map[string]string
	// seen is what the folders looked like at the last scan, to notice changes.
	seen string
	// counts are how many agents each project's folder had at the last scan.
	counts map[string]int
}

// New makes a library.
func New(folders Folders) *Library {
	return &Library{folders: folders, state: map[string]stats{}, files: map[string]string{}}
}

// SetProjects says which projects have folders on this computer, for project agents.
func (l *Library) SetProjects(projects []Project) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.projects = slices.Clone(projects)
}

// ID names a Claude definition the same way on every start.
func ID(scope models.DefScope, project, name string) string {
	if scope == models.DefProject {
		return "project:" + project + ":" + name
	}
	return "account:" + name
}

// KindID names a definition of either kind. Codex ones start with codex:.
func KindID(kind models.DefKind, scope models.DefScope, project, name string) string {
	if kind == models.DefCodex {
		return "codex:" + ID(scope, project, name)
	}
	return ID(scope, project, name)
}

func (l *Library) projectFolder(id string) (string, bool) {
	for _, project := range l.projects {
		if project.ID == id && project.Folder != "" {
			return project.Folder, true
		}
	}
	return "", false
}

// expandHome turns a leading ~ into the home folder: projects keep paths the way people type them.
func expandHome(folder string) string {
	if folder == "~" || strings.HasPrefix(folder, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, strings.TrimPrefix(folder, "~"))
		}
	}
	return folder
}

// agentsDir is a project's Claude agent folder.
func agentsDir(folder string) string { return filepath.Join(expandHome(folder), ".claude", "agents") }

// samePath reports whether two folders are the same place.
func samePath(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	return filepath.Clean(expandHome(a)) == filepath.Clean(expandHome(b))
}

func kindOf(def models.AgentDef) models.DefKind {
	if def.Kind == models.DefCodex {
		return models.DefCodex
	}
	return models.DefClaude
}

func (l *Library) shown(path string) string {
	if l.folders.Home != "" {
		if rel, err := filepath.Rel(l.folders.Home, path); err == nil && !strings.HasPrefix(rel, "..") {
			return filepath.ToSlash(filepath.Join("~", rel))
		}
	}
	return filepath.ToSlash(path)
}

// Path is where a definition's file goes. A project without a folder has none.
func (l *Library) Path(def models.AgentDef) (string, error) {
	codex := kindOf(def) == models.DefCodex
	if def.Scope == models.DefProject {
		folder, ok := l.projectFolder(def.ProjectID)
		if !ok {
			return "", Problem("That project has no folder on this computer yet, so its agents have nowhere to go. " +
				"Pick the account instead, or give the project a folder.")
		}
		if codex {
			return filepath.Join(codexAgentsDir(folder), def.Name+".toml"), nil
		}
		return filepath.Join(agentsDir(folder), def.Name+".md"), nil
	}
	if codex {
		if l.folders.Codex == "" {
			return "", Problem("Codex's folder isn't known on this computer.")
		}
		return filepath.Join(l.folders.Codex, def.Name+".toml"), nil
	}
	return filepath.Join(l.folders.Account, def.Name+".md"), nil
}

// ShownPath is Path as the person reads it, with ~ for the home folder.
func (l *Library) ShownPath(def models.AgentDef) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	path, err := l.Path(def)
	if err != nil {
		return ""
	}
	return l.shown(path)
}

// Scan reads every agent folder, writes Mabari's own file if it is missing, and returns what it
// found, Mabari first. It never deletes or changes a file it didn't write.
func (l *Library) Scan() ([]models.AgentDef, Report, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	report := Report{Projects: map[string]int{}}
	if err := l.loadState(); err != nil {
		report.Problems = append(report.Problems, l.shown(l.folders.State)+": "+err.Error())
	}
	mabariPath := filepath.Join(l.folders.Account, MabariName+".md")
	if _, err := os.Stat(mabariPath); errors.Is(err, fs.ErrNotExist) {
		if err := writeAtomic(mabariPath, Render(mabariDefault)); err != nil {
			return nil, report, fmt.Errorf("write %s: %w", mabariPath, err)
		}
	}
	var defs []models.AgentDef
	files := map[string]string{}
	add := func(dir string, kind models.DefKind, scope models.DefScope, project string) int {
		read := readDir
		if kind == models.DefCodex {
			read = readCodexDir
		}
		found, problems := read(dir, scope, project)
		report.Problems = append(report.Problems, problems...)
		for _, def := range found {
			def.Kind = kind
			def.ID = KindID(kind, scope, project, def.Name)
			if _, twice := files[def.ID]; twice {
				continue
			}
			files[def.ID] = def.Path
			def.Path = l.shown(def.Path)
			def.Runs = l.state[def.ID].Runs
			def.Enabled = !l.state[def.ID].Off
			if kind == models.DefClaude && scope == models.DefAccount && def.Name == MabariName {
				def.System, def.Enabled, def.Skills, def.Color = true, true, withSkills(def.Skills), "#0C0C0C"
			}
			defs = append(defs, def)
		}
		return len(found)
	}
	report.Account = add(l.folders.Account, models.DefClaude, models.DefAccount, "")
	if l.folders.Codex != "" {
		report.Codex = add(l.folders.Codex, models.DefCodex, models.DefAccount, "")
	}
	for _, project := range l.projects {
		if project.Folder == "" {
			continue
		}
		count := 0
		// A project whose folder is the home folder would read the account's agents a second time.
		if dir := agentsDir(project.Folder); !samePath(dir, l.folders.Account) {
			count += add(dir, models.DefClaude, models.DefProject, project.ID)
		}
		if dir := codexAgentsDir(project.Folder); !samePath(dir, l.folders.Codex) {
			count += add(dir, models.DefCodex, models.DefProject, project.ID)
		}
		report.Projects[project.ID] = count
	}
	slices.SortStableFunc(defs, func(a, b models.AgentDef) int {
		switch {
		case a.System != b.System:
			if a.System {
				return -1
			}
			return 1
		case a.Scope != b.Scope:
			return cmp.Compare(a.Scope, b.Scope)
		case kindOf(a) != kindOf(b):
			return cmp.Compare(kindOf(a), kindOf(b))
		default:
			return cmp.Compare(a.Name, b.Name)
		}
	})
	l.files = files
	l.seen = l.signature()
	l.counts = maps.Clone(report.Projects)
	return defs, report, nil
}

// withSkills makes sure Mabari keeps its two skills even if its file lost the line.
func withSkills(skills []string) []string {
	out := slices.Clone(skills)
	for _, skill := range mabariSkills {
		if !slices.Contains(out, skill) {
			out = append(out, skill)
		}
	}
	return out
}

func readDir(dir string, scope models.DefScope, project string) ([]models.AgentDef, []string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, []string{dir + ": " + err.Error()}
	}
	var defs []models.AgentDef
	var problems []string
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		data, err := os.ReadFile(path) // #nosec G304 -- an agent file in an agent folder
		if err != nil {
			problems = append(problems, path+": "+err.Error())
			continue
		}
		def, err := Parse(data)
		if err != nil {
			problems = append(problems, path+": "+err.Error())
			continue
		}
		if def.Name == "" {
			def.Name = strings.TrimSuffix(entry.Name(), ".md")
		}
		if info, err := entry.Info(); err == nil {
			def.Updated = info.ModTime().UnixMilli()
		}
		def.Scope, def.ProjectID, def.Path = scope, project, path
		defs = append(defs, def)
	}
	return defs, problems
}

type frontMatter struct {
	Name        string `yaml:"name"`
	Description string `yaml:"description"`
	Tools       any    `yaml:"tools"`
	Model       string `yaml:"model"`
	Skills      any    `yaml:"skills"`
	Color       string `yaml:"color"`
}

// list reads a front matter list written either as "A, B" or as a YAML list.
func list(value any) []string {
	var out []string
	switch v := value.(type) {
	case string:
		for _, item := range strings.Split(v, ",") {
			if item = strings.TrimSpace(item); item != "" {
				out = append(out, item)
			}
		}
	case []any:
		for _, item := range v {
			if text := strings.TrimSpace(fmt.Sprint(item)); text != "" {
				out = append(out, text)
			}
		}
	}
	return out
}

func colourHex(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	for _, colour := range colours {
		if colour.name == name || strings.EqualFold(colour.hex, name) {
			return colour.hex
		}
	}
	return "#4FB3FF"
}

func colourName(hex string) string {
	for _, colour := range colours {
		if strings.EqualFold(colour.hex, hex) {
			return colour.name
		}
	}
	return "blue"
}

// plainLines reads front matter as one "key: value" per line, splitting at the first colon. It
// fails when a line has no key, so only files that are readable this way are accepted.
func plainLines(text string) (frontMatter, bool) {
	var front frontMatter
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) == "" || strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		key, value, found := strings.Cut(line, ":")
		if !found || strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") {
			return frontMatter{}, false
		}
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		switch strings.TrimSpace(key) {
		case "name":
			front.Name = value
		case "description":
			front.Description = value
		case "tools":
			front.Tools = value
		case "model":
			front.Model = value
		case "skills":
			front.Skills = value
		case "color":
			front.Color = value
		}
	}
	return front, front.Name != "" || front.Description != ""
}

// Parse reads an agent file: front matter between --- lines, then the instructions.
func Parse(data []byte) (models.AgentDef, error) {
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return models.AgentDef{}, errors.New("no front matter: the file should start with ---")
	}
	rest := text[len("---\n"):]
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return models.AgentDef{}, errors.New("the front matter has no closing ---")
	}
	var front frontMatter
	if err := yaml.Unmarshal([]byte(rest[:end]), &front); err != nil {
		// Claude Code reads "key: value" lines even when a value isn't strict YAML, such as a
		// description with a colon in it, so Mabari reads them the same way.
		var ok bool
		if front, ok = plainLines(rest[:end]); !ok {
			return models.AgentDef{}, fmt.Errorf("the front matter isn't valid YAML: %w", err)
		}
	}
	body := rest[end+len("\n---"):]
	body = strings.TrimPrefix(strings.TrimLeft(body, "-"), "\n")
	model := strings.TrimSpace(front.Model)
	if model == "" {
		model = "inherit"
	}
	return models.AgentDef{
		Name:         strings.TrimSpace(front.Name),
		Description:  strings.TrimSpace(front.Description),
		Model:        model,
		Tools:        list(front.Tools),
		Skills:       list(front.Skills),
		Color:        colourHex(front.Color),
		Instructions: strings.TrimSpace(body),
	}, nil
}

// yamlText writes a value on one front matter line, quoting it only when YAML needs that.
func yamlText(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	plain := value != "" && !strings.ContainsAny(value[:1], "!&*?|>'\"%@`#{}[],-") &&
		!strings.Contains(value, ": ") && !strings.Contains(value, " #") && !strings.HasSuffix(value, ":")
	if plain {
		var back string
		if yaml.Unmarshal([]byte("v: "+value), &struct {
			V *string `yaml:"v"`
		}{V: &back}) == nil && back == value {
			return value
		}
	}
	return strconv.Quote(value)
}

// Render writes a definition as an agent file, in the prototype's order.
func Render(def models.AgentDef) []byte {
	var b bytes.Buffer
	b.WriteString("---\n")
	b.WriteString("name: " + def.Name + "\n")
	b.WriteString("description: " + yamlText(def.Description) + "\n")
	b.WriteString("tools: " + strings.Join(def.Tools, ", ") + "\n")
	model := def.Model
	if model == "" {
		model = "inherit"
	}
	b.WriteString("model: " + model + "\n")
	if len(def.Skills) > 0 {
		b.WriteString("skills: " + strings.Join(def.Skills, ", ") + "\n")
	}
	b.WriteString("color: " + colourName(def.Color) + "\n")
	b.WriteString("---\n\n")
	b.WriteString(strings.TrimSpace(def.Instructions) + "\n")
	return b.Bytes()
}

// known are the front matter fields Mabari writes itself.
var known = map[string]bool{"name": true, "description": true, "tools": true, "model": true, "skills": true, "color": true}

// extraFields are the front matter lines of fields Mabari doesn't write, with any lines that
// continue them, exactly as they were.
func extraFields(data []byte) string {
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return ""
	}
	rest := text[len("---\n"):]
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return ""
	}
	var b strings.Builder
	keep := false
	for _, line := range strings.Split(rest[:end], "\n") {
		if line != "" && line[0] != ' ' && line[0] != '\t' {
			// Only a plain key is kept, never a quoted, tagged, anchored or complex one, and never
			// any spelling of a field Mabari writes, so nothing kept can override those fields.
			key, _, found := strings.Cut(line, ":")
			keep = found && plainKey.MatchString(key) && !known[strings.ToLower(key)]
		}
		if keep {
			b.WriteString(line + "\n")
		}
	}
	return b.String()
}

// sameFolder reports whether two definition IDs are in the same scope and project.
func sameFolder(a, b string) bool {
	folder := func(id string) string { return id[:strings.LastIndex(id, ":")+1] }
	return folder(a) == folder(b)
}

// withExtra puts kept fields at the end of a rendered file's front matter.
func withExtra(content []byte, extra string) []byte {
	if extra == "" {
		return content
	}
	text := string(content)
	closing := strings.Index(text, "\n---\n")
	return []byte(text[:closing+1] + extra + text[closing+1:])
}

// writeAtomic writes a whole file or nothing: a temporary file beside it, synced, then renamed.
func writeAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	temp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	name := temp.Name()
	defer func() { _ = os.Remove(name) }()
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(name, 0o644); err != nil { // #nosec G302 -- Claude Code reads agent files like its own
		return err
	}
	return os.Rename(name, path)
}

// Check says what is wrong with a definition before it is saved, in plain words.
func Check(def models.AgentDef) error {
	switch {
	case kindOf(def) == models.DefClaude && !validName.MatchString(def.Name),
		kindOf(def) == models.DefCodex && !codexName.MatchString(def.Name):
		return Problem("Give it a short name in lowercase letters, like code-reviewer.")
	case strings.TrimSpace(def.Description) == "":
		return Problem("Say when Claude should use it, so it gets picked for the right work.")
	case kindOf(def) == models.DefClaude && len(def.Tools) == 0:
		return Problem("Pick at least one tool.")
	case strings.TrimSpace(def.Instructions) == "":
		return Problem("Write the agent's instructions.")
	case def.Scope != models.DefAccount && def.Scope != models.DefProject:
		return Problem("Pick where it lives: the Claude account or one project.")
	case kindOf(def) == models.DefClaude && !slices.Contains(Models, cmp.Or(def.Model, "inherit")):
		return Problem("Pick a model: same as the session, Sonnet, Opus or Haiku.")
	case kindOf(def) == models.DefCodex:
		if err := checkCodex(def); err != nil {
			return err
		}
	}
	for _, tool := range def.Tools {
		if !slices.Contains(Tools, tool) {
			return Problem("Mabari doesn't know the tool " + strconv.Quote(tool) + ".")
		}
	}
	// Skills are written into the front matter as they are, so each must be a plain name: nothing
	// that could end the line and add another field.
	for _, skill := range def.Skills {
		if !validName.MatchString(skill) {
			return Problem("Skill names are lowercase words with dashes, like agent-improver.")
		}
	}
	return nil
}

// Save writes a definition's file. previousID is the definition being edited, or empty for a new
// one. Renaming or moving an agent removes its old file. Mabari's own name and scope can't change.
func (l *Library) Save(def models.AgentDef, previousID string) (models.AgentDef, error) {
	def.Name = strings.TrimSpace(def.Name)
	if def.Scope == models.DefAccount {
		def.ProjectID = ""
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	def.Kind = kindOf(def)
	if def.Kind == models.DefCodex {
		def.Tools, def.Skills = []string{}, []string{}
	}
	if previousID == ID(models.DefAccount, "", MabariName) {
		def.Kind = models.DefClaude
		def.Name, def.Scope, def.ProjectID, def.Skills = MabariName, models.DefAccount, "", withSkills(def.Skills)
	} else if def.Kind == models.DefClaude && def.Scope == models.DefAccount && def.Name == MabariName {
		return models.AgentDef{}, Problem("mabari is the office manager's name. Pick another one.")
	}
	if err := Check(def); err != nil {
		return models.AgentDef{}, err
	}
	path, err := l.Path(def)
	if err != nil {
		return models.AgentDef{}, err
	}
	id := KindID(def.Kind, def.Scope, def.ProjectID, def.Name)
	// An agent's file name needn't match its name (Codex says the name inside is what counts), so
	// an edit that keeps the agent where it is writes back to its own file.
	if old, ok := l.files[previousID]; ok && previousID == id {
		path = old
	}
	if id != previousID {
		if _, taken := l.files[id]; taken {
			return models.AgentDef{}, Problem("There is already an agent called " + def.Name + " in this scope.")
		}
		if _, err := os.Stat(path); err == nil {
			return models.AgentDef{}, Problem("There is already an agent file at " + l.shown(path) + ".")
		}
	}
	content := Render(def)
	if def.Kind == models.DefCodex {
		content = RenderCodex(def)
	}
	if old, ok := l.files[previousID]; ok && previousID != "" && sameFolder(previousID, id) {
		// Keep the fields Mabari doesn't edit, such as Claude Code's effort or permissionMode,
		// but only while the agent stays where it was: moving it to another scope, project or AI
		// doesn't carry settings the builder never showed.
		if data, err := os.ReadFile(old); err == nil { // #nosec G304 -- the agent's own file
			if def.Kind == models.DefCodex {
				if extra, err := codexExtra(data); err == nil {
					content = withCodexExtra(content, extra)
				}
			} else {
				content = withExtra(content, extraFields(data))
			}
		}
	}
	if err := writeAtomic(path, content); err != nil {
		return models.AgentDef{}, fmt.Errorf("save %s: %w", l.shown(path), err)
	}
	if old, ok := l.files[previousID]; ok && previousID != "" && previousID != id {
		if err := os.Remove(old); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return models.AgentDef{}, fmt.Errorf("remove the old file %s: %w", l.shown(old), err)
		}
		delete(l.files, previousID)
		if kept, ok := l.state[previousID]; ok {
			l.state[id] = kept
			delete(l.state, previousID)
		}
	}
	l.files[id] = path
	if err := l.saveState(); err != nil {
		return models.AgentDef{}, err
	}
	def.ID, def.Path = id, l.shown(path)
	return def, nil
}

// Delete removes an agent's file. Mabari can't be deleted.
func (l *Library) Delete(id string) error {
	if id == ID(models.DefAccount, "", MabariName) {
		return Problem("Mabari is built in, so it can't be deleted.")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	path, ok := l.files[id]
	if !ok {
		return Problem("That agent's file is gone already.")
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("delete %s: %w", l.shown(path), err)
	}
	delete(l.files, id)
	delete(l.state, id)
	return l.saveState()
}

// SetEnabled turns an agent on or off for Mabari. The file stays as it is.
func (l *Library) SetEnabled(id string, on bool) error {
	if id == ID(models.DefAccount, "", MabariName) && !on {
		return Problem("Mabari is built in, so it can't be turned off.")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.state[id]
	entry.Off = !on
	l.state[id] = entry
	return l.saveState()
}

// CountRun adds one to an agent's runs.
func (l *Library) CountRun(id string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.state[id]
	entry.Runs++
	l.state[id] = entry
	return l.saveState()
}

func (l *Library) loadState() error {
	data, err := os.ReadFile(l.folders.State)
	if errors.Is(err, fs.ErrNotExist) {
		l.state = map[string]stats{}
		return nil
	}
	if err != nil {
		return err
	}
	state := map[string]stats{}
	if err := json.Unmarshal(data, &state); err != nil {
		return fmt.Errorf("not valid JSON, so run counts start again: %w", err)
	}
	l.state = state
	return nil
}

func (l *Library) saveState() error {
	data, err := json.MarshalIndent(l.state, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(l.folders.State, append(data, '\n'))
}

// signature is every agent file's name, size and time, so a change anywhere shows.
func (l *Library) signature() string {
	var b strings.Builder
	dirs := []string{l.folders.Account, l.folders.Codex}
	for _, project := range l.projects {
		if project.Folder != "" {
			dirs = append(dirs, agentsDir(project.Folder), codexAgentsDir(project.Folder))
		}
	}
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		b.WriteString(dir + "\n")
		entries, _ := os.ReadDir(dir)
		for _, entry := range entries {
			if !strings.HasSuffix(entry.Name(), ".md") && !strings.HasSuffix(entry.Name(), ".toml") {
				continue
			}
			if info, err := entry.Info(); err == nil {
				fmt.Fprintf(&b, "%s %d %d\n", entry.Name(), info.Size(), info.ModTime().UnixNano())
			}
		}
	}
	return b.String()
}

// Changed reports whether the folders differ from the last scan, including a new project folder.
// Checking every second or two beats a file system watcher here: it needs no handle per project
// folder, works the same on every system, and notices folders that don't exist yet.
func (l *Library) Changed() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.signature() != l.seen
}

// Office is the live office the definitions are shown in.
type Office interface {
	Do(work func()) error
	Projects() []*models.Project
	SetDefs(defs []models.AgentDef)
}

func foldersOf(office Office) []Project {
	var projects []Project
	_ = office.Do(func() {
		for _, project := range office.Projects() {
			if project.Repository != nil && project.Repository.Path != "" {
				projects = append(projects, Project{ID: project.ID, Folder: project.Repository.Path})
			}
		}
	})
	return projects
}

// Refresh reads the folders again and shows what it found in the office.
func (l *Library) Refresh(office Office) (Report, error) {
	l.SetProjects(foldersOf(office))
	defs, report, err := l.Scan()
	if err != nil {
		return report, err
	}
	err = office.Do(func() { office.SetDefs(defs) })
	return report, err
}

// Keep refreshes whenever a file changes or a project gains a folder, until ctx ends. When a
// project's repository brings agents with it, the office hears about it.
func (l *Library) Keep(ctx context.Context, office Office, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	// known are the projects whose folders the library has read before. Only a folder read for
	// the first time, as when a project is made or its repository arrives, is announced; agents
	// the person builds later are theirs, not news.
	l.mu.Lock()
	known := map[string]bool{}
	for id := range l.counts {
		known[id] = true
	}
	l.mu.Unlock()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			l.SetProjects(foldersOf(office))
			if !l.Changed() {
				continue
			}
			report, err := l.Refresh(office)
			if err != nil {
				slog.Warn("could not read the agent folders", "error", err)
				continue
			}
			l.announce(office, known, report)
		}
	}
}

// Announcer is an office that can say things in a toast.
type Announcer interface {
	Toast(text string)
}

// announce says when a project's folder, read for the first time, brought agents with it.
func (l *Library) announce(office Office, known map[string]bool, report Report) {
	for id, count := range report.Projects {
		if known[id] {
			continue
		}
		known[id] = true
		if count == 0 {
			continue
		}
		toaster, ok := office.(Announcer)
		if !ok {
			continue
		}
		_ = office.Do(func() {
			name := id
			for _, project := range office.Projects() {
				if project.ID == id {
					name = project.Name
				}
			}
			added := count
			noun := "agents"
			if added == 1 {
				noun = "agent"
			}
			toaster.Toast("Loaded " + strconv.Itoa(added) + " " + noun + " from " + name + "'s repository. They're in the agent builder.")
		})
	}
}
