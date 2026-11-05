// SPDX-License-Identifier: Apache-2.0

package agentdefs

// Codex custom agents, from the Codex docs (learn.chatgpt.com/docs/agent-configuration/subagents,
// checked 2026-11-05): one TOML file per agent, in ~/.codex/agents for personal agents and in
// <project>/.codex/agents for project agents. Every file needs name, description and
// developer_instructions; model and other settings are optional. Codex files have no tools list,
// and an agent inherits the parent session's permissions and MCP servers.

import (
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/pelletier/go-toml/v2"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// codexKnown are the keys Mabari writes in a Codex agent file. Any other key is kept as it was.
var codexKnown = []string{"name", "description", "model", "developer_instructions"}

// codexModel is a model name a Codex file may carry.
var codexModel = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$`)

func codexAgentsDir(folder string) string {
	return filepath.Join(expandHome(folder), ".codex", "agents")
}

// ParseCodex reads a Codex agent file.
func ParseCodex(data []byte) (models.AgentDef, error) {
	var file struct {
		Name                  string `toml:"name"`
		Description           string `toml:"description"`
		Model                 string `toml:"model"`
		DeveloperInstructions string `toml:"developer_instructions"`
	}
	if err := toml.Unmarshal(data, &file); err != nil {
		return models.AgentDef{}, fmt.Errorf("not valid TOML: %w", err)
	}
	model := strings.TrimSpace(file.Model)
	if model == "" {
		model = "inherit"
	}
	return models.AgentDef{
		Kind:         models.DefCodex,
		Name:         strings.TrimSpace(file.Name),
		Description:  strings.TrimSpace(file.Description),
		Model:        model,
		Tools:        []string{},
		Skills:       []string{},
		Instructions: strings.TrimSpace(file.DeveloperInstructions),
		Color:        "#3FD07F",
	}, nil
}

// tomlString writes a basic TOML string on one line.
func tomlString(value string) string {
	return strconv.Quote(strings.Join(strings.Fields(value), " "))
}

// tomlBlock writes a multi-line basic TOML string. Every backslash and quote is escaped, so no
// text can end the string early, and control characters other than tabs and newlines are written
// as escapes.
func tomlBlock(value string) string {
	var b strings.Builder
	b.WriteString("\"\"\"\n")
	for _, r := range strings.TrimSpace(value) {
		switch {
		case r == '\\':
			b.WriteString(`\\`)
		case r == '"':
			b.WriteString(`\"`)
		case r == '\n' || r == '\t':
			b.WriteRune(r)
		case unicode.IsControl(r):
			fmt.Fprintf(&b, `\u%04X`, r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteString("\n\"\"\"\n")
	return b.String()
}

// RenderCodex writes a definition as a Codex agent file.
func RenderCodex(def models.AgentDef) []byte {
	var b strings.Builder
	b.WriteString("name = " + tomlString(def.Name) + "\n")
	b.WriteString("description = " + tomlString(def.Description) + "\n")
	if def.Model != "" && def.Model != "inherit" {
		b.WriteString("model = " + tomlString(def.Model) + "\n")
	}
	b.WriteString("developer_instructions = " + tomlBlock(def.Instructions))
	return []byte(b.String())
}

// codexExtra is the rest of an existing Codex file: every key Mabari doesn't write, such as
// model_reasoning_effort or a [skills.config] table, written back as TOML.
func codexExtra(data []byte) ([]byte, error) {
	var file map[string]any
	if err := toml.Unmarshal(data, &file); err != nil {
		return nil, err
	}
	rest := maps.Clone(file)
	for _, key := range codexKnown {
		delete(rest, key)
	}
	if len(rest) == 0 {
		return nil, nil
	}
	return toml.Marshal(rest)
}

// withCodexExtra adds the kept settings after Mabari's own keys. Top-level keys come before any
// table in TOML, and Mabari's keys are all top level, so the kept part simply follows.
func withCodexExtra(content, extra []byte) []byte {
	if len(extra) == 0 {
		return content
	}
	return append(append(content, '\n'), extra...)
}

// checkCodex says what is wrong with a Codex definition, in plain words.
func checkCodex(def models.AgentDef) error {
	if def.Model != "" && def.Model != "inherit" && !codexModel.MatchString(def.Model) {
		return Problem("Pick a Codex model, such as gpt-5-codex, or the session's own.")
	}
	return nil
}

func readCodexDir(dir string, scope models.DefScope, project string) ([]models.AgentDef, []string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, []string{dir + ": " + err.Error()}
	}
	var defs []models.AgentDef
	var problems []string
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".toml") {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		data, err := os.ReadFile(path) // #nosec G304 -- an agent file in an agent folder
		if err != nil {
			problems = append(problems, path+": "+err.Error())
			continue
		}
		def, err := ParseCodex(data)
		if err != nil {
			problems = append(problems, path+": "+err.Error())
			continue
		}
		if def.Name == "" {
			def.Name = strings.TrimSuffix(entry.Name(), ".toml")
		}
		if info, err := entry.Info(); err == nil {
			def.Updated = info.ModTime().UnixMilli()
		}
		def.Scope, def.ProjectID, def.Path = scope, project, path
		defs = append(defs, def)
	}
	return defs, problems
}
