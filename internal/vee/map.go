// SPDX-License-Identifier: Apache-2.0

package vee

import (
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/projectmap"
)

// asksForMap is a question about the projects or the work in them: "what projects do we have",
// "what tasks are there", "show me the map", "what's being done in Shop".
func asksForMap(q string) bool {
	return has(q, "project map", "the map", "map of", "projects", "tasks", "task list", "being done",
		"working on", "work on in", "what's in", "whats in", "what is in")
}

// fromMap answers from Mabari's map of the projects: every project in a line, or, for the
// project named or picked on Home, who works there and on what, what waits to be delivered and
// what finished lately. The numbers are the server's; this only puts them into words.
func (o view) fromMap(text string, in Office, now time.Time) Reply {
	m := projectmap.Build(in.Projects, in.Agents, nil, nil, now)
	project := mentioned(text, open(in.Projects))
	id := ""
	if project != nil {
		id = project.ID
	} else if in.InView != "" && in.InView != AnyProject {
		id = in.InView
	}
	for _, entry := range m.Projects {
		if entry.ID == id {
			return o.projectFromMap(entry, in)
		}
	}
	if len(m.Projects) == 0 {
		return o.reply("There are no projects yet. Say \"new project\" and describe what you want built.",
			"shrug", KindPlain)
	}
	parts := make([]string, 0, len(m.Projects))
	for _, entry := range m.Projects {
		parts = append(parts, entry.Name+": "+summary(entry))
	}
	count := strconv.Itoa(len(m.Projects)) + " projects"
	if len(m.Projects) == 1 {
		count = "1 project"
	}
	reply := o.reply("You have "+count+". "+strings.Join(parts, ". ")+".", "point", KindStatus)
	for _, agent := range o.working[:min(6, len(o.working))] {
		reply.Lines = append(reply.Lines, o.line(agent))
	}
	return reply
}

func (o view) projectFromMap(entry projectmap.Project, in Office) Reply {
	text := entry.Name + ": " + summary(entry) + "."
	if len(entry.Waiting) > 0 {
		text += " Waiting to be delivered: " + strings.Join(entry.Waiting[:min(3, len(entry.Waiting))], "; ") + "."
	}
	if len(entry.Finished) > 0 {
		text += " Finished lately: " + strings.Join(entry.Finished[:min(3, len(entry.Finished))], "; ") + "."
	}
	if entry.Folder == "" {
		text += " It has no folder yet."
	}
	reply := o.reply(text, "point", KindStatus)
	for _, agent := range in.Agents {
		if agent.Project != nil && *agent.Project == entry.ID && !agent.Leaving && agent.State.Active() {
			reply.Lines = append(reply.Lines, o.line(agent))
		}
	}
	reply.Lines = reply.Lines[:min(6, len(reply.Lines))]
	reply.Project = &ProjectChoice{ID: entry.ID, Name: entry.Name}
	return reply
}

// summary is a project in a few words: who works there, how far along it is and how long is left.
func summary(entry projectmap.Project) string {
	working := 0
	for _, agent := range entry.Agents {
		if agent.Working {
			working++
		}
	}
	parts := []string{strconv.Itoa(working) + " working"}
	if entry.Status != string(models.ProjectNew) || entry.Progress > 0 {
		parts = append(parts, strconv.Itoa(int(entry.Progress*100+0.5))+"% done")
	}
	if entry.Estimate != nil {
		parts = append(parts, "about "+minutesLeft(entry.Estimate.SecondsLeft)+" left")
	}
	return strings.Join(parts, ", ")
}

func minutesLeft(seconds int64) string {
	m := max(1, (seconds+30)/60)
	if m < 60 {
		return strconv.FormatInt(m, 10) + " min"
	}
	return strconv.FormatInt(m/60, 10) + " h " + strconv.FormatInt(m%60, 10) + " min"
}

// mentioned is the project a question names by its whole name anywhere in it, the longest name
// first, or nil.
func mentioned(text string, projects []*models.Project) *models.Project {
	var found *models.Project
	longest := 0
	for _, alias := range aliases(projects) {
		if !alias.full || len(alias.text) <= longest {
			continue
		}
		if regexp.MustCompile(`(?i)\b` + namePattern(alias.text)).MatchString(text) {
			found, longest = alias.project, len(alias.text)
		}
	}
	return found
}
