// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/SamsonIdowu/mabari/internal/launch"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/planner"
	"github.com/SamsonIdowu/mabari/internal/workspace"
)

// launchWait is how long opening a terminal may take.
const launchWait = 15 * time.Second

// projectFolder makes sure a project's folder exists, creating it for a project started from
// scratch, and returns it as a full path.
func projectFolder(folder string) (string, error) {
	path, err := workspace.Expand(folder)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(path, 0o750); err != nil {
		return "", err
	}
	return path, nil
}

// briefFor is the first prompt a project's Claude Code session gets: the brief, the project's
// instructions and the planner's team, so the lead starts where the plan left off.
func briefFor(name string, body startBody) string {
	var b strings.Builder
	b.WriteString("You are the lead for the project " + name + ".")
	if brief := strings.TrimSpace(body.Brief); brief != "" {
		b.WriteString("\n\nWhat to build: " + brief)
	}
	if instructions := strings.TrimSpace(body.Instructions); instructions != "" {
		b.WriteString("\n\nProject instructions:\n" + instructions)
	}
	if task := strings.TrimSpace(body.Plan.LeadTask); task != "" {
		b.WriteString("\n\nYour job: " + task + ".")
	}
	var team []planner.Member
	for _, member := range body.Plan.Members {
		if member.On {
			team = append(team, member)
		}
	}
	if len(team) > 0 {
		b.WriteString("\n\nMabari's planner suggests this team. Start a subagent for each when its work comes up:")
		for _, member := range team {
			b.WriteString("\n- " + member.Label + ": " + member.Task)
		}
	}
	if body.Mode == "plan" {
		b.WriteString("\n\nStart by writing a plan for the person to approve.")
	}
	return b.String()
}

// openClaude opens Claude Code in a project's folder and says what happened, in words for a toast,
// and whether a session is on its way. Call outside Do: it waits for the terminal to open.
func (a *api) openClaude(name, folder, prompt string, plan bool) (string, bool) {
	return a.openClaudeAs(name, folder, prompt, plan, "")
}

// openClaudeAs is openClaude with the session running as an agent file, by its name.
func (a *api) openClaudeAs(name, folder, prompt string, plan bool, agent string) (string, bool) {
	command := "claude"
	if agent != "" {
		command = "claude --agent " + agent
	}
	byHand := "Run " + command + " in " + folder + ". The session joins " + name + " when it starts."
	if agent != "" {
		byHand = "Run " + command + " in " + folder + " and give it the task. It joins " + name +
			" and takes the free desk when it starts."
	}
	// Without a launcher, as in Docker and in tests, Mabari only says how to start.
	if a.launcher == nil {
		return byHand, false
	}
	path, err := projectFolder(folder)
	if err != nil {
		return "Couldn't make the folder " + folder + ": " + err.Error(), false
	}
	ctx, cancel := context.WithTimeout(context.Background(), launchWait)
	defer cancel()
	err = a.launcher.Claude(ctx, launch.Request{Folder: path, Name: name, Prompt: prompt, Plan: plan, Agent: agent})
	switch {
	case errors.Is(err, launch.ErrNoTerminal):
		return byHand, false
	case err != nil:
		return "Couldn't open Claude Code (" + err.Error() + "). " + byHand, false
	}
	_ = a.engine.Do(func() {
		a.engine.Log(name, models.LogSession, "claude in "+folder, "Opened Claude Code", "ok")
	})
	return "Opened Claude Code in " + folder + ". It joins " + name + " as soon as it starts.", true
}

// messageProblem says what is wrong with any message for an agent, or "" when it is fine.
func messageProblem(text string) string {
	switch {
	case text == "":
		return "A message needs some text."
	case len(text) > maxPrompt:
		return "That's too long to send. Keep it under 20,000 characters."
	}
	return ""
}

// promptProblem says what is wrong with a prompt that goes on Claude Code's command line, or ""
// when it is fine.
func promptProblem(prompt string) string {
	switch {
	case prompt == "":
		return "A message needs some text."
	case strings.IndexFunc(prompt, func(r rune) bool {
		return r != '\n' && r != '\t' && (r < 0x20 || r == 0x7f)
	}) >= 0:
		return "A prompt can't contain control characters."
	// The prompt follows "--"; refusing a leading dash as well means it can't be a flag even if
	// Claude Code ever read options after "--".
	case strings.HasPrefix(prompt, "-"):
		return "A prompt can't start with a dash."
	case len(prompt) > maxPrompt:
		return "That's too long to send. Keep it under 20,000 characters."
	}
	return ""
}

// maxPrompt is the longest prompt Mabari passes on, in bytes.
const maxPrompt = 20000

// openProjectClaude opens Claude Code in an existing project's folder.
func (a *api) openProjectClaude(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Prompt string `json:"prompt"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	var project models.Project
	var found bool
	_ = a.engine.Do(func() {
		if existing := a.engine.Project(r.PathValue("id")); existing != nil {
			project, found = *existing, true
		}
	})
	switch {
	case !found:
		writeError(w, http.StatusNotFound, "no such project")
		return
	case project.Repository == nil || project.Repository.Path == "":
		writeError(w, http.StatusBadRequest, "Attach a folder to "+project.Name+" first.")
		return
	}
	prompt := strings.TrimSpace(body.Prompt)
	if problem := promptProblem(prompt); prompt != "" && problem != "" {
		writeError(w, http.StatusBadRequest, problem)
		return
	}
	if prompt == "" {
		prompt = "You are working on the project " + project.Name + "."
		if instructions := strings.TrimSpace(project.Instructions); instructions != "" {
			prompt += "\n\nProject instructions:\n" + instructions
		}
		prompt += "\n\nLook around this folder and say what you find, then wait for instructions."
	}
	notice, _ := a.openClaude(project.Name, project.Repository.Path, prompt, false)
	writeJSON(w, http.StatusOK, map[string]string{"notice": notice})
}

// attachFolder gives an existing project a folder on this computer. Sessions already working in
// it join the project, and the agents in its .claude/agents and .codex/agents load. Call inside Do.
func (a *api) attachFolder(project *models.Project, folder string) string {
	folder = workspace.Clean(folder)
	if !workspace.Valid(folder, false) {
		return "Use a full path such as ~/code/shop."
	}
	if _, err := workspace.Look(mustExpand(folder)); err != nil {
		return err.Error()
	}
	project.Repository = &models.Repository{Path: folder}
	root := mustExpand(folder)
	for _, agent := range a.engine.Agents() {
		if agent.Folder != "" && withinFolder(agent.Folder, root) {
			id := project.ID
			agent.Project = &id
			a.engine.Touch(agent)
		}
	}
	return ""
}

func mustExpand(folder string) string {
	path, err := workspace.Expand(folder)
	if err != nil {
		return folder
	}
	return path
}

// withinFolder reports whether path is folder or inside it.
func withinFolder(path, folder string) bool {
	path, folder = strings.TrimRight(mustExpand(path), "/"), strings.TrimRight(folder, "/")
	return path == folder || strings.HasPrefix(path, folder+"/")
}
