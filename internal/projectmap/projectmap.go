// SPDX-License-Identifier: Apache-2.0

// Package projectmap is Mabari's map of every project: where each one lives, who works there and
// on what, what waits to be delivered, what finished lately, and the agent files it keeps, with
// what Mabari itself has been asked to do. Mabari answers and routes from it on Home, hands it
// to every Claude Code session running as Mabari when the session starts, and keeps it in
// map.md in its data folder for any AI to read.
package projectmap

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
)

// Map is the office's projects and Mabari's own work, at one moment.
type Map struct {
	// At is when it was made, in Unix milliseconds.
	At       int64     `json:"at"`
	Projects []Project `json:"projects"`
	// Elsewhere is the agents working in no project.
	Elsewhere []Agent `json:"elsewhere"`
	// Mabari is what Mabari was asked lately and where it sent each request, newest first.
	Mabari []Request `json:"mabari"`
}

// Project is one project on the map.
type Project struct {
	ID       string           `json:"id"`
	Name     string           `json:"name"`
	Folder   string           `json:"folder"`
	Status   string           `json:"status"`
	Progress float64          `json:"progress"`
	Estimate *models.Estimate `json:"estimate"`
	// Brief is the start of the project's instructions.
	Brief string `json:"brief"`
	// Agents are who work there now, the busiest first.
	Agents []Agent `json:"agents"`
	// Waiting are instructions and prompts not yet delivered.
	Waiting []string `json:"waiting"`
	// Finished are the latest tasks finished there, newest first.
	Finished []string `json:"finished"`
	// AgentFiles are the agents the project keeps in its folder.
	AgentFiles []string `json:"agentFiles"`
}

// Agent is an agent on the map and its task.
type Agent struct {
	Name    string `json:"name"`
	State   string `json:"state"`
	Task    string `json:"task"`
	Working bool   `json:"working"`
}

// Request is something Mabari was asked and where it went.
type Request struct {
	Text    string `json:"text"`
	Outcome string `json:"outcome"`
}

const (
	briefLength  = 280
	finishedKept = 5
	requestsKept = 8
)

// Build makes the map from the office as it is. The log is newest first.
func Build(projects []*models.Project, agents []*models.LiveAgent, defs []models.AgentDef,
	log []models.LogEntry, now time.Time) Map {
	m := Map{At: now.UnixMilli(), Projects: []Project{}, Elsewhere: []Agent{}, Mabari: []Request{}}
	for _, project := range projects {
		if project.Done != nil {
			continue
		}
		entry := Project{
			ID: project.ID, Name: project.Name, Status: string(project.Status),
			Progress: project.Progress, Estimate: project.Estimate,
			Brief: clip(project.Instructions, briefLength), Agents: []Agent{}, Waiting: []string{},
			Finished: []string{}, AgentFiles: []string{},
		}
		if project.Repository != nil {
			entry.Folder = project.Repository.Path
		}
		for _, agent := range agents {
			if agent.Project == nil || *agent.Project != project.ID || agent.Leaving {
				continue
			}
			entry.Agents = append(entry.Agents, agentOf(agent))
			for _, instruction := range agent.Queued {
				entry.Waiting = append(entry.Waiting, agent.Name+": "+clip(instruction.Text, 160))
			}
		}
		for _, opening := range project.Opening {
			entry.Waiting = append(entry.Waiting, "a new Claude Code session: "+clip(opening.Text, 160))
		}
		// What finished there lately, from the agents' own steps, newest first.
		var finished []models.Event
		for _, agent := range agents {
			if agent.Project == nil || *agent.Project != project.ID {
				continue
			}
			for _, event := range agent.Feed {
				if event.Tool == "done" {
					event.Summary = agent.Name + ": " + clip(strings.TrimPrefix(event.Summary, "Finished: "), 160)
					finished = append(finished, event)
				}
			}
		}
		sort.SliceStable(finished, func(i, j int) bool { return finished[i].Time > finished[j].Time })
		for _, event := range finished[:min(len(finished), finishedKept)] {
			entry.Finished = append(entry.Finished, event.Summary)
		}
		for _, def := range defs {
			if def.Scope == models.DefProject && def.ProjectID == project.ID && def.Enabled {
				entry.AgentFiles = append(entry.AgentFiles, def.Name)
			}
		}
		busiestFirst(entry.Agents)
		m.Projects = append(m.Projects, entry)
	}
	for _, agent := range agents {
		if agent.Project == nil && !agent.Leaving && agent.Desk >= 0 {
			m.Elsewhere = append(m.Elsewhere, agentOf(agent))
		}
	}
	busiestFirst(m.Elsewhere)
	for _, row := range log {
		if len(m.Mabari) == requestsKept {
			break
		}
		if row.Agent == "Mabari" && row.Type == models.LogInstruction {
			m.Mabari = append(m.Mabari, Request{Text: clip(row.Message, 160), Outcome: row.Outcome})
		}
	}
	return m
}

func agentOf(agent *models.LiveAgent) Agent {
	return Agent{
		Name: agent.Name, State: strings.ToLower(models.StateLabels[agent.State]),
		Task: clip(agent.Task, 160), Working: agent.Working || agent.State.Active(),
	}
}

func busiestFirst(agents []Agent) {
	sort.SliceStable(agents, func(i, j int) bool { return agents[i].Working && !agents[j].Working })
}

func clip(text string, limit int) string {
	text = strings.Join(strings.Fields(text), " ")
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit-1]) + "…"
}

// Markdown writes the map for an AI to read, as map.md and at the start of a Mabari session.
// The numbers in it are the server's own; this only puts them into words.
func (m Map) Markdown() string {
	var b strings.Builder
	b.WriteString("# Mabari's map of the projects\n\n")
	b.WriteString("Kept up to date by Mabari, the office manager. Use it to know what each project is, ")
	b.WriteString("where it lives and what is being done in it, and to send work to the right project.\n")
	for _, project := range m.Projects {
		fmt.Fprintf(&b, "\n## %s\n\n", project.Name)
		if project.Folder != "" {
			fmt.Fprintf(&b, "- Folder: %s\n", project.Folder)
		} else {
			b.WriteString("- Folder: none attached yet\n")
		}
		status := fmt.Sprintf("- Status: %s, %d%% done", project.Status, int(project.Progress*100+0.5))
		if project.Estimate != nil {
			status += fmt.Sprintf(", about %s left", minutes(project.Estimate.SecondsLeft))
		}
		b.WriteString(status + "\n")
		if project.Brief != "" {
			fmt.Fprintf(&b, "- Brief: %s\n", project.Brief)
		}
		if len(project.AgentFiles) > 0 {
			fmt.Fprintf(&b, "- Its agents: %s\n", strings.Join(project.AgentFiles, ", "))
		}
		list(&b, "Working there", agentLines(project.Agents))
		list(&b, "Waiting to be delivered", project.Waiting)
		list(&b, "Finished lately", project.Finished)
	}
	if len(m.Elsewhere) > 0 {
		b.WriteString("\n## Outside any project\n")
		list(&b, "Working", agentLines(m.Elsewhere))
	}
	if len(m.Mabari) > 0 {
		b.WriteString("\n## Mabari's own tasks\n\nWhat Mabari was asked lately, newest first, and where it went:\n\n")
		for _, request := range m.Mabari {
			fmt.Fprintf(&b, "- %s (%s)\n", request.Text, request.Outcome)
		}
	}
	if len(m.Projects) == 0 && len(m.Elsewhere) == 0 {
		b.WriteString("\nThere are no projects yet.\n")
	}
	return b.String()
}

// Brief is the map cut to fit at the start of a session: the whole map when it is short, or its
// first part, saying where the rest is.
func (m Map) Brief(limit int, where string) string {
	text := m.Markdown()
	if len([]rune(text)) <= limit {
		return text
	}
	cut := string([]rune(text)[:limit])
	if at := strings.LastIndex(cut, "\n"); at > 0 {
		cut = cut[:at]
	}
	return cut + "\n\nThe rest of the map is in " + where + "."
}

func agentLines(agents []Agent) []string {
	lines := make([]string, 0, len(agents))
	for _, agent := range agents {
		line := agent.Name + ", " + agent.State
		if agent.Task != "" {
			line += ": " + agent.Task
		}
		lines = append(lines, line)
	}
	return lines
}

func list(b *strings.Builder, title string, lines []string) {
	if len(lines) == 0 {
		return
	}
	fmt.Fprintf(b, "\n%s:\n\n", title)
	for _, line := range lines {
		fmt.Fprintf(b, "- %s\n", line)
	}
}

func minutes(seconds int64) string {
	m := max(1, (seconds+30)/60)
	if m < 60 {
		return fmt.Sprintf("%d min", m)
	}
	return fmt.Sprintf("%d h %d min", m/60, m%60)
}

// File is where the map is kept in Mabari's data folder.
func File(dataDir string) string { return filepath.Join(dataDir, "map.md") }

// Keep writes the map to path now and every `every` while it changes, until ctx ends, so any AI
// on this computer can read it. The file is only for this person: 0600.
func Keep(ctx context.Context, engine *events.Engine, path string, every time.Duration) {
	last := ""
	write := func() {
		var text string
		if err := engine.Do(func() { text = Of(engine).Markdown() }); err != nil || text == last {
			return
		}
		if err := writeFile(path, text); err != nil {
			slog.Warn("could not write the project map", "path", path, "error", err)
			return
		}
		last = text
	}
	write()
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			write()
		}
	}
}

// Of is the map of the office as the engine has it now. Call inside Do.
func Of(engine *events.Engine) Map {
	return Build(engine.Projects(), engine.Agents(), engine.Defs(), engine.RecentLog(200), engine.Now())
}

// writeFile replaces the file in one step, so a reader never sees half a map.
func writeFile(path, text string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".map-*.md")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(temp.Name()) }()
	if _, err := temp.WriteString(text); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(temp.Name(), path)
}
