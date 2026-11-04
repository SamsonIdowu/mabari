// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/SamsonIdowu/mabari/internal/connectors/simulator"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/planner"
	"github.com/SamsonIdowu/mabari/internal/workspace"
)

// Limits on what the New project chat may send.
const (
	maxBriefMessages = 50
	maxBriefText     = 4000
	maxAttached      = 10
	maxAttachedText  = 20000
	// attachedForPlan is how much of each file the planner reads, as in the prototype.
	attachedForPlan  = 1500
	maxInstructions  = 8000
	metaRecentFolder = "recent_folders"
)

func (a *api) projectStartRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/planner", a.plan)
	mux.HandleFunc("POST /api/planner/estimate", a.estimatePlan)
	mux.HandleFunc("POST /api/projects/start", a.startProject)
	mux.HandleFunc("POST /api/folders/check", a.checkFolder)
	mux.HandleFunc("POST /api/folders/pick", a.pickFolder)
	mux.HandleFunc("GET /api/folders/recent", a.recentFolders)
}

type attached struct {
	Name string `json:"name"`
	Text string `json:"text"`
}

type repoBrief struct {
	Name  string `json:"name"`
	Lang  string `json:"lang"`
	Files int    `json:"files"`
}

type planBody struct {
	// Said is everything the person has written, oldest first, the latest last.
	Said         []string      `json:"said"`
	Previous     *planner.Plan `json:"previous"`
	Instructions string        `json:"instructions"`
	Files        []attached    `json:"files"`
	Repo         *repoBrief    `json:"repo"`
}

func (b planBody) check() string {
	switch {
	case len(b.Said) == 0 || len(b.Said) > maxBriefMessages:
		return "say what the project is about"
	case len(b.Files) > maxAttached:
		return "attach at most " + strconv.Itoa(maxAttached) + " files"
	case utf8.RuneCountInString(b.Instructions) > maxInstructions:
		return "the instructions are too long"
	}
	for _, said := range b.Said {
		if utf8.RuneCountInString(said) > maxBriefText {
			return "a message is too long"
		}
	}
	for _, file := range b.Files {
		if utf8.RuneCountInString(file.Text) > maxAttachedText || utf8.RuneCountInString(file.Name) > 200 {
			return "an attached file is too large"
		}
	}
	return ""
}

func clipRunes(text string, limit int) string {
	if runes := []rune(text); len(runes) > limit {
		return string(runes[:limit])
	}
	return text
}

// officeForPlanner is what the planner needs from the office. Call inside Do.
func (a *api) officeForPlanner() planner.Office {
	connected := map[models.AccountKind]bool{}
	for _, account := range a.engine.Accounts() {
		connected[account.Kind] = account.Status == models.AccountConnected
	}
	return planner.Office{
		Connected:  connected,
		Taken:      func(name string) bool { return a.engine.AgentByName(name) != nil },
		AgentCount: len(a.engine.Agents()), ProjectCount: len(a.engine.Projects()),
		Defaults: a.engine.Settings().Defaults,
	}
}

// plan answers one message in the New project chat with a plan and the planner's reply.
func (a *api) plan(w http.ResponseWriter, r *http.Request) {
	var body planBody
	if !readJSON(w, r, &body) {
		return
	}
	if problem := body.check(); problem != "" {
		writeError(w, http.StatusBadRequest, problem)
		return
	}
	latest := body.Said[len(body.Said)-1]
	context := ""
	if body.Instructions != "" {
		context += " " + body.Instructions
	}
	for _, file := range body.Files {
		context += " " + file.Name + " " + clipRunes(file.Text, attachedForPlan)
	}
	if body.Repo != nil {
		context += " repository code build tests " + body.Repo.Lang
	}
	all := strings.Join(body.Said, ". ") + context
	var plan planner.Plan
	if err := a.engine.Do(func() {
		plan = planner.Make(all, latest, body.Previous, a.officeForPlanner())
	}); err != nil {
		internalError(w, err)
		return
	}
	first := body.Previous == nil
	if first && body.Repo != nil && !strings.Contains(strings.ToLower(latest), "call it") {
		plan.Name = planner.TitleCase(body.Repo.Name)
	}
	var read []string
	if n := len(body.Files); n > 0 {
		read = append(read, strconv.Itoa(n)+" file"+plural(n))
	}
	if body.Repo != nil {
		read = append(read, "the "+body.Repo.Name+" repository ("+body.Repo.Lang+", "+strconv.Itoa(body.Repo.Files)+" files)")
	}
	if strings.TrimSpace(body.Instructions) != "" {
		read = append(read, "your instructions")
	}
	writeJSON(w, http.StatusOK, map[string]any{"plan": plan, "reply": planner.Reply(plan, first, read)})
}

// estimatePlan recomputes a plan's time to completion when people are ticked or unticked, so the
// estimate always comes from the server.
func (a *api) estimatePlan(w http.ResponseWriter, r *http.Request) {
	var plan planner.Plan
	if !readJSON(w, r, &plan) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"minutes": planner.Minutes(plan)})
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

type folderBody struct {
	Path     string `json:"path"`
	AllowURL bool   `json:"allowUrl"`
}

type folderCheck struct {
	Path  string          `json:"path"`
	URL   bool            `json:"url"`
	Name  string          `json:"name"`
	Hint  string          `json:"hint"`
	Scan  *workspace.Scan `json:"scan"`
	Error string          `json:"error"`
}

// checkFolder looks at a typed, pasted or picked folder, or checks a Git URL, without cloning.
func (a *api) checkFolder(w http.ResponseWriter, r *http.Request) {
	var body folderBody
	if !readJSON(w, r, &body) {
		return
	}
	value := workspace.Clean(body.Path)
	result := folderCheck{Path: value}
	switch {
	case value == "":
		result.Error = "Choose a folder on this computer, or type or paste its path."
	case !workspace.Valid(value, body.AllowURL):
		result.Error = "Use a full path such as ~/code/shop, /Users/you/code/shop or C:\\code\\shop."
	case workspace.IsURL(value):
		if err := workspace.CheckGitURL(value); err != nil {
			result.Error = "Use an https or ssh Git URL, such as https://github.com/you/shop."
			break
		}
		result.URL, result.Name, result.Hint = true, workspace.RepoName(value), "Will be cloned when the project starts."
	default:
		path, err := workspace.Expand(value)
		if err != nil {
			result.Error = err.Error()
			break
		}
		scan, err := workspace.Look(path)
		if err != nil {
			result.Error = err.Error()
			break
		}
		result.Scan, result.Name = &scan, scan.Root
		result.Hint = "Agents will work inside " + value + "."
	}
	writeJSON(w, http.StatusOK, result)
}

// pickFolder opens the system's folder picker on this computer.
func (a *api) pickFolder(w http.ResponseWriter, r *http.Request) {
	path, err := workspace.Pick(r.Context())
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": path})
}

func (a *api) recent() []string {
	raw, err := a.engine.Store().Meta(context.Background(), metaRecentFolder)
	var folders []string
	if err != nil || json.Unmarshal([]byte(raw), &folders) != nil {
		return []string{}
	}
	return folders
}

func (a *api) recentFolders(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, a.recent())
}

type startBody struct {
	Plan         planner.Plan `json:"plan"`
	Name         string       `json:"name"`
	Instructions string       `json:"instructions"`
	Files        []string     `json:"files"`
	// Folder is a working folder or a Git URL, with Branch for a URL.
	Folder string `json:"folder"`
	Branch string `json:"branch"`
	// Mode is "plan" for Plan first or "go" for Start right away.
	Mode  string `json:"mode"`
	Brief string `json:"brief"`
}

func (b startBody) check() string {
	name := strings.TrimSpace(b.Name)
	switch {
	case name == "":
		return "Give the project a name."
	case utf8.RuneCountInString(name) > maxProjectName:
		return "Keep the project name to " + strconv.Itoa(maxProjectName) + " characters."
	case b.Mode != "plan" && b.Mode != "go":
		return `mode must be "plan" or "go"`
	case len(b.Plan.Members) > models.MaxSubagents:
		return "A team has three subagents at most."
	case len(b.Files) > maxAttached:
		return "attach at most " + strconv.Itoa(maxAttached) + " files"
	case utf8.RuneCountInString(b.Instructions) > maxInstructions:
		return "the instructions are too long"
	case strings.TrimSpace(b.Plan.LeadName) == "":
		return "the plan has no lead"
	}
	return ""
}

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

// startProject creates the project and seats its team, as the prototype's briefStart does.
func (a *api) startProject(w http.ResponseWriter, r *http.Request) {
	var body startBody
	if !readJSON(w, r, &body) {
		return
	}
	if problem := body.check(); problem != "" {
		writeError(w, http.StatusBadRequest, problem)
		return
	}
	name := strings.TrimSpace(body.Name)
	folder, url := "", ""
	if source := workspace.Clean(body.Folder); source != "" {
		if workspace.IsURL(source) {
			if err := workspace.CheckGitURL(source); err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			if err := workspace.CheckBranch(body.Branch); err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			url = source
			folder = "~/code/" + workspace.RepoName(source)
		} else if workspace.Valid(source, false) {
			folder = source
		} else {
			writeError(w, http.StatusBadRequest, "Use a full path such as ~/code/shop.")
			return
		}
	} else {
		folder = "~/code/" + strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(name), "-"), "-")
	}
	var (
		project models.Project
		lead    *models.LiveAgent
		problem string
		notice  string
	)
	err := a.engine.Do(func() {
		problem, notice = a.seatProject(body, name, folder, url, &project, &lead)
	})
	switch {
	case err != nil:
		internalError(w, err)
		return
	case problem != "":
		writeError(w, http.StatusConflict, problem)
		return
	}
	if url != "" {
		go a.cloneFor(project, lead, url, body.Branch, folder)
	}
	leadID := ""
	if lead != nil {
		leadID = lead.ID
	}
	writeJSON(w, http.StatusCreated, map[string]any{"project": project, "leadId": leadID, "notice": notice})
}

// seatProject saves the project and seats the lead, then brings in the team. Call inside Do.
func (a *api) seatProject(body startBody, name, folder, url string, project *models.Project, lead **models.LiveAgent) (string, string) {
	plan := body.Plan
	if !a.connected(plan.Account) && !a.simulator.DemoActive() {
		return "Connect " + accountLabel[plan.Account] + " first.", ""
	}
	if a.engine.AgentByName(plan.LeadName) != nil {
		return "There is already an agent called " + plan.LeadName + ". Ask the planner again.", ""
	}
	var team []planner.Member
	for _, member := range plan.Members {
		if member.On {
			team = append(team, member)
		}
	}
	notice := ""
	realCodex := plan.Account == models.AccountCodex && a.codex != nil && !a.simulator.DemoActive()
	// Codex threads start working as soon as they exist, so nothing could wait for the plan.
	if realCodex && body.Mode == "plan" && len(team) > 0 {
		return "Plan first isn't ready for Codex yet. Choose Start right away.", ""
	}
	// Claude Code sessions run in the person's own terminal. Outside the demo, Mabari makes the
	// project and says how to start; the session joins it by its folder.
	realClaude := plan.Account == models.AccountClaudeCode && !a.simulator.DemoActive()
	// Outside the demo, an API key account has nothing real to run the team on yet.
	if !a.simulator.DemoActive() && (plan.Account == models.AccountAnthropicKey || plan.Account == models.AccountOpenAIKey) {
		return a.realRunner(plan.Account), ""
	}
	if !realClaude {
		free := models.DeskCount - len(a.engine.Agents())
		if free < 1 {
			return "Every desk is taken. Stop an agent to make room.", ""
		}
		if free < len(team)+1 {
			team = team[:free-1]
			notice = "Only room for " + strconv.Itoa(free) + " agents, so starting the first " + strconv.Itoa(free) + "."
		}
	}
	repo := &models.Repository{Path: folder}
	if url != "" {
		repo.URL = &url
		if body.Branch != "" {
			branch := body.Branch
			repo.Branch = &branch
		}
	}
	files := body.Files
	if files == nil {
		files = []string{}
	}
	*project = a.engine.SaveProject(models.Project{
		Name: name, Color: plan.Color, Instructions: strings.TrimSpace(body.Instructions),
		Files: files, Repository: repo,
	})
	a.engine.SetFirstRun(false)
	a.engine.SetMeta(metaRecentFolder, mustJSON(rememberFolder(a.recent(), body.Folder)))
	if realClaude {
		a.engine.Log(name, models.LogSession, "cd "+folder+" && claude", "Waiting for a session", "")
		return "", "Run claude in " + folder + ". The session joins " + name + " when it starts."
	}
	created, failure := a.simulator.CreateAgent(simulator.NewAgent{
		Name: plan.LeadName, Account: plan.Account, Model: plan.LeadModel, Task: plan.LeadTask,
		Project: project.ID, Folder: folder,
	})
	if failure != nil || created == nil {
		return "Every desk is taken. Stop an agent to make room.", ""
	}
	*lead = created
	created.SubModel = plan.SubModel
	if body.Brief != "" {
		a.engine.AddEvent(created, "instruction", "Project brief: "+clipRunes(body.Brief, 300), nil)
		a.engine.Log(created.Name, models.LogInstruction, "Project brief: "+clipRunes(body.Brief, 300), "Started for "+name, "ok")
	}
	if url != "" {
		a.engine.AddEvent(created, "run_shell", "git clone "+url+" "+folder, nil)
	}
	if body.Instructions != "" {
		a.engine.AddEvent(created, "read_file", "Project instructions", nil)
	}
	for _, file := range body.Files {
		a.engine.AddEvent(created, "read_file", clipRunes(file, 120), nil)
	}
	members := make([]simulator.PlannedMember, 0, len(team))
	steps := []string{"Read the " + readWhat(url, folder, body.Instructions)}
	for _, member := range team {
		members = append(members, simulator.PlannedMember{Name: member.Name, Task: member.Task, Model: plan.SubModel})
		steps = append(steps, member.Name+" ("+strings.ToLower(member.Label)+"): "+member.Task)
	}
	steps = append(steps, "Review everything together before calling it done")
	if realCodex {
		// Each member is its own Codex thread, seated in the lead's office.
		a.codex.StartAgent(created)
		for _, member := range members {
			if helper := a.simulator.AddSubagent(created, member.Name, member.Task, member.Model); helper != nil {
				a.codex.StartAgent(helper)
			}
		}
	} else {
		a.simulator.StartTeam(created, members, body.Mode == "plan", name, steps)
	}
	a.engine.Toast(name + " created. " + created.Name + " is walking in" + bringing(len(members)) + ".")
	return "", notice
}

func bringing(n int) string {
	if n == 0 {
		return ""
	}
	return " and will bring in " + strconv.Itoa(n) + " subagent" + plural(n)
}

func readWhat(url, folder, instructions string) string {
	what := "project files"
	if url != "" || folder != "" {
		what = filepath.Base(folder) + " repository"
	}
	if instructions != "" {
		what += " and the instructions"
	}
	return what
}

var accountLabel = map[models.AccountKind]string{
	models.AccountClaudeCode: "Claude Code on this computer", models.AccountCodex: "ChatGPT (Codex)",
	models.AccountAnthropicKey: "your Anthropic API key", models.AccountOpenAIKey: "your OpenAI API key",
}

func rememberFolder(recent []string, folder string) []string {
	return workspace.Remember(recent, workspace.Clean(folder))
}

func mustJSON(value any) string {
	data, _ := json.Marshal(value)
	return string(data)
}

// cloneFor clones the project's repository in the background, and shows a failure on the lead.
func (a *api) cloneFor(project models.Project, lead *models.LiveAgent, url, branch, folder string) {
	dest, err := workspace.Expand(folder)
	if err == nil {
		err = workspace.Clone(context.Background(), url, branch, dest)
	}
	_ = a.engine.Do(func() {
		if err != nil {
			a.engine.Log(project.Name, models.LogSession, "git clone "+url, clipRunes(err.Error(), 120), "red")
			if lead != nil && a.engine.Agent(lead.ID) == lead {
				lead.State, lead.Error = models.StateError, clipRunes(err.Error(), 160)
				a.engine.Touch(lead)
			}
			return
		}
		a.engine.Log(project.Name, models.LogSession, "git clone "+url, "Cloned into "+folder, "ok")
	})
}
