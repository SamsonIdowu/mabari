// SPDX-License-Identifier: Apache-2.0

// Package events is Mabari's single pipeline: everything agents do passes through the Engine, which
// stores it and broadcasts it, so the UI can't tell a demo agent from a real one.
package events

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

const (
	historySize  = 4096
	messageLimit = 400
	logLimit     = 500
)

// Connector is a source of agents. The simulator is the first; Claude Code, Codex and the hub
// follow in Stage 7. Its methods run inside Engine.Do, so they must not call Do themselves.
type Connector interface {
	Start()
	Stop()
	Instruct(agent *models.LiveAgent, text string)
	// Decide resumes an agent after the Engine has recorded the decision.
	Decide(agent *models.LiveAgent, approval models.Approval)
	Interrupt(agent *models.LiveAgent)
	// Continue resumes an interrupted agent from where it stopped.
	Continue(agent *models.LiveAgent)
	// StopAgent ends one agent's session.
	StopAgent(agent *models.LiveAgent)
	// Retry starts an agent again after an error.
	Retry(agent *models.LiveAgent)
	// AddSubagent seats a new agent in a lead's office, or returns nil if it can't.
	AddSubagent(lead *models.LiveAgent, name, task, model string) *models.LiveAgent
	Models() []string
}

// Engine owns the office's live state. Every mutating method must run inside Do.
type Engine struct {
	mu         sync.Mutex
	store      *store.Store
	now        func() time.Time
	bootID     string
	seq        uint64
	history    []models.ServerMessage
	subs       map[*Subscription]struct{}
	agents     []*models.LiveAgent
	projects   []*models.Project
	accounts   map[models.AccountKind]*models.Account
	settings   models.Settings
	firstRun   bool
	demo       bool
	demoEndsAt int64
	messages   []models.Message
	log        []models.LogEntry
	dirty      map[string]struct{}
	eventNext  map[string]int
	connectors map[string]Connector
	writeErr   error
	// defs are the agent definitions from the agent folders. A wipe leaves them: they are files.
	defs []models.AgentDef
	// accountNotes adds what only the running server knows to each account as the office shows it.
	accountNotes func(account models.Account, demo bool) models.Account
	// quiet is set while a group action runs, so what its steps would each say is said once.
	quiet bool
}

// New loads the office from the store. Pass nil for now to use the real clock.
func New(ctx context.Context, s *store.Store, now func() time.Time) (*Engine, error) {
	if now == nil {
		now = time.Now
	}
	e := &Engine{
		store:      s,
		now:        now,
		bootID:     newID(""),
		subs:       map[*Subscription]struct{}{},
		dirty:      map[string]struct{}{},
		eventNext:  map[string]int{},
		connectors: map[string]Connector{},
	}
	if err := e.load(ctx); err != nil {
		return nil, fmt.Errorf("load office: %w", err)
	}
	return e, nil
}

func newID(prefix string) string {
	raw := make([]byte, 12)
	_, _ = rand.Read(raw) // crypto/rand never fails on supported platforms.
	return prefix + hex.EncodeToString(raw)
}

func (e *Engine) load(ctx context.Context) error {
	e.resetMemory()
	settings, err := e.store.Settings(ctx)
	if err != nil {
		return err
	}
	e.settings = settings

	firstRun, err := e.store.Meta(ctx, store.MetaFirstRun)
	if err != nil {
		return err
	}
	e.firstRun = firstRun != "0"
	demo, err := e.store.Meta(ctx, store.MetaDemo)
	if err != nil {
		return err
	}
	e.demo = demo == "1"

	accounts, err := e.store.Accounts(ctx)
	if err != nil {
		return err
	}
	for index := range accounts {
		e.accounts[accounts[index].Kind] = &accounts[index]
	}

	projects, err := e.store.Projects(ctx)
	if err != nil {
		return err
	}
	for index := range projects {
		e.projects = append(e.projects, &projects[index])
	}

	if e.messages, err = e.store.Messages(ctx, messageLimit); err != nil {
		return err
	}
	if e.log, err = e.store.Log(ctx, store.LogQuery{Limit: logLimit}); err != nil {
		return err
	}
	if err := e.loadEventNumbers(ctx); err != nil {
		return err
	}
	if err := e.loadAgents(ctx); err != nil {
		return err
	}
	e.reseat()
	e.dropPlaceholder()
	return nil
}

// dropPlaceholder removes the empty "My first project" earlier versions made on a fresh install
// and after a wipe, unless someone gave it a folder, instructions or files. Sessions that were put
// in it only because it was the first project are left with no project. Projects are only ever
// ones people made.
func (e *Engine) dropPlaceholder() {
	for _, project := range e.projects {
		if project.ID == placeholderID && project.Name == "My first project" && project.Repository == nil &&
			project.Instructions == "" && len(project.Files) == 0 {
			e.RemoveProject(placeholderID)
			return
		}
	}
}

// placeholderID is the id of the empty project earlier versions made.
const placeholderID = "general"

func (e *Engine) loadEventNumbers(ctx context.Context) error {
	ids, err := e.store.EventIDs(ctx)
	if err != nil {
		return err
	}
	for _, id := range ids {
		cut := strings.LastIndexByte(id, '-')
		if cut < 0 {
			continue
		}
		if number, err := strconv.Atoi(id[cut+1:]); err == nil {
			e.eventNext[id[:cut]] = max(e.eventNext[id[:cut]], number+1)
		}
	}
	return nil
}

func (e *Engine) loadAgents(ctx context.Context) error {
	agents, err := e.store.Agents(ctx)
	if err != nil {
		return err
	}
	pending, err := e.store.Approvals(ctx, true)
	if err != nil {
		return err
	}
	for index := range agents {
		agent := &agents[index]
		if agent.Feed, err = e.store.Events(ctx, agent.ID, models.FeedLimit, 0); err != nil {
			return err
		}
		if agent.Queued, err = e.store.WaitingInstructions(ctx, agent.ID); err != nil {
			return err
		}
		// Pending approvals come newest first, and the newest is the one the agent waits on.
		for _, approval := range pending {
			if approval.Agent == agent.ID {
				copied := approval
				agent.Approval = &copied
				break
			}
		}
		e.agents = append(e.agents, agent)
	}
	return nil
}

func (e *Engine) resetMemory() {
	e.agents, e.projects, e.messages, e.log = nil, nil, []models.Message{}, []models.LogEntry{}
	e.dirty = map[string]struct{}{}
	e.eventNext = map[string]int{}
	e.accounts = map[models.AccountKind]*models.Account{}
	for _, kind := range models.AccountKinds {
		e.accounts[kind] = &models.Account{
			ID: string(kind), Kind: kind, Status: models.AccountOff, Models: models.Models[kind],
		}
	}
}

// AddConnector registers the connector for a source of agents.
func (e *Engine) AddConnector(source string, c Connector) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.connectors[source] = c
}

// Do runs work with exclusive access to the office, then stores and broadcasts what changed.
func (e *Engine) Do(work func()) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	work()
	e.flush()
	err := e.writeErr
	e.writeErr = nil
	return err
}

func (e *Engine) record(err error) {
	if err != nil {
		slog.Error("could not save to the database", "error", err)
		e.writeErr = errors.Join(e.writeErr, err)
	}
}

func (e *Engine) flush() {
	if len(e.dirty) == 0 {
		return
	}
	now := e.now()
	var changed []*models.LiveAgent
	e.seatWorkflow()
	// A lead's whole team estimate moves with its subagents.
	for _, agent := range e.agents {
		if _, ok := e.dirty[agent.ID]; ok && agent.Lead != nil {
			e.dirty[*agent.Lead] = struct{}{}
		}
		agent.Refresh(now)
	}
	e.record(e.store.Transaction(context.Background(), func() error {
		for _, agent := range e.agents {
			if _, ok := e.dirty[agent.ID]; !ok {
				continue
			}
			e.refreshTeam(agent)
			if err := e.store.SaveAgent(context.Background(), *agent); err != nil {
				return err
			}
			changed = append(changed, agent)
		}
		return nil
	}))
	e.dirty = map[string]struct{}{}
	for _, agent := range changed {
		copied := *agent
		copied.Feed = nil
		e.broadcast(models.ServerMessage{Type: models.MsgAgent, Agent: &copied})
	}
	e.refreshProjects(now, true)
}

// reseat checks every seat after a restart. Contractors (workflow sub-agents and subagents) give
// theirs up and take one again in the first flush if they are on duty, and an agent sharing a desk with an earlier one,
// as the workflow benches' seats could after they went, moves to a free desk. Call while loading.
func (e *Engine) reseat() {
	taken := map[int]bool{}
	for _, agent := range e.agents {
		if agent.Contractor() {
			agent.Desk = models.OffFloor
			e.dirty[agent.ID] = struct{}{}
		}
	}
	for _, agent := range e.agents {
		if agent.Contractor() {
			continue
		}
		if agent.Desk < 0 || taken[agent.Desk] {
			agent.Desk = models.FreeDesk(e.agents, -1)
			e.dirty[agent.ID] = struct{}{}
		}
		taken[agent.Desk] = true
	}
}

// seatWorkflow keeps only contractors on duty in the office, workflow sub-agents and subagents,
// so it always shows how many are at work. One that stops gives up its desk and leaves the floor,
// and
// one that starts again takes the free desk nearest its lead, or the lowest free one. Desks are
// given up first, so a desk freed in this flush can be taken in it. Call inside Do, before
// agents are saved.
func (e *Engine) seatWorkflow() {
	var arriving []*models.LiveAgent
	for _, agent := range e.agents {
		if _, ok := e.dirty[agent.ID]; !ok || !agent.Contractor() {
			continue
		}
		if agent.Leaving {
			continue
		}
		onDuty := agent.State.OnDuty() || agent.Asking()
		switch {
		case !onDuty && agent.Desk != models.OffFloor:
			agent.Desk = models.OffFloor
		case onDuty && agent.Desk == models.OffFloor:
			arriving = append(arriving, agent)
		}
	}
	for _, agent := range arriving {
		near := -1
		if agent.Lead != nil {
			if lead := e.Agent(*agent.Lead); lead != nil {
				near = lead.Desk
			}
		}
		// With every desk taken it stays off the floor, and tries again when it next changes.
		agent.Desk = models.FreeDesk(e.agents, near)
	}
}

// refreshTeam works out when a lead and its subagents should all be done. Agents with no
// subagents have no team estimate.
func (e *Engine) refreshTeam(lead *models.LiveAgent) {
	estimates := []*models.Estimate{lead.Estimate}
	for _, agent := range e.agents {
		if agent.Lead != nil && *agent.Lead == lead.ID {
			estimates = append(estimates, agent.Estimate)
		}
	}
	lead.TeamEstimate = nil
	if len(estimates) > 1 {
		lead.TeamEstimate = models.LatestFinish(estimates...)
	}
}

// refreshProjects recomputes what the server derives from each project's agents.
func (e *Engine) refreshProjects(now time.Time, announce bool) {
	for _, project := range e.projects {
		var members []*models.LiveAgent
		var estimates []*models.Estimate
		for _, agent := range e.agents {
			if agent.Project != nil && *agent.Project == project.ID {
				members = append(members, agent)
				agent.Refresh(now)
				estimates = append(estimates, agent.Estimate)
			}
		}
		status, progress := models.ProjectState(project, members)
		estimate := models.LatestFinish(estimates...)
		if project.Done != nil {
			estimate = nil
		}
		same := project.Status == status && project.Progress == progress &&
			sameEstimate(project.Estimate, estimate)
		project.Status, project.Progress, project.Estimate = status, progress, estimate
		if announce && !same {
			copied := *project
			e.broadcast(models.ServerMessage{Type: models.MsgProject, Project: &copied})
		}
	}
}

func sameEstimate(a, b *models.Estimate) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// ConnectorFor returns the connector that runs an agent, or nil. Call inside Do.
func (e *Engine) ConnectorFor(agent *models.LiveAgent) Connector {
	return e.connectors[agent.Source]
}

// Now is the engine's clock.
func (e *Engine) Now() time.Time { return e.now() }

// Settings returns the current settings. Call inside Do.
func (e *Engine) Settings() models.Settings { return e.settings.Clone() }

// SaveSettings stores new settings. Call inside Do.
func (e *Engine) SaveSettings(settings models.Settings) {
	settings = settings.Clone()
	e.settings = settings
	e.record(e.store.SaveSettings(context.Background(), settings))
	e.broadcast(models.ServerMessage{Type: models.MsgSettings, Settings: &settings})
}

// CorrectModels makes every model choice in the settings one that an account offers, keeping the
// pages honest about which model is used, and says in the log, and in one toast, what it changed.
// It reads the accounts as stored, so a pretend demo account never decides. Call inside Do.
func (e *Engine) CorrectModels() {
	settings, changes := models.CorrectModels(e.settings, e.StoredAccounts())
	if len(changes) == 0 {
		return
	}
	e.SaveSettings(settings)
	for _, change := range changes {
		e.Log("Everyone", models.LogSession, "Corrected a model setting", change, "")
	}
	e.Toast(strings.Join(changes, " "))
}

// Projects lists projects in the order they were made. Call inside Do.
func (e *Engine) Projects() []*models.Project { return e.projects }

// Agents lists agents in the order they arrived. Call inside Do.
func (e *Engine) Agents() []*models.LiveAgent { return e.agents }

// Agent finds an agent by id, or returns nil. Call inside Do.
func (e *Engine) Agent(id string) *models.LiveAgent {
	for _, agent := range e.agents {
		if agent.ID == id {
			return agent
		}
	}
	return nil
}

// AgentByName finds an agent by name, ignoring case, or returns nil. Call inside Do.
func (e *Engine) AgentByName(name string) *models.LiveAgent {
	for _, agent := range e.agents {
		if strings.EqualFold(agent.Name, name) {
			return agent
		}
	}
	return nil
}

// AddAgent puts a new agent in the office. Call inside Do.
func (e *Engine) AddAgent(agent *models.LiveAgent) {
	if agent.ID == "" {
		agent.ID = newID("agent-")
	}
	if agent.CreatedAt == 0 {
		agent.CreatedAt = e.now().UnixMilli()
	}
	e.agents = append(e.agents, agent)
	e.Touch(agent)
}

// Touch marks an agent as changed, after updating its fields. Call inside Do.
func (e *Engine) Touch(agent *models.LiveAgent) { e.dirty[agent.ID] = struct{}{} }

// KeepAgent puts a real agent back after the office was cleared, as the demo does when it ends,
// and stores again what was cleared with it: its waiting approval, its instructions and its steps.
// Call inside Do.
func (e *Engine) KeepAgent(agent *models.LiveAgent) {
	e.AddAgent(agent)
	ctx := context.Background()
	if agent.Approval != nil {
		e.record(e.store.SaveApproval(ctx, *agent.Approval))
	}
	for _, instruction := range agent.Queued {
		e.record(e.store.SaveInstruction(ctx, instruction))
	}
	for _, instruction := range agent.Asked {
		e.record(e.store.SaveInstruction(ctx, instruction))
	}
	for index := len(agent.Feed) - 1; index >= 0; index-- {
		event := agent.Feed[index]
		e.record(e.store.AddEvent(ctx, event))
		// Event numbers carry on from the kept steps, so new ones never repeat an id.
		if cut := strings.LastIndex(event.ID, "-"); cut > 0 {
			if number, err := strconv.Atoi(event.ID[cut+1:]); err == nil {
				e.eventNext[event.ID[:cut]] = max(e.eventNext[event.ID[:cut]], number+1)
			}
		}
	}
}

// RemoveAgent takes an agent out of the office. Call inside Do.
func (e *Engine) RemoveAgent(id string) {
	for index, agent := range e.agents {
		if agent.ID == id {
			e.CancelApproval(agent)
			// Nothing will deliver what it was still waiting for.
			for _, instruction := range agent.Queued {
				e.settle(instruction, "Not delivered: the agent left")
			}
			e.agents = append(e.agents[:index:index], e.agents[index+1:]...)
			break
		}
	}
	delete(e.dirty, id)
	e.record(e.store.DeleteAgent(context.Background(), id))
	e.broadcast(models.ServerMessage{Type: models.MsgRemove, ID: id})
}

func eventPrefix(name string) string {
	return strings.ReplaceAll(strings.ToLower(name), " ", "-")
}

// AddEvent records something an agent did. Call inside Do.
func (e *Engine) AddEvent(agent *models.LiveAgent, tool, summary string, raw any) models.Event {
	prefix := eventPrefix(agent.Name)
	number := max(e.eventNext[prefix], 1)
	e.eventNext[prefix] = number + 1
	event := models.Event{
		ID:      prefix + "-" + strconv.Itoa(number),
		Agent:   agent.ID,
		Time:    e.now().UnixMilli(),
		Tool:    tool,
		Summary: summary,
		Raw:     raw,
	}
	feed := append([]models.Event{event}, agent.Feed...)
	agent.Feed = feed[:min(len(feed), models.FeedLimit)]
	e.Touch(agent)
	e.record(e.store.AddEvent(context.Background(), event))
	e.broadcast(models.ServerMessage{Type: models.MsgEvent, Event: &event})
	return event
}

// AddMessage records something one agent said to another, secondsAgo in the past. Call inside Do.
func (e *Engine) AddMessage(
	from, to *models.LiveAgent, text string, kind models.MessageKind, secondsAgo int64,
) models.Message {
	message := models.Message{
		ID:       newID("msg-"),
		From:     from.ID,
		To:       []string{to.ID},
		FromName: from.Name,
		ToName:   to.Name,
		Project:  from.Project,
		Kind:     kind,
		Text:     text,
		Time:     e.now().UnixMilli() - secondsAgo*1000,
	}
	e.messages = append(e.messages, message)
	if len(e.messages) > messageLimit {
		e.messages = e.messages[1:]
	}
	e.record(e.store.AddMessage(context.Background(), message))
	e.broadcast(models.ServerMessage{Type: models.MsgMessage, Message: &message})
	return message
}

// Log adds a row to the activity log. Call inside Do.
func (e *Engine) Log(agent string, kind models.LogType, message, outcome, chip string) models.LogEntry {
	entry := models.LogEntry{
		ID:      newID("log-"),
		Time:    e.now().UnixMilli(),
		Agent:   agent,
		Type:    kind,
		Message: message,
		Outcome: outcome,
		Chip:    chip,
	}
	e.log = append([]models.LogEntry{entry}, e.log...)
	e.log = e.log[:min(len(e.log), logLimit)]
	e.record(e.store.SaveLog(context.Background(), entry))
	e.broadcast(models.ServerMessage{Type: models.MsgLog, Log: &entry})
	return entry
}

// UpdateLog changes a row's outcome, such as when a queued instruction is delivered. Call inside Do.
func (e *Engine) UpdateLog(id, outcome, chip string) {
	for index := range e.log {
		if e.log[index].ID != id {
			continue
		}
		e.log[index].Outcome, e.log[index].Chip = outcome, chip
		entry := e.log[index]
		e.record(e.store.SaveLog(context.Background(), entry))
		e.broadcast(models.ServerMessage{Type: models.MsgLog, Log: &entry})
		return
	}
}

// Toast shows a short notice in the UI. Call inside Do.
func (e *Engine) Toast(text string) {
	if e.quiet {
		return
	}
	e.broadcast(models.ServerMessage{Type: models.MsgToast, Text: text})
}

// Quietly runs work with the toasts its steps would each show held back, for an action on a group
// of agents that tells the person once, at the end. A connector that would write a plain row to the
// activity log asks Quiet first. Instructions still log: each is a row of its own that its
// delivery updates. Call inside Do.
func (e *Engine) Quietly(work func()) {
	was := e.quiet
	e.quiet = true
	defer func() { e.quiet = was }()
	work()
}

// Quiet reports whether a group action is running through Quietly, so a connector leaves out the
// log row and notice it would write for one agent, and the group's own row says it for everyone.
func (e *Engine) Quiet() bool { return e.quiet }

// Reset tells clients the office was replaced, by a wipe or the demo, so they reload the snapshot
// and clear what they were looking at. Call inside Do.
func (e *Engine) Reset() { e.broadcast(models.ServerMessage{Type: models.MsgReset}) }

// Resync tells clients to reload the snapshot but keep their view, after a change too wide to
// patch such as retention. Call inside Do.
func (e *Engine) Resync() { e.broadcast(models.ServerMessage{Type: models.MsgResync}) }

// Queue holds an instruction for the agent's next checkpoint. Call inside Do.
func (e *Engine) Queue(agent *models.LiveAgent, text string) {
	entry := e.Log(agent.Name, models.LogInstruction, text, "Waiting for checkpoint", "amber")
	id := agent.ID
	instruction := models.Instruction{
		ID:     newID("ins-"),
		Agent:  &id,
		Text:   text,
		Mode:   models.ModeInstruct,
		Status: models.InstructionWaiting,
		Time:   e.now().UnixMilli(),
		LogID:  entry.ID,
	}
	agent.Queued = append(agent.Queued[:len(agent.Queued):len(agent.Queued)], instruction)
	e.Touch(agent)
	e.record(e.store.SaveInstruction(context.Background(), instruction))
}

// NextQueued delivers the oldest waiting instruction, if any. Call inside Do.
func (e *Engine) NextQueued(agent *models.LiveAgent) (models.Instruction, bool) {
	if len(agent.Queued) == 0 {
		return models.Instruction{}, false
	}
	instruction := agent.Queued[0]
	agent.Queued = agent.Queued[1:]
	instruction.Status = models.InstructionDelivered
	e.Touch(agent)
	e.record(e.store.SaveInstruction(context.Background(), instruction))
	e.UpdateLog(instruction.LogID, "Delivered at checkpoint", "ok")
	e.remember(agent, instruction)
	return instruction, true
}

// Delivered records an instruction that went straight into the agent's session, as Codex takes
// them, so its reply can be shown with it. Call inside Do.
func (e *Engine) Delivered(agent *models.LiveAgent, text string) models.Instruction {
	entry := e.Log(agent.Name, models.LogInstruction, text, "Delivered", "ok")
	id := agent.ID
	instruction := models.Instruction{
		ID: newID("ins-"), Agent: &id, Text: text, Mode: models.ModeInstruct,
		Status: models.InstructionDelivered, Time: e.now().UnixMilli(), LogID: entry.ID,
	}
	e.record(e.store.SaveInstruction(context.Background(), instruction))
	e.remember(agent, instruction)
	return instruction
}

// Unqueue takes back an instruction still waiting for its agent's next checkpoint, so it is never
// delivered. It returns the agent that held it, and false when no agent holds it any more,
// because it was delivered or never existed. A prompt Claude Code was opened with can't be taken
// back: the session already has it. Call inside Do, where delivery happens too, so the two can't
// race.
func (e *Engine) Unqueue(id string) (string, bool) {
	for _, agent := range e.agents {
		for index, instruction := range agent.Queued {
			if instruction.ID == id {
				agent.Queued = append(agent.Queued[:index:index], agent.Queued[index+1:]...)
				e.Touch(agent)
				e.settle(instruction, "Removed before delivery")
				return agent.Name, true
			}
		}
	}
	return "", false
}

// settle closes an instruction that will never be delivered, so it never comes back after a
// restart, and takes the amber off its activity row.
func (e *Engine) settle(instruction models.Instruction, outcome string) {
	instruction.Status = models.InstructionRemoved
	e.record(e.store.SaveInstruction(context.Background(), instruction))
	e.UpdateLog(instruction.LogID, outcome, "")
}

// Opening holds a prompt for the Claude Code session Mabari is opening in the project's folder.
// Call inside Do.
func (e *Engine) Opening(project *models.Project, text string) models.Instruction {
	entry := e.Log(project.Name, models.LogInstruction, text, "Opening Claude Code", "")
	instruction := models.Instruction{
		ID: newID("ins-"), Text: text, Mode: models.ModeInstruct,
		Status: models.InstructionWaiting, Time: e.now().UnixMilli(), LogID: entry.ID,
	}
	saved := *project
	saved.Opening = append(project.Opening[:len(project.Opening):len(project.Opening)], instruction)
	e.SaveProject(saved)
	return instruction
}

// DropOpening forgets a prompt whose Claude Code window never opened, with the reason for its
// activity row. Call inside Do.
func (e *Engine) DropOpening(id, outcome string) {
	for _, project := range e.projects {
		for index, instruction := range project.Opening {
			if instruction.ID == id {
				saved := *project
				saved.Opening = append(project.Opening[:index:index], project.Opening[index+1:]...)
				e.SaveProject(saved)
				e.settle(instruction, outcome)
				return
			}
		}
	}
}

// TakeOpening gives a session in a project the prompt Mabari opened it with. Claude Code reports
// that first prompt as the session's first UserPromptSubmit, so the prompt is matched by its
// text: a session the person started by hand, or another window, never takes it. It reports
// false when nothing matched. Call inside Do.
func (e *Engine) TakeOpening(agent *models.LiveAgent, prompt string) bool {
	prompt = strings.TrimSpace(prompt)
	if agent.Project == nil || prompt == "" {
		return false
	}
	project := e.Project(*agent.Project)
	if project == nil {
		return false
	}
	for index, instruction := range project.Opening {
		if strings.TrimSpace(instruction.Text) != prompt {
			continue
		}
		saved := *project
		saved.Opening = append(project.Opening[:index:index], project.Opening[index+1:]...)
		e.SaveProject(saved)
		id := agent.ID
		instruction.Agent, instruction.Status = &id, models.InstructionDelivered
		e.record(e.store.SaveInstruction(context.Background(), instruction))
		e.UpdateLog(instruction.LogID, "Delivered when the session started", "ok")
		e.remember(agent, instruction)
		return true
	}
	return false
}

// pruneOpenings drops prompts left waiting longer than OpeningKept for their session: its window
// was closed, or it never reported. Call inside Do.
func (e *Engine) pruneOpenings(now int64) {
	for _, project := range e.projects {
		var stale []models.Instruction
		for _, instruction := range project.Opening {
			if now-instruction.Time > models.OpeningKept {
				stale = append(stale, instruction)
			}
		}
		for _, instruction := range stale {
			e.DropOpening(instruction.ID, "Claude Code never reported back")
		}
	}
}

// remember keeps a delivered instruction on the agent, for its panel, dropping the oldest.
func (e *Engine) remember(agent *models.LiveAgent, instruction models.Instruction) {
	asked := append(agent.Asked[:len(agent.Asked):len(agent.Asked)], instruction)
	if len(asked) > models.AskedKept {
		asked = asked[len(asked)-models.AskedKept:]
	}
	agent.Asked = asked
	e.Touch(agent)
}

// Answered gives the agent's reply to every instruction it had that is still waiting for one,
// and says so on the activity log and in a toast. text should already be redacted. It returns
// false when nothing from Mabari was waiting, so a reply to the person's own terminal prompt
// isn't shown as an answer to them. Call inside Do.
func (e *Engine) Answered(agent *models.LiveAgent, text string) bool {
	text = strings.TrimSpace(text)
	if text == "" {
		return false
	}
	if utf8.RuneCountInString(text) > models.ReplyLimit {
		text = models.Clip(text, models.ReplyLimit) + "\n\n(The rest is in the agent's own session.)"
	}
	now := e.now().UnixMilli()
	answered := false
	asked := append([]models.Instruction{}, agent.Asked...)
	for index := range asked {
		instruction := &asked[index]
		if instruction.Reply != "" {
			continue
		}
		instruction.Reply, instruction.RepliedAt = text, now
		e.record(e.store.SaveInstruction(context.Background(), *instruction))
		e.UpdateLog(instruction.LogID, "Replied", "ok")
		answered = true
	}
	if !answered {
		return false
	}
	agent.Asked = asked
	e.Touch(agent)
	e.Toast(agent.Name + " replied. Open " + agent.Name + " to read it.")
	return true
}

func approvalSummary(a models.Approval) string {
	switch a.Type {
	case models.ApprovalCommand:
		return a.Detail.Cmd
	case models.ApprovalPlan:
		return "Approve the plan for " + a.Detail.Project
	default:
		return "Edit " + a.Detail.Path
	}
}

// autoCovers reports whether auto approve passes this approval without a click.
func (e *Engine) autoCovers(a models.Approval) bool {
	auto := e.settings.AutoApprove
	return auto.On && (auto.Scope == "all" || a.RiskLevel == models.RiskLow)
}

// RequestApproval pauses an agent until the user decides. Auto approve may decide at once.
// Call inside Do.
func (e *Engine) RequestApproval(agent *models.LiveAgent, approval models.Approval) {
	// An agent waits on one approval at a time, so an earlier one is no longer asked.
	e.CancelApproval(agent)
	approval.ID = newID("approval-")
	approval.Agent = agent.ID
	approval.Time = e.now().UnixMilli()
	agent.State = models.StateApproval
	agent.Approval = &approval
	e.record(e.store.SaveApproval(context.Background(), approval))
	summary := "Change " + approval.Detail.Path
	if approval.Type == models.ApprovalCommand {
		summary = approval.Detail.Cmd
	}
	e.AddEvent(agent, "approval", summary, nil)
	if e.autoCovers(approval) {
		e.decide(agent, models.DecisionAllowed, models.DecidedByAuto)
		return
	}
	e.Toast(agent.Name + " needs your approval")
}

// RequestApprovalQuietly attaches an approval that is already in the agent's history, as the demo
// office starts with one. It adds no feed entry and no toast. Call inside Do.
func (e *Engine) RequestApprovalQuietly(agent *models.LiveAgent, approval models.Approval) {
	approval.ID = newID("approval-")
	approval.Agent = agent.ID
	approval.Time = e.now().UnixMilli()
	agent.Approval = &approval
	e.Touch(agent)
	e.record(e.store.SaveApproval(context.Background(), approval))
}

// CancelApproval settles an agent's pending approval without a decision, when the agent stops or
// moves on. The agent is not told, and the activity log records it as cancelled. Call inside Do.
func (e *Engine) CancelApproval(agent *models.LiveAgent) {
	if agent.Approval == nil {
		return
	}
	approval := *agent.Approval
	decision, by := models.DecisionCancelled, models.DecidedByUser
	approval.Decision, approval.DecidedBy = &decision, &by
	e.Log(agent.Name, models.LogApproval, approvalSummary(approval), "Cancelled", "")
	agent.Approval = nil
	e.Touch(agent)
	e.record(e.store.SaveApproval(context.Background(), approval))
}

// Decide settles a pending approval. A repeated or unknown decision changes nothing and returns
// false. Call inside Do.
func (e *Engine) Decide(approvalID, decision string) bool {
	for _, agent := range e.agents {
		if agent.Approval != nil && agent.Approval.ID == approvalID {
			e.decide(agent, decision, models.DecidedByUser)
			return true
		}
	}
	return false
}

func (e *Engine) decide(agent *models.LiveAgent, decision, by string) {
	approval := *agent.Approval
	approval.Decision, approval.DecidedBy = &decision, &by
	summary := approvalSummary(approval)
	switch {
	case by == models.DecidedByAuto:
		e.Log(agent.Name, models.LogApproval, summary, "Auto-allowed", "ok")
		e.AddEvent(agent, "approval", "Auto-allowed (auto approve is on)", nil)
	case decision == models.DecisionAllowed:
		e.Log(agent.Name, models.LogApproval, summary, "Allowed", "ok")
		e.AddEvent(agent, "approval", "Allowed by you", nil)
	default:
		e.Log(agent.Name, models.LogApproval, summary, "Denied", "red")
		e.AddEvent(agent, "approval", "Denied by you", nil)
	}
	agent.Approval = nil
	e.Touch(agent)
	e.record(e.store.SaveApproval(context.Background(), approval))
	if connector, ok := e.connectors[agent.Source]; ok {
		connector.Decide(agent, approval)
	}
	if by == models.DecidedByAuto {
		e.Toast(agent.Name + ": " + summary + " was auto-approved")
	}
}

// Answerer is a connector whose agents can ask the person questions, and hear back.
type Answerer interface {
	// Answer passes checked answers to the agent's waiting session, and reports whether the
	// session was still there to hear them. Call inside Do.
	Answer(agent *models.LiveAgent, question models.Question, answers []models.QuestionAnswer) bool
}

// ErrNoQuestion is returned for an answer to a question the agent isn't asking: one already
// answered, one it gave up on, or one that was never asked.
var ErrNoQuestion = errors.New("this question was already answered or is no longer asked")

// Ask shows a question from the agent until the person answers it or the agent stops waiting.
// An agent asks one question at a time, so a newer one replaces the last. It returns the question
// with its id. Call inside Do.
func (e *Engine) Ask(agent *models.LiveAgent, question models.Question) models.Question {
	question.ID = newID("question-")
	question.Agent = agent.ID
	question.Time = e.now().UnixMilli()
	agent.Question = &question
	e.Touch(agent)
	e.AddEvent(agent, "question", "Asked you: "+models.Clip(models.QuestionSummary(&question), 160), nil)
	e.Toast(agent.Name + " is asking you a question")
	return question
}

// AnswerQuestion checks the person's answers to the question the agent is asking and passes them
// on. It answers only that agent's question with that id; anything else is ErrNoQuestion. Call
// inside Do.
func (e *Engine) AnswerQuestion(agentID, questionID string, answers []models.QuestionAnswer) error {
	agent := e.Agent(agentID)
	if agent == nil || agent.Question == nil || agent.Question.ID != questionID {
		return ErrNoQuestion
	}
	question := *agent.Question
	if err := models.CheckAnswers(&question, answers); err != nil {
		return err
	}
	answerer, ok := e.connectors[agent.Source].(Answerer)
	if !ok {
		return ErrNoQuestion
	}
	agent.Question = nil
	e.Touch(agent)
	// The session may have stopped waiting just now; then the answer reaches nobody.
	if !answerer.Answer(agent, question, answers) {
		return ErrNoQuestion
	}
	e.Log(agent.Name, models.LogInstruction, "Answered: "+models.Clip(models.QuestionSummary(&question), 160), "Answered", "ok")
	e.AddEvent(agent, "question", "You answered in Mabari", nil)
	return nil
}

// DropQuestion takes the agent's question down when its session stops waiting for an answer.
// A newer question stays. Call inside Do.
func (e *Engine) DropQuestion(agent *models.LiveAgent, questionID string) bool {
	if agent.Question == nil || agent.Question.ID != questionID {
		return false
	}
	agent.Question = nil
	e.Touch(agent)
	return true
}

// SetAutoApprove turns auto approve on or off and records it. Turning it on also settles any
// waiting approvals it covers, and returns how many. Call inside Do.
func (e *Engine) SetAutoApprove(on bool, scope string) int {
	settings := e.settings
	settings.AutoApprove = models.AutoApprove{On: on, Scope: scope}
	e.SaveSettings(settings)
	if !on {
		e.Log("Everyone", models.LogApproval, "Turned off auto approve", "Off", "")
		e.Toast("Auto approve is off. Agents will ask again.")
		return 0
	}
	label := "low risk only"
	if scope == "all" {
		label = "everything"
	}
	e.Log("Everyone", models.LogApproval, "Turned on auto approve ("+label+")", "On", "amber")
	settled := 0
	for _, agent := range e.agents {
		if agent.Approval != nil && e.autoCovers(*agent.Approval) {
			e.decide(agent, models.DecisionAllowed, models.DecidedByAuto)
			settled++
		}
	}
	notice := "Auto approve is on"
	if settled == 1 {
		notice += ". 1 waiting approval was approved"
	} else if settled > 1 {
		notice += ". " + strconv.Itoa(settled) + " waiting approvals were approved"
	}
	e.Toast(notice)
	return settled
}

// SetReply gives an agent a reply bubble. Call inside Do.
func (e *Engine) SetReply(agent *models.LiveAgent, text string, milliseconds int64) {
	agent.Reply, agent.ReplyUntil = text, e.now().UnixMilli()+milliseconds
	e.Touch(agent)
}

// SetFirstRun records whether Mabari is still on its first run. Call inside Do.
func (e *Engine) SetFirstRun(firstRun bool) {
	e.firstRun = firstRun
	value := "1"
	if !firstRun {
		value = "0"
	}
	e.record(e.store.SetMeta(context.Background(), store.MetaFirstRun, value))
}

// SetDemoEnds says when the demo turns itself off, or zero. Call inside Do.
func (e *Engine) SetDemoEnds(at int64) { e.demoEndsAt = at }

// SetMeta stores a connector's own value, which outlives a restart. Call inside Do.
func (e *Engine) SetMeta(key, value string) {
	e.record(e.store.SetMeta(context.Background(), key, value))
	if key == store.MetaDemo {
		e.demo = value == "1"
	}
}

// Project finds a project by id, or returns nil. Call inside Do.
func (e *Engine) Project(id string) *models.Project {
	for _, project := range e.projects {
		if project.ID == id {
			return project
		}
	}
	return nil
}

// SaveProject inserts or updates a project. Call inside Do.
func (e *Engine) SaveProject(project models.Project) models.Project {
	if project.ID == "" {
		project.ID = newID("project-")
	}
	if project.CreatedAt == 0 {
		project.CreatedAt = e.now().UnixMilli()
	}
	if project.Files == nil {
		project.Files = []string{}
	}
	if project.Opening == nil {
		project.Opening = []models.Instruction{}
	}
	if existing := e.Project(project.ID); existing != nil {
		*existing = project
	} else {
		copied := project
		e.projects = append(e.projects, &copied)
	}
	e.refreshProjects(e.now(), false)
	saved := *e.Project(project.ID)
	e.record(e.store.SaveProject(context.Background(), saved))
	e.broadcast(models.ServerMessage{Type: models.MsgProject, Project: &saved})
	return saved
}

// CompleteProject marks a project as done and records its summary. Call inside Do.
func (e *Engine) CompleteProject(project models.Project) models.Project {
	now := e.now().UnixMilli()
	done := models.ProjectDone{At: now, Mins: 1, Tasks: []string{}}
	for _, agent := range e.agents {
		if agent.Project == nil || *agent.Project != project.ID {
			continue
		}
		agent.Refresh(e.now())
		done.Agents++
		done.Cost += agent.Cost
		done.Mins = max(done.Mins, int((now-agent.CreatedAt)/60000))
		if agent.Progress >= 1 || agent.State == models.StateDone {
			done.Tasks = append(done.Tasks, agent.Task)
		}
	}
	project.Done = &done
	saved := e.SaveProject(project)
	e.Log("You", models.LogSession, "Marked "+project.Name+" as complete", "Completed", "ok")
	e.Toast(project.Name + " is marked as complete")
	return saved
}

// ReopenProject clears a project's completion. Call inside Do.
func (e *Engine) ReopenProject(project models.Project) models.Project {
	project.Done = nil
	saved := e.SaveProject(project)
	e.Toast(project.Name + " is open again")
	return saved
}

// RemoveProject deletes a project. Its agents stay, with no project. Call inside Do.
func (e *Engine) RemoveProject(id string) {
	for index, project := range e.projects {
		if project.ID == id {
			e.projects = append(e.projects[:index:index], e.projects[index+1:]...)
			break
		}
	}
	for _, agent := range e.agents {
		if agent.Project != nil && *agent.Project == id {
			agent.Project = nil
			e.Touch(agent)
		}
	}
	e.record(e.store.DeleteProject(context.Background(), id))
	e.broadcast(models.ServerMessage{Type: models.MsgRemove, ID: id})
}

// SetAccount updates a connection. Call inside Do.
func (e *Engine) SetAccount(account models.Account) {
	copied := account
	// What the office works out about an account is never stored, so it can't go stale.
	copied.Demo, copied.CanStart, copied.StartNote, copied.Missing = false, false, "", ""
	e.accounts[account.Kind] = &copied
	e.record(e.store.SaveAccount(context.Background(), copied))
	shown := e.shownAccount(copied)
	e.broadcast(models.ServerMessage{Type: models.MsgAccount, Account: &shown})
}

func (e *Engine) accountList() []models.Account {
	accounts := make([]models.Account, 0, len(models.AccountKinds))
	for _, kind := range models.AccountKinds {
		accounts = append(accounts, e.shownAccount(*e.accounts[kind]))
	}
	return accounts
}

// shownAccount is an account as the office sees it. While the demo runs, Codex and Claude Code
// look connected so the demo's agents make sense; that is never stored, so the real state of each
// connection is untouched and is what shows again when the demo ends.
func (e *Engine) shownAccount(account models.Account) models.Account {
	if e.demo && account.Status != models.AccountConnected {
		switch account.Kind {
		case models.AccountCodex:
			email := models.DemoEmail
			account.Status, account.Email, account.Demo = models.AccountConnected, &email, true
		case models.AccountClaudeCode:
			at := e.now().UnixMilli()
			account.Status, account.LastEventAt, account.Demo = models.AccountConnected, &at, true
		}
	}
	if e.accountNotes != nil {
		account = e.accountNotes(account, e.demo)
	}
	return account
}

// SetAccountNotes sets how each account is described beyond what is stored: whether an agent can be
// started on it, and what it is missing. The server sets it once, before it serves. The function
// is given an account as the office shows it and must not call the engine.
func (e *Engine) SetAccountNotes(notes func(account models.Account, demo bool) models.Account) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.accountNotes = notes
}

// Accounts lists every connection, in page order, as the office shows them. Call inside Do.
func (e *Engine) Accounts() []models.Account { return e.accountList() }

// StoredAccounts lists every connection as it really is, never as the demo shows it. Anything that
// changes an account starts from these. Call inside Do.
func (e *Engine) StoredAccounts() []models.Account {
	accounts := make([]models.Account, 0, len(models.AccountKinds))
	for _, kind := range models.AccountKinds {
		accounts = append(accounts, *e.accounts[kind])
	}
	return accounts
}

// ClearOffice empties agents, projects and history, keeping settings and accounts. Call inside Do.
func (e *Engine) ClearOffice() {
	e.record(e.store.ClearOffice(context.Background()))
	accounts := e.accounts
	e.resetMemory()
	e.accounts = accounts
}

// Wipe removes everything Mabari stores and returns to first run, with no projects, as on a fresh
// install. Preferences stay, as in the prototype, except auto approve, which is turned off so
// nothing is approved without a click after a wipe, and LAN access, so the network is closed until
// someone opens it again. Asking for the key on a shared computer stays on. Restoring settings backups joins this in
// Stage 7. Call inside Do.
func (e *Engine) Wipe() {
	for _, connector := range e.connectors {
		connector.Stop()
	}
	settings := e.settings.Clone()
	settings.AutoApprove.On = false
	settings.LANAccess = false
	e.record(e.store.Wipe(context.Background()))
	e.resetMemory()
	e.settings = settings
	e.record(e.store.SaveSettings(context.Background(), settings))
	e.firstRun, e.demo = true, false
	e.Reset()
}

// Dismiss sends an agent out of the office: after `after` milliseconds it walks to the door,
// and WalkOut later it is removed. An earlier dismissal stands. Call inside Do.
func (e *Engine) Dismiss(agent *models.LiveAgent, after int64) {
	if agent.LeavesAt != 0 || agent.Leaving {
		return
	}
	agent.LeavesAt = e.now().UnixMilli() + after
	e.Touch(agent)
}

// lastHeard is when an agent last did something: its newest step, or when it arrived.
func lastHeard(agent *models.LiveAgent) int64 {
	if len(agent.Feed) > 0 {
		return max(agent.Feed[0].Time, agent.CreatedAt)
	}
	return agent.CreatedAt
}

// dismissals walks dismissed agents out and removes them once they're gone, and dismisses
// subagents that went quiet without a word that they finished: subagents never stay for good.
// One waiting on an approval or an answer stays until someone decides. Call inside Do.
func (e *Engine) dismissals(now int64) {
	for _, agent := range slices.Clone(e.agents) {
		if agent.Lead != nil && agent.LeavesAt == 0 && agent.State != models.StateApproval &&
			!agent.Asking() && now-lastHeard(agent) > models.SubagentStale {
			e.Dismiss(agent, 0)
		}
		if agent.LeavesAt == 0 || now < agent.LeavesAt {
			continue
		}
		if agent.Leaving {
			e.RemoveAgent(agent.ID)
			continue
		}
		agent.Leaving, agent.LeavesAt = true, now+models.WalkOut
		e.Touch(agent)
	}
}

// RecentLog is the newest activity log rows, newest first, as copies. Call inside Do.
func (e *Engine) RecentLog(limit int) []models.LogEntry {
	return append([]models.LogEntry{}, e.log[:min(limit, len(e.log))]...)
}

// Sweep clears speech bubbles that have run out, on agents nothing else is changing, prompts
// that waited too long for a Claude Code session, and agents whose time to leave has come. Call
// inside Do.
func (e *Engine) Sweep() {
	now := e.now().UnixMilli()
	e.pruneOpenings(now)
	e.dismissals(now)
	for _, agent := range e.agents {
		if agent.Reply != "" && agent.ReplyUntil <= now {
			agent.Reply = ""
			e.Touch(agent)
		}
		if agent.Talk != "" && agent.TalkUntil <= now {
			agent.Talk = ""
			e.Touch(agent)
		}
	}
}

// RunRetention deletes tool calls and log entries older than the retention setting.
func (e *Engine) RunRetention(ctx context.Context) error {
	return e.Do(func() {
		cutoff := e.now().AddDate(0, 0, -e.settings.RetentionDays).UnixMilli()
		events, log, err := e.store.DeleteOlderThan(ctx, cutoff)
		e.record(err)
		if events+log > 0 {
			slog.Info("retention removed old data", "events", events, "log", log)
			kept := e.log[:0:0]
			for _, entry := range e.log {
				if entry.Time >= cutoff {
					kept = append(kept, entry)
				}
			}
			e.log = kept
		}
		// Feeds in memory hold the same events, so they lose the old ones too.
		trimmed := false
		for _, agent := range e.agents {
			feed := agent.Feed[:0:0]
			for _, event := range agent.Feed {
				if event.Time >= cutoff {
					feed = append(feed, event)
				}
			}
			if len(feed) != len(agent.Feed) {
				agent.Feed = feed
				e.Touch(agent)
				trimmed = true
			}
		}
		// Open pages reload, so removed log rows disappear there too.
		if events+log > 0 || trimmed {
			e.Resync()
		}
	})
}

// Run does housekeeping until ctx ends: bubbles every second and retention every hour.
func (e *Engine) Run(ctx context.Context) {
	if err := e.RunRetention(ctx); err != nil {
		slog.Error("retention failed", "error", err)
	}
	second := time.NewTicker(time.Second)
	defer second.Stop()
	hour := time.NewTicker(time.Hour)
	defer hour.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-second.C:
			if err := e.Do(e.Sweep); err != nil {
				slog.Error("could not save bubbles", "error", err)
			}
		case <-hour.C:
			if err := e.RunRetention(ctx); err != nil {
				slog.Error("retention failed", "error", err)
			}
		}
	}
}

// Snapshot is the whole office now. Agents' feeds and projects' estimates are included.
func (e *Engine) Snapshot() models.Snapshot {
	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.now()
	e.refreshProjects(now, false)
	agents := make([]models.LiveAgent, 0, len(e.agents))
	for _, agent := range e.agents {
		agent.Refresh(now)
	}
	for _, agent := range e.agents {
		e.refreshTeam(agent)
		agents = append(agents, *agent)
	}
	projects := make([]models.Project, 0, len(e.projects))
	for _, project := range e.projects {
		projects = append(projects, *project)
	}
	return models.Snapshot{
		BootID:     e.bootID,
		Seq:        e.seq,
		FirstRun:   e.firstRun,
		Demo:       e.demo,
		DemoEndsAt: e.demoEndsAt,
		Projects:   projects,
		Accounts:   e.accountList(),
		Agents:     agents,
		Messages:   append([]models.Message{}, e.messages...),
		Log:        append([]models.LogEntry{}, e.log...),
		Settings:   e.settings.Clone(),
		Defs:       append([]models.AgentDef{}, e.defs...),
	}
}

// SetDefs replaces the agent definitions and tells every page. Call inside Do.
func (e *Engine) SetDefs(defs []models.AgentDef) {
	e.defs = append([]models.AgentDef{}, defs...)
	e.broadcast(models.ServerMessage{Type: models.MsgDefs, Defs: e.Defs()})
}

// Defs are the agent definitions. Call inside Do.
func (e *Engine) Defs() []models.AgentDef { return append([]models.AgentDef{}, e.defs...) }

// Store is the database, for reads that need more than the live office holds.
func (e *Engine) Store() *store.Store { return e.store }
