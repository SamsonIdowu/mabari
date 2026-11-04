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
	"strconv"
	"strings"
	"sync"
	"time"

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
	messages   []models.Message
	log        []models.LogEntry
	dirty      map[string]struct{}
	eventNext  map[string]int
	connectors map[string]Connector
	writeErr   error
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
	return e.loadAgents(ctx)
}

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
		for _, approval := range pending {
			if approval.Agent == agent.ID {
				copied := approval
				agent.Approval = &copied
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
func (e *Engine) Settings() models.Settings { return e.settings }

// SaveSettings stores new settings. Call inside Do.
func (e *Engine) SaveSettings(settings models.Settings) {
	e.settings = settings
	e.record(e.store.SaveSettings(context.Background(), settings))
	e.broadcast(models.ServerMessage{Type: models.MsgSettings, Settings: &settings})
}

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

// RemoveAgent takes an agent out of the office. Call inside Do.
func (e *Engine) RemoveAgent(id string) {
	for index, agent := range e.agents {
		if agent.ID == id {
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
	e.broadcast(models.ServerMessage{Type: models.MsgToast, Text: text})
}

// Reset tells clients that too much changed to patch, so they reload the snapshot. Call inside Do.
func (e *Engine) Reset() { e.broadcast(models.ServerMessage{Type: models.MsgReset}) }

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
	return instruction, true
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

// SetFirstRun records whether Mabari is still on its first run. Call inside Do.
func (e *Engine) SetFirstRun(firstRun bool) {
	e.firstRun = firstRun
	value := "1"
	if !firstRun {
		value = "0"
	}
	e.record(e.store.SetMeta(context.Background(), store.MetaFirstRun, value))
}

// SetMeta stores a connector's own value. Call inside Do.
func (e *Engine) SetMeta(key, value string) {
	e.record(e.store.SetMeta(context.Background(), key, value))
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
	e.accounts[account.Kind] = &copied
	e.record(e.store.SaveAccount(context.Background(), copied))
	e.broadcast(models.ServerMessage{Type: models.MsgAccount, Account: &copied})
}

func (e *Engine) accountList() []models.Account {
	accounts := make([]models.Account, 0, len(models.AccountKinds))
	for _, kind := range models.AccountKinds {
		accounts = append(accounts, *e.accounts[kind])
	}
	return accounts
}

// Accounts lists every connection, in page order. Call inside Do.
func (e *Engine) Accounts() []models.Account { return e.accountList() }

// ClearOffice empties agents, projects and history, keeping settings and accounts. Call inside Do.
func (e *Engine) ClearOffice() {
	e.record(e.store.ClearOffice(context.Background()))
	accounts := e.accounts
	e.resetMemory()
	e.accounts = accounts
}

// Wipe removes everything Mabari stores and returns to first run. Restoring settings backups joins
// this in Stage 7. Call inside Do.
func (e *Engine) Wipe() {
	for _, connector := range e.connectors {
		connector.Stop()
	}
	e.record(e.store.Wipe(context.Background()))
	e.resetMemory()
	e.settings = models.DefaultSettings()
	e.firstRun = true
	e.Reset()
}

// Sweep clears speech bubbles that have run out, on agents nothing else is changing. Call inside Do.
func (e *Engine) Sweep() {
	now := e.now().UnixMilli()
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
		BootID:   e.bootID,
		Seq:      e.seq,
		FirstRun: e.firstRun,
		Projects: projects,
		Accounts: e.accountList(),
		Agents:   agents,
		Messages: append([]models.Message{}, e.messages...),
		Log:      append([]models.LogEntry{}, e.log...),
		Settings: e.settings,
	}
}

// Store is the database, for reads that need more than the live office holds.
func (e *Engine) Store() *store.Store { return e.store }
