// SPDX-License-Identifier: Apache-2.0

// Package simulator reproduces the prototype's demo office as a connector. The UI is built against
// it until Stage 7. Random numbers are drawn in the prototype's exact order, which the golden test
// checks, so reorder them only together with the prototype.
package simulator

import (
	"errors"
	"log/slog"
	"math"
	"math/rand/v2"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

// Source is the value of Agent.Source for simulated agents.
const Source = "sim"

// DemoLength is how long the demo office runs before it turns itself off, so simulated agents
// never keep running in the background.
const DemoLength = 10 * time.Minute

// SetDemoLength changes how long the demo runs, for tests.
func (s *Simulator) SetDemoLength(length time.Duration) { s.demoLength = length }

// SetDemoQuestion changes how long into the demo its agent asks a question, for tests. Zero or
// less means it never asks.
func (s *Simulator) SetDemoQuestion(after time.Duration) { s.questionAfter = after }

const (
	officeSecondsPerTick = 6
	// checkpointSoon is how many office seconds a step has left once an instruction waits for it,
	// as in the prototype: two ticks, so about two seconds.
	checkpointSoon     = 9
	approvalEveryTicks = 45
	conversationEvery  = 5
	waitForever        = 999
)

// Mulberry32 is a small seeded generator, matching the one the golden test installs in the
// prototype.
func Mulberry32(seed uint32) func() float64 {
	state := seed
	return func() float64 {
		state += 0x6D2B79F5
		t := (state ^ state>>15) * (1 | state)
		t = (t + (t^t>>7)*(61|t)) ^ t
		return float64(t^t>>14) / 4294967296
	}
}

type runtime struct {
	stateLeft float64
	// pausedLeft is how much of its step an interrupted agent had left.
	pausedLeft float64
	spawned    bool
	doneUntil  int64
	// nextTask is when an idle demo agent picks up new work, or zero.
	nextTask int64
}

type timer struct {
	at   int64
	work func()
}

// Simulator is the demo office.
type Simulator struct {
	engine        *events.Engine
	random        func() float64
	runtimes      map[string]*runtime
	timers        []timer
	approvalTimer int
	convTimer     int
	hueIndex      int
	// planned are teams waiting for their lead's plan to be approved, by lead id.
	planned  map[string][]PlannedMember
	demoMode bool
	// demoEnds is when the demo turns itself off, in milliseconds, and demoLength how long it runs.
	demoEnds   int64
	demoLength time.Duration
	// questionAfter is how long into the demo a demo agent asks its question.
	questionAfter time.Duration

	tickEvery time.Duration
	mu        sync.Mutex
	quit      chan struct{}
}

// New builds a simulator. Pass nil for random to use a fresh source, and a zero tickEvery to drive
// it by calling Tick, as tests do.
func New(engine *events.Engine, random func() float64, tickEvery time.Duration) *Simulator {
	if random == nil {
		random = rand.Float64
	}
	s := &Simulator{
		engine:     engine,
		random:     random,
		runtimes:   map[string]*runtime{},
		tickEvery:  tickEvery,
		demoLength: DemoLength, questionAfter: DemoQuestionAfter,
	}
	engine.AddConnector(Source, s)
	return s
}

// between draws a number the way the prototype's rnd does. The float64 conversion stops the
// compiler fusing the multiply and add, which rounds differently from JavaScript on arm64.
func (s *Simulator) between(low, high float64) float64 {
	return low + float64(s.random()*(high-low))
}

func pick[T any](s *Simulator, items []T) T {
	return items[int(math.Floor(s.random()*float64(len(items))))]
}

func (s *Simulator) rounded(low, high float64) int64 {
	return int64(math.Round(s.between(low, high)))
}

func (s *Simulator) now() int64 { return s.engine.Now().UnixMilli() }

func (s *Simulator) after(milliseconds int64, work func()) {
	s.timers = append(s.timers, timer{at: s.now() + milliseconds, work: work})
}

func (s *Simulator) runtimeOf(agent *models.LiveAgent) *runtime {
	state, ok := s.runtimes[agent.ID]
	if !ok {
		state = &runtime{stateLeft: s.between(60, 220), doneUntil: s.now() + 9000}
		s.runtimes[agent.ID] = state
	}
	return state
}

// Start ticks in the background until Stop.
func (s *Simulator) Start() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.quit != nil || s.tickEvery <= 0 {
		return
	}
	quit := make(chan struct{})
	s.quit = quit
	go func() {
		ticker := time.NewTicker(s.tickEvery)
		defer ticker.Stop()
		for {
			select {
			case <-quit:
				return
			case <-ticker.C:
				if err := s.Tick(); err != nil {
					slog.Error("simulator could not save", "error", err)
				}
			}
		}
	}()
}

// Stop ends the ticking. Wipe calls it from inside Engine.Do, so it never waits on the Engine.
func (s *Simulator) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.quit != nil {
		close(s.quit)
		s.quit = nil
	}
}

// Resume runs once at start. The demo never outlives Mabari: one that was running before a
// restart is ended, and any simulated agent left behind is removed, so the office shows only real
// agents until someone loads the demo again.
func (s *Simulator) Resume(active bool) error {
	return s.engine.Do(func() {
		s.hueIndex = len(s.engine.Agents())
		leftover := slices.ContainsFunc(s.engine.Agents(), func(agent *models.LiveAgent) bool {
			return agent.Source == Source
		})
		if active || leftover {
			s.endDemo("The demo ended when Mabari restarted", "")
			return
		}
		// Earlier versions stored the demo's pretend sign ins and left them behind after the demo.
		// The demo only shows them now, so a stored one is turned off.
		for _, account := range s.engine.StoredAccounts() {
			if account.Kind == models.AccountCodex && account.Email != nil && *account.Email == models.DemoEmail {
				s.engine.SetAccount(models.Account{
					ID: string(account.Kind), Kind: account.Kind, Status: models.AccountOff,
					Models: models.Models[account.Kind],
				})
			}
		}
	})
}

// Models lists the models demo agents use.
func (s *Simulator) Models() []string { return models.Models[models.AccountClaudeCode] }

type agentSpec struct {
	name      string
	provider  models.Provider
	model     string
	account   models.AccountKind
	task      string
	state     models.AgentState
	desk      *int
	near      *int
	lead      *models.LiveAgent
	progress  float64
	elapsed   int64
	tokensIn  int64
	tokensOut int64
	errorText string
	project   string
	// unfiled keeps an agent with no project under none. Without it, an agent made with no project
	// joins the office's first, as in the prototype's own spawns.
	unfiled bool
	folder  string
	spawned bool
}

// NewAgent is what the Create a new agent dialog asks for.
type NewAgent struct {
	Name         string
	Account      models.AccountKind
	Model        string
	Task         string
	Project      string
	Folder       string
	DailyCostCap float64
	AllowedTools []string
	// Desk is the desk that was clicked, or nil for the next free one.
	Desk *int
	// Lead makes the new agent a subagent.
	Lead *models.LiveAgent
}

// ErrDeskTaken means someone took the desk while the dialog was open.
var ErrDeskTaken = errors.New("that desk has just been taken")

// CreateAgent walks a new agent into the office. It returns nil, after a toast, when no desk is
// free or a lead's office is full. Call inside engine.Do.
func (s *Simulator) CreateAgent(spec NewAgent) (*models.LiveAgent, error) {
	if spec.Desk != nil {
		for _, agent := range s.engine.Agents() {
			if agent.Desk == *spec.Desk {
				return nil, ErrDeskTaken
			}
		}
	}
	var agent *models.LiveAgent
	if spec.Lead != nil {
		agent = s.AddSubagent(spec.Lead, spec.Name, spec.Task, spec.Model)
	} else {
		provider := models.ProviderOpenAI
		if spec.Account == models.AccountClaudeCode {
			provider = models.ProviderClaude
		}
		agent = s.makeAgent(agentSpec{
			name: spec.Name, provider: provider, model: spec.Model, account: spec.Account,
			task: spec.Task, state: models.StateThinking, desk: spec.Desk, project: spec.Project,
			progress: 0.02, elapsed: 1, tokensIn: 200, tokensOut: 40, folder: spec.Folder,
			// The dialog's "No project" is a choice, whatever folder the agent works in (RT-2).
			unfiled: spec.Project == "",
		})
	}
	if agent == nil {
		return nil, nil
	}
	agent.DailyCostCap = &spec.DailyCostCap
	agent.AllowedTools = spec.AllowedTools
	s.engine.Log(agent.Name, models.LogSession, "Started on "+agent.Model, "Started", "ok")
	s.engine.Toast(agent.Name + " is walking in")
	return agent, nil
}

// freeDesk is the lowest free desk, or the free desk nearest near, as in the prototype.
func (s *Simulator) freeDesk(near *int) int {
	from := -1
	if near != nil {
		from = *near
	}
	return models.FreeDesk(s.engine.Agents(), from)
}

// orElse matches the prototype's `value||fallback()`: zero means unset, and the fallback only
// draws a random number when it is needed.
func orElse[T comparable](value T, fallback func() T) T {
	var zero T
	if value != zero {
		return value
	}
	return fallback()
}

func (s *Simulator) makeAgent(spec agentSpec) *models.LiveAgent {
	desk := 0
	if spec.desk != nil {
		desk = *spec.desk
	} else if desk = s.freeDesk(spec.near); desk < 0 {
		s.engine.Toast("The office is full. Stop an agent to free a desk.")
		return nil
	}
	task := spec.task
	if task == "" {
		task = "Waiting for work"
	}
	state := spec.state
	if state == "" {
		state = models.StateThinking
	}
	agent := &models.LiveAgent{}
	agent.Name, agent.Provider, agent.Model = spec.name, spec.provider, spec.model
	agent.Account, agent.Source = spec.account, Source
	agent.Task, agent.State, agent.Desk = task, state, desk
	agent.Progress = orElse(spec.progress, func() float64 { return s.between(0.1, 0.6) })
	agent.Rate = s.between(0.0009, 0.0018)
	agent.RateScale = demoPace
	agent.Elapsed = orElse(spec.elapsed, func() int64 { return s.rounded(120, 1800) })
	agent.TokensIn = orElse(spec.tokensIn, func() int64 { return s.rounded(8000, 90000) })
	agent.TokensOut = orElse(spec.tokensOut, func() int64 { return s.rounded(2000, 20000) })
	// Calm movement: a work state lasts minutes of office time, 25 to 50 real seconds.
	stateLeft := s.between(60, 220)
	agent.Folder = "~/code/shop"
	if spec.folder != "" {
		agent.Folder = spec.folder
	}
	agent.AllowedTools = []string{"read", "edit", "shell"}
	agent.Skin = pick(s, skins)
	agent.Hair = pick(s, hairs)
	agent.Error = spec.errorText
	agent.SubModel = "inherit"
	agent.Queued = []models.Instruction{}
	switch {
	case spec.project != "":
		project := spec.project
		agent.Project = &project
	case spec.lead != nil:
		agent.Project = spec.lead.Project
	case spec.unfiled:
		// Left under no project, as chosen.
	default:
		// Like the prototype, an agent with no project joins the first one.
		if projects := s.engine.Projects(); len(projects) > 0 {
			first := projects[0].ID
			agent.Project = &first
		}
	}
	if spec.lead != nil {
		lead := spec.lead.ID
		agent.Lead = &lead
	}
	agent.Hue = hues[s.hueIndex%len(hues)]
	s.hueIndex++
	files, ok := demoFiles[spec.name]
	if !ok {
		files = defaultFiles
	}
	agent.Files = files
	s.engine.AddAgent(agent)
	s.runtimes[agent.ID] = &runtime{stateLeft: stateLeft, spawned: spec.spawned}
	s.seedFeed(agent)
	return agent
}

func (s *Simulator) queriesFor(agent *models.LiveAgent) []string {
	if agent.Name == "Scout" {
		return scoutQueries
	}
	return defaultQueries
}

func (s *Simulator) seedFeed(agent *models.LiveAgent) {
	first := "package.json"
	if len(agent.Files) > 0 {
		first = agent.Files[0]
	}
	s.engine.AddEvent(agent, "read_file", first, nil)
	s.engine.AddEvent(agent, "think", "Planned the next three steps", nil)
	if len(agent.Files) > 1 {
		s.engine.AddEvent(agent, "read_file", agent.Files[1], nil)
	}
	if agent.State == models.StateBrowsing {
		s.engine.AddEvent(agent, "web_search", `"`+pick(s, s.queriesFor(agent))+`"`, nil)
	}
	if agent.State == models.StateEditing || agent.State == models.StateThinking {
		file := "src/app.ts"
		if len(agent.Files) > 0 {
			file = agent.Files[0]
		}
		s.engine.AddEvent(agent, "edit_file", file+"  +18 −6", nil)
	}
	if agent.State == models.StateRunning {
		s.engine.AddEvent(agent, "run_shell", "npm test  (running)", nil)
	}
}

func filesOr(agent *models.LiveAgent, fallback string) []string {
	if len(agent.Files) > 0 {
		return agent.Files
	}
	return []string{fallback}
}

// toolCall is the feed entry for entering a state, or empty if the state has none.
func (s *Simulator) toolCall(agent *models.LiveAgent, state models.AgentState) (tool, summary string) {
	switch state {
	case models.StateThinking:
		return "think", "Choosing the next step"
	case models.StateReading:
		return "read_file", pick(s, filesOr(agent, "src/index.ts"))
	case models.StateEditing:
		file := pick(s, filesOr(agent, "src/app.ts"))
		added := s.rounded(3, 40)
		removed := s.rounded(0, 12)
		return "edit_file", file + "  +" + strconv.FormatInt(added, 10) + " −" +
			strconv.FormatInt(removed, 10)
	case models.StateRunning:
		command := pick(s, []string{"npm test", "npm run lint", "pytest -q", "npm run build"})
		return "run_shell", command + "  → " + pick(s, []string{"all passed", "2 failed", "passed in 14s"})
	case models.StateBrowsing:
		return "web_search", `"` + pick(s, s.queriesFor(agent)) + `"`
	case models.StateSpawning:
		return "spawn_agent", "Started a helper for a side task"
	default:
		return "", ""
	}
}

func (s *Simulator) setState(agent *models.LiveAgent, state models.AgentState) {
	previous := agent.State
	agent.State = state
	s.runtimeOf(agent).stateLeft = s.between(150, 300)
	s.engine.Touch(agent)
	if previous != state {
		s.checkpoint(agent)
	}
	if tool, summary := s.toolCall(agent, state); tool != "" {
		s.engine.AddEvent(agent, tool, summary, nil)
	}
	if agent.Lead != nil && s.random() < 0.35 {
		if lead := s.engine.Agent(*agent.Lead); lead != nil {
			percent := int(math.Round(agent.Progress * 100))
			s.talk(agent, lead, "Now "+strings.ToLower(models.StateLabels[state])+". "+
				strconv.Itoa(percent)+"% through my task.", models.MessageReport)
		}
	}
	if state == models.StateSpawning && !s.runtimeOf(agent).spawned {
		s.after(5000, func() { s.spawnHelper(agent) })
	}
}

func (s *Simulator) reply(agent *models.LiveAgent, text string, milliseconds int64) {
	agent.Reply, agent.ReplyUntil = text, s.now()+milliseconds
	s.engine.Touch(agent)
}

func (s *Simulator) checkpoint(agent *models.LiveAgent) {
	instruction, ok := s.engine.NextQueued(agent)
	if !ok {
		return
	}
	s.engine.AddEvent(agent, "instruction", "Received: "+instruction.Text, nil)
	said := models.Ack(instruction.Text)
	s.reply(agent, said, 7000)
	s.engine.Answered(agent, said)
}

func (s *Simulator) stillHere(agent *models.LiveAgent) bool {
	return s.engine.Agent(agent.ID) == agent
}

func subModelFor(lead *models.LiveAgent) string {
	if lead.SubModel != "" && lead.SubModel != "inherit" {
		return lead.SubModel
	}
	return lead.Model
}

func (s *Simulator) spawnHelper(lead *models.LiveAgent) {
	state := s.runtimeOf(lead)
	if state.spawned || !s.stillHere(lead) {
		return
	}
	state.spawned = true
	helper := s.makeAgent(agentSpec{
		name:      lead.Name + " helper",
		provider:  lead.Provider,
		model:     subModelFor(lead),
		account:   lead.Account,
		task:      "Write test fixtures for " + strings.ToLower(lead.Task),
		state:     models.StateReading,
		near:      &lead.Desk,
		lead:      lead,
		progress:  0.05,
		elapsed:   5,
		tokensIn:  900,
		tokensOut: 200,
	})
	if helper == nil {
		return
	}
	s.engine.AddEvent(lead, "spawn_agent", helper.Name+" took the next desk", nil)
	s.talk(lead, helper, "Can you take this for me: "+models.LowerFirst(helper.Task)+"?",
		models.MessageHandoff)
	s.engine.Toast(helper.Name + " joined, next to " + lead.Name)
	s.after(3500, func() {
		if lead.State == models.StateSpawning {
			s.setState(lead, models.StateReading)
		}
	})
}

func (s *Simulator) talk(from, to *models.LiveAgent, text string, kind models.MessageKind) {
	if !s.stillHere(from) || !s.stillHere(to) {
		return
	}
	s.engine.AddMessage(from, to, text, kind, 0)
	from.Talk = "To " + to.Name + ": " + text
	from.TalkUntil = s.now() + 4500
	from.TalkColor = models.MessageColors[kind]
	s.engine.AddEvent(from, "message", "To "+to.Name+": "+text, nil)
}

// firstFile names the agent's first file for a line of chat, or fallback when it has none to name.
// A folder in the list, such as "test/", is named with its slash, so no line is left with a
// blank where the file goes.
func firstFile(agent *models.LiveAgent, fallback string) string {
	for _, file := range agent.Files {
		if name := models.BaseName(file); name != "" {
			return name
		}
	}
	return fallback
}

var placeholders = regexp.MustCompile(`\{(\w+)\}`)

func fill(template string, values map[string]string) string {
	return placeholders.ReplaceAllStringFunc(template, func(match string) string {
		return values[match[1:len(match)-1]]
	})
}

func (s *Simulator) conversationTick() {
	s.convTimer++
	if s.convTimer < conversationEvery {
		return
	}
	s.convTimer = 0
	var pool []*models.LiveAgent
	for _, agent := range s.engine.Agents() {
		if agent.Source == Source && !agent.Leaving && agent.State != models.StateError {
			pool = append(pool, agent)
		}
	}
	if len(pool) < 2 {
		return
	}
	first := pick(s, pool)
	var peers []*models.LiveAgent
	for _, other := range pool {
		if other != first && (sameProject(other, first) || isLeadOf(first, other) ||
			isLeadOf(other, first)) {
			peers = append(peers, other)
		}
	}
	if len(peers) == 0 {
		return
	}
	second := pick(s, peers)
	var sub, lead *models.LiveAgent
	if isLeadOf(second, first) {
		sub, lead = first, second
	} else if isLeadOf(first, second) {
		sub, lead = second, first
	}
	var template chatTemplate
	if sub != nil {
		template = pick(s, subTalk)
		first, second = sub, lead
	} else {
		template = pick(s, peerTalk)
	}
	values := chatValues(first, second)
	s.talk(first, second, fill(template.say, values), template.kind)
	s.after(3200, func() {
		s.talk(second, first, fill(template.answer, values), models.MessageAnswer)
	})
}

// chatValues fills the blanks in a line of chat between two agents. None is ever empty.
func chatValues(first, second *models.LiveAgent) map[string]string {
	return map[string]string{
		"fileA": firstFile(first, "app.ts"),
		"fileB": firstFile(second, "index.ts"),
		"fileL": firstFile(second, "index.ts"),
		"etaB":  models.ETAWords(second),
		"pct":   strconv.Itoa(int(math.Round(first.Progress * 100))),
	}
}

func sameProject(a, b *models.LiveAgent) bool {
	if a.Project == nil || b.Project == nil {
		return a.Project == b.Project
	}
	return *a.Project == *b.Project
}

// isLeadOf reports whether lead is agent's lead.
func isLeadOf(lead, agent *models.LiveAgent) bool {
	return agent.Lead != nil && *agent.Lead == lead.ID
}

// Tick moves the office on by one real second, which is six office seconds.
func (s *Simulator) Tick() error {
	return s.engine.Do(func() {
		// A tick that was already waiting when the demo ended does nothing.
		if !s.demoMode {
			return
		}
		s.runTimers()
		s.tick()
		s.engine.Sweep()
	})
}

func (s *Simulator) runTimers() {
	now := s.now()
	var due, later []timer
	for _, item := range s.timers {
		if item.at <= now {
			due = append(due, item)
		} else {
			later = append(later, item)
		}
	}
	s.timers = later
	sort.SliceStable(due, func(i, j int) bool { return due[i].at < due[j].at })
	for _, item := range due {
		item.work()
	}
}

func (s *Simulator) tick() {
	if s.demoMode && s.demoEnds > 0 && s.now() >= s.demoEnds {
		s.endDemo("The demo office turned itself off", "The demo has ended. Only real agents show in the office now.")
		return
	}
	for _, agent := range s.engine.Agents() {
		s.tickAgent(agent)
	}
	s.maybeRequestApproval()
	s.conversationTick()
}

func (s *Simulator) tickAgent(agent *models.LiveAgent) {
	if agent.Source != Source {
		return
	}
	state := s.runtimeOf(agent)
	switch {
	case agent.State.Active(), agent.State == models.StateApproval,
		agent.State == models.StatePaused:
		agent.Elapsed += officeSecondsPerTick
		s.engine.Touch(agent)
	}
	if agent.State == models.StateDone && s.now() > state.doneUntil {
		s.setState(agent, models.StateIdle)
		agent.Task = "Waiting for work"
		if s.demoMode {
			state.nextTask = s.now() + int64(s.between(15000, 35000))
		}
	}
	if s.demoMode && agent.State == models.StateIdle && !agent.Leaving &&
		state.nextTask != 0 && s.now() > state.nextTask {
		s.pickUpTask(agent, state)
	}
	// An agent waiting on your answer does no work, and its step doesn't run down, until you answer.
	if !agent.State.Active() || agent.Asking() {
		return
	}
	speed := 1.0
	if agent.State == models.StateThinking {
		speed = thinkingSpeed
	}
	agent.Progress = math.Min(1, agent.Progress+float64(agent.Rate*officeSecondsPerTick*speed))
	agent.TokensIn += s.rounded(200, 900)
	agent.TokensOut += s.rounded(60, 260)
	state.stateLeft -= officeSecondsPerTick
	if agent.Progress >= 1 {
		agent.State = models.StateDone
		state.doneUntil = s.now() + 9000
		s.engine.AddEvent(agent, "finish", "Task complete", nil)
		s.checkpoint(agent)
		return
	}
	if state.stateLeft <= 0 && agent.State != models.StateSpawning {
		next := (planIndex(agent.State) + 1 + int(math.Floor(s.between(0, 2)))) % len(plan)
		previous := agent.State
		s.setState(agent, plan[next])
		// A new step is a checkpoint even when it is the same kind of work, such as editing again.
		if agent.State == previous {
			s.checkpoint(agent)
		}
	}
}

// pickUpTask keeps the demo office busy by giving an idle agent something new to do.
func (s *Simulator) pickUpTask(agent *models.LiveAgent, state *runtime) {
	state.nextTask = 0
	free := slices.DeleteFunc(slices.Clone(demoTasks), func(task string) bool {
		return slices.ContainsFunc(s.engine.Agents(), func(other *models.LiveAgent) bool {
			return other.Task == task
		})
	})
	if len(free) > 0 {
		agent.Task = pick(s, free)
	} else {
		// The prototype picks from the empty list first, which uses up a random number. Doing the
		// same keeps the sequence, and the golden test, in step.
		s.random()
		agent.Task = pick(s, demoTasks)
	}
	agent.Progress = 0
	agent.Rate = s.between(0.00018, 0.00034)
	state.stateLeft = s.between(25, 45)
	s.setState(agent, models.StateThinking)
	s.engine.AddEvent(agent, "start", "Picked up a new task: "+agent.Task, nil)
	s.engine.Log(agent.Name, models.LogSession, "New task: "+agent.Task, "Started", "ok")
}

func planIndex(state models.AgentState) int {
	for index, candidate := range plan {
		if candidate == state {
			return index
		}
	}
	return -1
}

func (s *Simulator) maybeRequestApproval() {
	var candidates []*models.LiveAgent
	for _, agent := range s.engine.Agents() {
		// Only the demo's own agents are given made up approvals.
		if agent.Source != Source {
			continue
		}
		if agent.State == models.StateApproval {
			return
		}
		// An agent already waiting on an answer isn't asked for an approval on top of it.
		if agent.State.Active() && agent.Lead == nil && !agent.Asking() {
			candidates = append(candidates, agent)
		}
	}
	s.approvalTimer++
	if s.approvalTimer <= approvalEveryTicks {
		return
	}
	s.approvalTimer = 0
	if len(candidates) == 0 {
		return
	}
	agent := pick(s, candidates)
	s.runtimeOf(agent).stateLeft = waitForever // Auto approve may resume it straight away.
	s.engine.RequestApproval(agent, pick(s, approvals))
}

// Decide resumes an agent after an approval.
func (s *Simulator) Decide(agent *models.LiveAgent, approval models.Approval) {
	s.approvalTimer = 0
	if approval.Type == models.ApprovalPlan {
		s.decidePlan(agent, approval)
		return
	}
	auto := approval.DecidedBy != nil && *approval.DecidedBy == models.DecidedByAuto
	allowed := approval.Decision != nil && *approval.Decision == models.DecisionAllowed
	if !allowed {
		s.setState(agent, models.StateThinking)
		s.reply(agent, "Understood. I'll find another way.", 5000)
		return
	}
	next := models.StateEditing
	if approval.Type == models.ApprovalCommand {
		next = models.StateRunning
	}
	s.setState(agent, next)
	if auto {
		s.reply(agent, "Auto-approved. Continuing.", 5000)
		return
	}
	s.reply(agent, "Thanks. Continuing.", 5000)
	s.engine.Toast(agent.Name + " is continuing")
}

// Instruct delivers a message, or holds it. An agent waiting on you, for an approval or an answer,
// can't read anything until you've decided, so whatever it runs on the message waits and is
// delivered the moment it carries on (FIRST-2): it isn't told "Got it" on its behalf. An active
// Claude agent also takes it at its next checkpoint. One that is idle, finished, paused or stopped
// by an error takes it as a new task, so what it is told is true: it really starts (NEW-5).
func (s *Simulator) Instruct(agent *models.LiveAgent, text string) {
	if agent.State == models.StateApproval || agent.Asking() {
		s.engine.Queue(agent, text)
		return
	}
	if agent.Provider == models.ProviderClaude && agent.State.Active() {
		s.engine.Queue(agent, text)
		// The step it is on ends within a couple of ticks, so the instruction lands in seconds.
		if state := s.runtimeOf(agent); state.stateLeft > checkpointSoon {
			state.stateLeft = checkpointSoon
		}
		return
	}
	s.engine.Delivered(agent, text)
	s.engine.AddEvent(agent, "instruction", "Received: "+text, nil)
	switch agent.State {
	case models.StateIdle, models.StateDone, models.StatePaused, models.StateError:
		agent.Task = models.WithoutName(text)
		agent.Error = ""
		agent.Progress = 0
		agent.Rate = s.between(0.0012, 0.002)
		s.setState(agent, models.StateThinking)
	}
	said := models.Ack(text)
	s.reply(agent, said, 7000)
	s.engine.Answered(agent, said)
}

// Interrupt pauses an agent after its current tool call, remembering where it was.
func (s *Simulator) Interrupt(agent *models.LiveAgent) {
	if agent.State == models.StatePaused {
		return
	}
	if agent.Asking() {
		s.engine.Toast(agent.Name + " is waiting for your answer, so there is nothing to interrupt.")
		return
	}
	state := s.runtimeOf(agent)
	agent.PausedFrom, state.pausedLeft = agent.State, state.stateLeft
	agent.State = models.StatePaused
	state.stateLeft = waitForever
	s.engine.AddEvent(agent, "interrupt", "Paused by you after the current tool call", nil)
	s.engine.Log(agent.Name, models.LogInstruction, "Interrupt", "Paused", "amber")
}

// Continue resumes an interrupted agent in exactly the state it was in, with the rest of its step.
func (s *Simulator) Continue(agent *models.LiveAgent) {
	if agent.State != models.StatePaused {
		return
	}
	state := s.runtimeOf(agent)
	previous := agent.PausedFrom
	if previous == "" || previous == models.StatePaused {
		previous = models.StateThinking
	}
	agent.State, agent.PausedFrom = previous, ""
	state.stateLeft = max(12, state.pausedLeft)
	if state.pausedLeft >= waitForever {
		state.stateLeft = waitForever
	}
	s.engine.Touch(agent)
}

// AddSubagent seats a new agent at the free desk nearest its lead.
func (s *Simulator) AddSubagent(lead *models.LiveAgent, name, task, model string) *models.LiveAgent {
	count := 0
	for _, agent := range s.engine.Agents() {
		if isLeadOf(lead, agent) {
			count++
		}
	}
	if count >= models.MaxSubagents {
		s.engine.Toast(lead.Name + "'s office is full. Three subagents at most.")
		return nil
	}
	if model == "" {
		model = subModelFor(lead)
	}
	project := ""
	if lead.Project != nil {
		project = *lead.Project
	}
	helper := s.makeAgent(agentSpec{
		name: name, provider: lead.Provider, model: model, account: lead.Account, task: task,
		state: models.StateThinking, near: &lead.Desk, lead: lead, project: project,
		progress: 0.03, tokensIn: 500, tokensOut: 80, folder: lead.Folder,
	})
	if helper == nil {
		return nil
	}
	s.runtimeOf(lead).spawned = true
	s.engine.AddEvent(lead, "spawn_agent", "Started "+helper.Name+" ("+helper.Model+")", nil)
	s.talk(lead, helper, "Can you take this for me: "+models.LowerFirst(helper.Task)+"?",
		models.MessageHandoff)
	s.after(3000, func() {
		s.talk(helper, lead, "On it. I'll report back when the first part is done.",
			models.MessageAnswer)
	})
	s.engine.Log(lead.Name, models.LogSession, "Added subagent "+helper.Name+" using "+helper.Model,
		"In "+lead.Name+"'s office", "ok")
	return helper
}

// Retry starts an agent again after an error.
func (s *Simulator) Retry(agent *models.LiveAgent) {
	agent.Error = ""
	s.setState(agent, models.StateThinking)
	s.engine.AddEvent(agent, "retry", "Retrying after the error", nil)
}

// leaveAfter is how long an agent takes to walk out before it is removed.
const leaveAfter = 6000

// StopAgent ends an agent's session. It walks out, then leaves the office.
func (s *Simulator) StopAgent(agent *models.LiveAgent) {
	s.engine.Log(agent.Name, models.LogInstruction, "Stop session", "Stopped", "")
	agent.Leaving = true
	agent.State = models.StateIdle
	// Nobody is left to hear an answer.
	agent.Question = nil
	s.engine.CancelApproval(agent)
	s.engine.Touch(agent)
	s.engine.Toast(agent.Name + " stopped and left the office")
	s.after(leaveAfter, func() {
		if s.stillHere(agent) {
			s.engine.RemoveAgent(agent.ID)
		}
	})
}

func intPointer(value int) *int { return &value }

// LoadDemo replaces the office with the prototype's demo and starts it ticking.
func (s *Simulator) LoadDemo() error {
	return s.engine.Do(func() {
		s.loadDemo()
		s.Start()
	})
}

func (s *Simulator) loadDemo() {
	s.timers = nil
	s.runtimes = map[string]*runtime{}
	s.approvalTimer, s.convTimer, s.hueIndex = 0, 0, 0
	s.planned = nil
	s.demoMode = true
	s.demoEnds = s.now() + s.demoLength.Milliseconds()
	s.engine.SetDemoEnds(s.demoEnds)
	s.engine.ClearOffice()
	s.engine.SetFirstRun(false)
	s.engine.SetMeta(store.MetaDemo, "1")
	now := s.now()
	for _, project := range demoProjects(now) {
		s.engine.SaveProject(project)
	}
	const (
		claude = models.ProviderClaude
		openai = models.ProviderOpenAI
		custom = models.ProviderCustom
		code   = models.AccountClaudeCode
		codex  = models.AccountCodex
		hub    = models.AccountHub
	)
	specs := []agentSpec{
		{name: "Ledger", provider: claude, model: "claude-sonnet-4-5", account: code,
			task: "Refactor invoice totals to use whole cents", state: models.StateEditing,
			desk: intPointer(0), progress: 0.55},
		{name: "Scout", provider: openai, model: "gpt-5", account: codex,
			task: "Compare three charting libraries for the dashboard", state: models.StateBrowsing,
			desk: intPointer(1), progress: 0.4},
		{name: "Atlas", provider: claude, model: "claude-opus-4-1", account: code,
			task: "Prepare the staging database for the new orders schema", state: models.StateApproval,
			desk: intPointer(2), progress: 0.62},
		{name: "Quill", provider: openai, model: "gpt-5-codex", account: codex,
			task: "Write tests for the export module", state: models.StateSpawning,
			desk: intPointer(3), progress: 0.3},
		{name: "Bolt", provider: custom, model: "qwen2.5-coder · local", account: hub,
			task: "Run the full test suite and report failures", state: models.StateRunning,
			desk: intPointer(6), progress: 0.7},
		{name: "Pixel", provider: claude, model: "claude-haiku-4-5", account: code,
			task: "Waiting for work", state: models.StateIdle, desk: intPointer(7)},
		{name: "Rune", provider: openai, model: "gpt-5-codex", account: codex,
			task: "Update the README install steps", state: models.StateDone,
			desk: intPointer(8), progress: 1},
		{name: "Mori", provider: custom, model: "docs-indexer · custom", account: hub,
			task: "Index the docs folder for search", state: models.StateError,
			desk: intPointer(9), progress: 0.35, errorText: "Lost connection to the embedding service"},
		{name: "Sage", provider: claude, model: "claude-sonnet-4-5", account: code,
			task: "Add pagination to the orders API", state: models.StateThinking,
			desk: intPointer(10), progress: 0.45},
	}
	for _, spec := range specs {
		s.makeAgent(spec)
	}
	s.runtimeOf(s.engine.AgentByName("Rune")).doneUntil = now + 25000
	for _, agent := range s.engine.Agents() {
		agent.Rate = float64(agent.Rate / demoSlowdown)
	}
	s.runtimeOf(s.engine.AgentByName("Pixel")).nextTask = now + 60000
	for _, agent := range s.engine.Agents() {
		project := demoProjectOf[agent.Name]
		agent.Project = &project
	}
	atlas := s.engine.AgentByName("Atlas")
	s.engine.RequestApprovalQuietly(atlas, demoApproval)
	atlas.SubModel = "claude-haiku-4-5"
	s.makeAgent(agentSpec{
		name: "Atlas scribe", provider: claude, model: "claude-haiku-4-5", account: code,
		task: "Draft the migration notes for the release", state: models.StateEditing,
		near: &atlas.Desk, lead: atlas, project: "checkout", progress: 0.3,
	})
	sage := s.engine.AgentByName("Sage")
	s.engine.Queue(sage, "Also add a changelog entry when you finish")
	s.engine.Log("Ledger", models.LogInstruction, "Use the money helper instead of toFixed",
		"Delivered", "ok")
	s.engine.Log("Rune", models.LogApproval, `git commit -m "docs: update install steps"`,
		"Allowed", "ok")
	s.engine.Log("Scout", models.LogQuery, "Which library are you leaning towards?",
		"Answered from the log", "")
	s.engine.Log("Atlas", models.LogApproval, "rm -rf ./tmp/fixtures", "Denied", "red")
	s.seedConversations()
	if s.questionAfter > 0 {
		s.after(s.questionAfter.Milliseconds(), func() { s.askDemoQuestion(0) })
	}
	s.engine.Reset()
}

// askDemoQuestion has the demo's Claude agent ask its question, so the journey of being asked,
// and answering in the agent's panel, can be seen without a real session (FIRST-11). It waits
// until the agent is at work, not already waiting on you, and has read the message the demo opens
// with waiting for it, so the two don't muddle each other. It gives up after a minute.
func (s *Simulator) askDemoQuestion(attempt int) {
	agent := s.engine.AgentByName(demoAsker)
	if agent == nil || agent.Source != Source || agent.Leaving {
		return
	}
	if !agent.State.Active() || agent.Asking() || len(agent.Queued) > 0 {
		if attempt < 6 {
			s.after(10_000, func() { s.askDemoQuestion(attempt + 1) })
		}
		return
	}
	asked := demoQuestion
	asked.Items = slices.Clone(demoQuestion.Items)
	s.engine.Ask(agent, asked)
}

// Answer takes your answers to a demo agent's question, once the engine has checked them, and the
// agent carries on from where it asked, saying what it will do. A message that waited for it is
// delivered now. Call inside Do.
func (s *Simulator) Answer(agent *models.LiveAgent, question models.Question, answers []models.QuestionAnswer) bool {
	if !s.stillHere(agent) || len(answers) != len(question.Items) {
		return false
	}
	chosen := make([]string, len(question.Items))
	for index, item := range question.Items {
		chosen[index] = models.AnswerText(item, answers[index])
	}
	s.checkpoint(agent)
	s.reply(agent, "Thanks. Going with "+strings.Join(chosen, " and ")+".", 7000)
	s.engine.Toast(agent.Name + " is carrying on")
	return true
}

func (s *Simulator) seedConversations() {
	ordered := append([]seededMessage{}, seededMessages...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].ago > ordered[j].ago })
	for _, message := range ordered {
		from, to := s.engine.AgentByName(message.from), s.engine.AgentByName(message.to)
		s.engine.AddMessage(from, to, message.text, message.kind, message.ago)
	}
}

// DemoActive reports whether the demo office is running. Call inside Do.
func (s *Simulator) DemoActive() bool { return s.demoMode }

// PlannedMember is a subagent that joins its lead's office once the team starts.
type PlannedMember struct {
	Name  string
	Task  string
	Model string
}

// planWait is how long a lead takes to write its plan before asking for an OK.
const planWait = 4200

// StartTeam brings a lead's subagents in, one after another. With askFirst, the lead first
// posts its plan as an approval, and the team starts only when the plan is allowed. Call
// inside Do.
func (s *Simulator) StartTeam(lead *models.LiveAgent, members []PlannedMember, askFirst bool, project string, steps []string) {
	if len(members) == 0 {
		return
	}
	if !askFirst {
		s.spawnTeam(lead, members)
		return
	}
	if s.planned == nil {
		s.planned = map[string][]PlannedMember{}
	}
	s.planned[lead.ID] = members
	s.after(planWait, func() {
		if !s.stillHere(lead) {
			return
		}
		s.engine.AddEvent(lead, "approval", "Plan ready for your OK", nil)
		s.engine.RequestApproval(lead, models.Approval{
			Type: models.ApprovalPlan, Title: "wants you to approve its plan",
			Detail:    models.ApprovalDetail{Project: project, Steps: steps},
			Risk:      "Nothing changes until you approve. If you deny, " + lead.Name + " reworks the plan.",
			RiskLevel: models.RiskLow,
		})
	})
}

func (s *Simulator) spawnTeam(lead *models.LiveAgent, members []PlannedMember) {
	for index, member := range members {
		member := member
		s.after(int64(1200+index*1600), func() {
			if s.stillHere(lead) {
				s.AddSubagent(lead, member.Name, member.Task, member.Model)
			}
		})
	}
}

// decidePlan starts the team on an allowed plan. On a denied one the lead reworks it.
func (s *Simulator) decidePlan(lead *models.LiveAgent, approval models.Approval) {
	members := s.planned[lead.ID]
	delete(s.planned, lead.ID)
	s.setState(lead, models.StateThinking)
	if approval.Decision == nil || *approval.Decision != models.DecisionAllowed {
		s.reply(lead, "I'll rework the plan and come back to you.", 5000)
		return
	}
	s.reply(lead, "Thanks. Bringing in the team.", 5000)
	s.spawnTeam(lead, members)
}

// Forget drops the demo without touching the office, after a wipe has already cleared it.
// Call inside Do.
func (s *Simulator) Forget() {
	s.Stop()
	s.timers, s.runtimes, s.planned = nil, map[string]*runtime{}, nil
	s.demoMode, s.demoEnds, s.approvalTimer, s.convTimer = false, 0, 0, 0
	s.engine.SetDemoEnds(0)
}

// StopDemo ends the demo office when someone asks. Call inside Do.
func (s *Simulator) StopDemo() {
	s.endDemo("Stopped the demo office", "")
}

// endDemo takes the simulated agents and the demo's projects, messages and log away. The demo's
// pretend sign ins were only ever shown, so the accounts are as they really are. Loading the demo cleared the office,
// so every project now belongs to the demo, including ones made while it ran, unless a real agent
// works in it. The demo's own projects always go. Every real agent stays. Call inside Do.
func (s *Simulator) endDemo(why, toast string) {
	s.Stop()
	s.timers = nil
	s.runtimes = map[string]*runtime{}
	s.planned = nil
	s.demoMode = false
	s.demoEnds = 0
	s.approvalTimer, s.convTimer = 0, 0
	s.engine.SetDemoEnds(0)
	seeded := map[string]bool{}
	for _, project := range demoProjects(s.now()) {
		seeded[project.ID] = true
	}
	var kept []*models.LiveAgent
	used := map[string]bool{}
	for _, agent := range s.engine.Agents() {
		if agent.Source != Source {
			// A real agent placed in one of the demo's own projects leaves it: those always go.
			if agent.Project != nil && seeded[*agent.Project] {
				agent.Project = nil
			}
			kept = append(kept, agent)
			if agent.Project != nil {
				used[*agent.Project] = true
			}
		}
	}
	var projects []models.Project
	for _, project := range s.engine.Projects() {
		if used[project.ID] {
			projects = append(projects, *project)
		}
	}
	s.engine.ClearOffice()
	for _, project := range projects {
		s.engine.SaveProject(project)
	}
	for _, agent := range kept {
		s.engine.KeepAgent(agent)
	}
	s.engine.SetMeta(store.MetaDemo, "0")
	s.engine.Log("Everyone", models.LogSession, why, "Only real agents from now on", "")
	if toast != "" {
		s.engine.Toast(toast)
	}
	s.engine.Reset()
}
