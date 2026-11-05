// SPDX-License-Identifier: Apache-2.0

package vee

// Messages for a project. The person can name the project ("send /ux-audit … to Experience and
// Quality", "in Shop: fix the login", "tell Shop to …"), pick it next to the chat box, or leave it
// to Mabari, which reads its map of the projects (names, folders, instructions and what their
// agents are doing) for the one the message fits. When no project clearly fits, Mabari asks.

import (
	"cmp"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/SamsonIdowu/mabari/internal/dispatch"
	"github.com/SamsonIdowu/mabari/internal/models"
)

// KindPickProject asks which project a message is for. Projects lists the choices and Target
// holds the message, so the page can send it again with the one picked.
const KindPickProject Kind = "pickProject"

// AnyProject is the choice that leaves the message to the dispatcher, across the whole office.
const AnyProject = "any"

// ProjectChoice is a project as a reply shows it.
type ProjectChoice struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Color  string `json:"color"`
	Folder string `json:"folder"`
}

// Route asks the server to send a message to a project: to the agent there best placed to take
// it, or to a Claude Code session opened in the project's folder.
type Route struct {
	ProjectID string
	Text      string
	// Why says why Mabari chose the project, when the person didn't name it.
	Why string
}

// Office is what Mabari can see: the agents, the projects, and the project picked next to the
// chat box, if any.
type Office struct {
	Agents   []*models.LiveAgent
	Projects []*models.Project
	// InView is the project picked for the message, AnyProject, or empty to let Mabari choose.
	InView string
	// Router is the dispatcher, asked which agent a message best fits when no project's name or
	// folder settles it. Nil leaves it out.
	Router dispatch.Router
}

// stopWords never identify a project on their own.
var stopWords = map[string]bool{
	"the": true, "and": true, "for": true, "with": true, "this": true, "that": true, "from": true,
	"into": true, "please": true, "send": true, "run": true, "tell": true, "ask": true, "project": true,
	"all": true, "our": true, "you": true, "can": true, "make": true, "add": true, "fix": true,
	"code": true, "app": true, "new": true, "use": true, "have": true, "get": true, "them": true,
	"its": true, "what": true, "about": true, "some": true, "there": true, "then": true,
}

var wordPattern = regexp.MustCompile(`[a-z0-9]+`)

// words are the meaningful words in text: three letters or more, and not stop words.
func words(text string) []string {
	var out []string
	for _, word := range wordPattern.FindAllString(strings.ToLower(text), -1) {
		if len(word) >= 3 && !stopWords[word] {
			out = append(out, word)
		}
	}
	return out
}

func choiceOf(project *models.Project) ProjectChoice {
	choice := ProjectChoice{ID: project.ID, Name: project.Name, Color: project.Color}
	if project.Repository != nil {
		choice.Folder = project.Repository.Path
	}
	return choice
}

func open(projects []*models.Project) []*models.Project {
	var out []*models.Project
	for _, project := range projects {
		if project.Done == nil {
			out = append(out, project)
		}
	}
	return out
}

// aliases are the ways a message can name a project: its whole name, and the start of its name
// when no other project starts the same way ("Lad" for "Lad Project All"). Longest first.
func aliases(projects []*models.Project) []struct {
	text    string
	project *models.Project
} {
	type alias = struct {
		text    string
		project *models.Project
	}
	owners := map[string][]*models.Project{}
	for _, project := range projects {
		name := strings.Fields(strings.ToLower(project.Name))
		seen := map[string]bool{}
		for size := len(name); size >= 1; size-- {
			text := strings.Join(name[:size], " ")
			last := name[size-1]
			if size < len(name) && (len(text) < 3 || stopWords[last]) {
				continue
			}
			if !seen[text] {
				seen[text] = true
				owners[text] = append(owners[text], project)
			}
		}
	}
	var out []alias
	for text, projects := range owners {
		// A start of a name that two projects share names neither.
		if len(projects) == 1 || strings.EqualFold(projects[0].Name, text) {
			out = append(out, alias{text, projects[0]})
		}
	}
	slices.SortFunc(out, func(a, b alias) int {
		return cmp.Or(cmp.Compare(len(b.text), len(a.text)), cmp.Compare(a.text, b.text))
	})
	return out
}

// The ways a message names its project. %s is the name, already quoted for the pattern.
const (
	// "in Shop: fix the login", "for the Shop project - fix it", "@Shop fix it", "Shop: fix it".
	leadingName = `(?is)^(?:please\s+)?(?:(?:in|for|to|on)\s+(?:the\s+)?(?:project\s+)?|@)?%s(?:\s+project)?\s*(?:[:,–-]\s*|\s+(?:please\s+)?(?:can you\s+)?)(.+)$`
	// "send /ux-audit https://… to Shop", "run the tests in the Shop project", "/deploy for Shop".
	trailingName = `(?is)^(?:please\s+)?(?:(?:send|run|pass|give|post)\s+(?:this\s+)?)?(.+?)\s+(?:to|in|for|on|into)\s+(?:the\s+)?(?:project\s+)?%s(?:\s+project)?\s*[.!]?$`
	// "tell Shop to fix it", "ask the Shop project what's left".
	tellName = `(?is)^(?:please\s+)?(?:tell|ask|have|get)\s+(?:the\s+)?(?:project\s+)?%s(?:\s+project)?\s+(?:to\s+)?(.+)$`
)

// namedStart is how a message that names its project first begins. A bare "Shop fix it" is too
// easy to read by mistake, so without a colon or a dash after the name, the leading form only
// counts when the message starts with "in", "for", "to", "on" or "@".
var namedStart = regexp.MustCompile(`(?i)^(?:please\s+)?(?:in|for|to|on|@)`)

// instruction is how a task starts. "fix the bug in Shop" is a task for Shop, while "a bug in Shop"
// is a description, so the form that names the project last counts only for commands and for
// messages that start with a verb.
var instruction = regexp.MustCompile(`(?i)^(?:please\s+)?(?:/|send|run|pass|give|post|fix|add|build|make|write|update|check|review|test|deploy|create|remove|delete|refactor|implement|investigate|look|start|open|do|audit)\b`)

// namedProject finds a project the message names and what to send it. Names are matched longest
// first, case-insensitively, in the original text, so a URL or a command keeps its case.
func namedProject(text string, projects []*models.Project) (*models.Project, string) {
	text = strings.TrimSpace(text)
	for _, alias := range aliases(projects) {
		name := regexp.QuoteMeta(alias.text)
		name = strings.ReplaceAll(name, " ", `\s+`)
		if match := regexp.MustCompile(strings.Replace(tellName, "%s", name, 1)).FindStringSubmatch(text); match != nil {
			return alias.project, strings.TrimSpace(match[1])
		}
		if match := regexp.MustCompile(strings.Replace(leadingName, "%s", name, 1)).FindStringSubmatch(text); match != nil {
			separated := strings.ContainsAny(text[:len(text)-len(match[1])], ":,–-")
			if separated || namedStart.MatchString(text) {
				return alias.project, strings.TrimSpace(match[1])
			}
		}
		if match := regexp.MustCompile(strings.Replace(trailingName, "%s", name, 1)).FindStringSubmatch(text); match != nil &&
			instruction.MatchString(text) {
			return alias.project, strings.TrimSpace(match[1])
		}
	}
	return nil, ""
}

// fit is how well a message fits a project, from Mabari's map of it.
type fit struct {
	project *models.Project
	score   int
	why     string
}

// fits scores every open project for a message: its name counts most, then its folder, the names
// of its agents, and the words in its instructions and in what its agents are doing.
func fits(text string, projects []*models.Project, agents []*models.LiveAgent) []fit {
	said := map[string]bool{}
	for _, word := range words(text) {
		said[word] = true
	}
	var out []fit
	for _, project := range projects {
		score, why := 0, ""
		for _, word := range words(project.Name) {
			if said[word] {
				score += 10
				why = "it mentions " + project.Name
			}
		}
		if project.Repository != nil && project.Repository.Path != "" {
			for _, word := range words(filepath.Base(project.Repository.Path)) {
				if said[word] {
					score += 6
					if why == "" {
						why = "it mentions the " + filepath.Base(project.Repository.Path) + " folder"
					}
				}
			}
		}
		context := map[string]bool{}
		for _, word := range words(project.Instructions) {
			context[word] = true
		}
		for _, agent := range agents {
			if agent.Project == nil || *agent.Project != project.ID {
				continue
			}
			for _, word := range words(agent.Name) {
				if said[word] {
					score += 20
					why = agent.Name + " works on " + project.Name
				}
			}
			for _, word := range words(agent.Task + " " + strings.Join(agent.Files, " ")) {
				context[word] = true
			}
		}
		matched := 0
		for word := range context {
			if said[word] {
				matched++
			}
		}
		score += min(matched, 3) * 4
		if why == "" && matched > 0 {
			why = "it matches what " + project.Name + " is about"
		}
		out = append(out, fit{project, score, why})
	}
	slices.SortStableFunc(out, func(a, b fit) int { return cmp.Compare(b.score, a.score) })
	return out
}

// clearFit is the lowest score that picks a project, and how far ahead of the next it must be.
const (
	clearFit  = 4
	clearLead = 4
)

// forProject decides which project an unaddressed message is for. It returns a route, a question
// when no project clearly fits, or neither when the message should go to the dispatcher as before:
// when there are no projects, or the person chose "any project".
func (o view) forProject(text string, in Office) (*Route, *Reply) {
	if in.InView == AnyProject {
		return nil, nil
	}
	projects := open(in.Projects)
	if in.InView != "" {
		for _, project := range projects {
			if project.ID == in.InView {
				return &Route{ProjectID: project.ID, Text: text}, nil
			}
		}
	}
	if len(projects) == 0 {
		return nil, nil
	}
	// A message that names an agent goes to that agent, as it always has.
	if o.named(strings.ToLower(text)) != nil {
		return nil, nil
	}
	ranked := fits(text, projects, o.agents)
	best := ranked[0]
	runnerUp := 0
	if len(ranked) > 1 {
		runnerUp = ranked[1].score
	}
	if best.score >= clearFit && best.score-runnerUp >= clearLead {
		return &Route{ProjectID: best.project.ID, Text: text, Why: best.why}, nil
	}
	// The dispatcher knows what each agent is working on. When an agent in a project clearly fits
	// the message, its project does.
	if route := o.byAgent(text, projects, in.Router); route != nil {
		return route, nil
	}
	if len(projects) == 1 && !o.outsideProjects() {
		return &Route{ProjectID: projects[0].ID, Text: text, Why: "it's your only project"}, nil
	}
	reply := o.reply("Which project is this for?", "shrug", KindPickProject)
	reply.Target = text
	for _, project := range projects {
		reply.Projects = append(reply.Projects, choiceOf(project))
	}
	return nil, &reply
}

// agentFit is the lowest dispatcher fit that picks an agent's project: a matching topic, or two
// words of its work.
const agentFit = 6

func (o view) byAgent(text string, projects []*models.Project, router dispatch.Router) *Route {
	if router == nil {
		return nil
	}
	ids := map[string]*models.Project{}
	for _, project := range projects {
		ids[project.ID] = project
	}
	var inProjects []*models.LiveAgent
	for _, agent := range o.agents {
		if agent.Project != nil && ids[*agent.Project] != nil {
			inProjects = append(inProjects, agent)
		}
	}
	decision := router.Route(text, inProjects)
	if decision == nil || decision.Fit < agentFit {
		return nil
	}
	for _, agent := range inProjects {
		if agent.ID == decision.AgentID {
			project := ids[*agent.Project]
			return &Route{ProjectID: project.ID, Text: text, Why: agent.Name + " is on related work there"}
		}
	}
	return nil
}

// outsideProjects reports whether any agent works outside every project.
func (o view) outsideProjects() bool {
	for _, agent := range o.agents {
		if agent.Project == nil {
			return true
		}
	}
	return false
}

// ProjectSent is what became of a message for a project.
type ProjectSent struct {
	Project *models.Project
	// Agent took it, and Where is where its instruction waits, when an agent in the project could.
	Agent *models.LiveAgent
	Where Where
	// Why is why Mabari chose the project, when the person didn't name it.
	Why string
	// Opening is the prompt Claude Code is opening with in the project's folder.
	Opening *models.Instruction
	// Opened is false when this computer can't open a terminal, so the person has to.
	Opened bool
	// Problem says why nothing could take it.
	Problem string
}

// SentToProject is what Mabari says once a message for a project has gone somewhere.
func SentToProject(sent ProjectSent, agents []*models.LiveAgent, now time.Time) Reply {
	office := look(agents, now)
	project := sent.Project
	why := ""
	if sent.Why != "" {
		why = " I picked " + project.Name + " because " + sent.Why + "."
	}
	var reply Reply
	switch {
	case sent.Problem != "":
		reply = office.reply(sent.Problem, "shrug", KindPlain)
	case sent.Opening != nil && !sent.Opened:
		reply = office.reply("Nobody in "+project.Name+" can take it, and Claude Code can't open a window from here. "+
			"Run claude in "+folderOf(project)+" and send it there.", "shrug", KindPlain)
	case sent.Opening != nil:
		reply = office.reply("Opening Claude Code in "+folderOf(project)+" with it."+why+
			" It joins "+project.Name+" as soon as it starts, and I'll read you its reply.", "nod", KindPlain)
		reply.Relay = &Relay{InstructionID: sent.Opening.ID, Agent: "Claude Code in " + project.Name, AI: "Claude"}
	case sent.Agent == nil || sent.Where.InstructionID == "":
		reply = office.reply("Nobody in "+project.Name+" could take that just now. Try again in a moment.", "shrug", KindPlain)
	default:
		text := "On it, sent to " + sent.Agent.Name + " (" + models.AIName(sent.Agent) + ") in " + project.Name + "." + why
		if sent.Where.Queued {
			text += " It's mid step, so it gets it at its next checkpoint."
		}
		reply = office.reply(text+" I'll read you the reply the moment it lands.", "nod", KindPlain)
		reply.Relay = relayFor(sent.Agent, sent.Where)
	}
	choice := choiceOf(project)
	reply.Project = &choice
	return reply
}

// Say is a plain reply.
func Say(text string, agents []*models.LiveAgent, now time.Time) Reply {
	return look(agents, now).reply(text, "shrug", KindPlain)
}

func folderOf(project *models.Project) string {
	if project.Repository == nil {
		return ""
	}
	return project.Repository.Path
}
