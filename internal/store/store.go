// SPDX-License-Identifier: Apache-2.0

// Package store keeps Mabari's data in a single SQLite file.
package store

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/models"
	_ "modernc.org/sqlite" // Pure Go driver, so CGO_ENABLED=0 builds work everywhere.
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// Meta keys.
const (
	MetaSettings = "app"
	MetaFirstRun = "first_run"
	MetaDemo     = "demo_active"
)

// Store is the database. One connection means one writer, so writes never contend.
type Store struct {
	db *sql.DB
}

// Open opens the database at path and brings it up to date. Pass ":memory:" for a throwaway one.
func Open(ctx context.Context, path string) (*Store, error) {
	dsn := ":memory:"
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, fmt.Errorf("create data folder: %w", err)
		}
		dsn = "file:" + path
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	for _, pragma := range []string{
		"PRAGMA journal_mode = WAL", "PRAGMA foreign_keys = ON", "PRAGMA busy_timeout = 5000",
	} {
		if _, err := db.ExecContext(ctx, pragma); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("configure database: %w", err)
		}
	}
	if err := s.migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	if path != ":memory:" {
		if err := os.Chmod(path, 0o600); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("protect database: %w", err)
		}
	}
	return s, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate(ctx context.Context) error {
	entries, err := fs.ReadDir(migrationFiles, "migrations")
	if err != nil {
		return err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })

	var applied int
	if err := s.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&applied); err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	for index := applied; index < len(entries); index++ {
		script, err := migrationFiles.ReadFile("migrations/" + entries[index].Name())
		if err != nil {
			return err
		}
		err = s.Transaction(ctx, func() error {
			if _, err := s.db.ExecContext(ctx, string(script)); err != nil {
				return err
			}
			_, err := s.db.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", index+1))
			return err
		})
		if err != nil {
			return fmt.Errorf("migration %s: %w", entries[index].Name(), err)
		}
	}
	return nil
}

// SchemaVersion is how many migrations have run.
func (s *Store) SchemaVersion(ctx context.Context) (int, error) {
	var version int
	err := s.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version)
	return version, err
}

// Transaction runs work in one transaction, so a batch of writes lands together.
func (s *Store) Transaction(ctx context.Context, work func() error) error {
	if _, err := s.db.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	if err := work(); err != nil {
		_, rollback := s.db.ExecContext(ctx, "ROLLBACK")
		return errors.Join(err, rollback)
	}
	_, err := s.db.ExecContext(ctx, "COMMIT")
	return err
}

func encode(value any) (string, error) {
	data, err := json.Marshal(value)
	return string(data), err
}

func list[T any](ctx context.Context, s *Store, query string, args ...any) ([]T, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	items := []T{}
	for rows.Next() {
		var data string
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
		var item T
		if err := json.Unmarshal([]byte(data), &item); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// SaveProject inserts or updates a project.
func (s *Store) SaveProject(ctx context.Context, p models.Project) error {
	data, err := encode(p)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO projects (id, created_at, data) VALUES (?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET data = excluded.data`, p.ID, p.CreatedAt, data)
	return err
}

// DeleteProject removes a project.
func (s *Store) DeleteProject(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM projects WHERE id = ?", id)
	return err
}

// Projects lists projects, oldest first.
func (s *Store) Projects(ctx context.Context) ([]models.Project, error) {
	return list[models.Project](ctx, s, "SELECT data FROM projects ORDER BY created_at, rowid")
}

// SaveAccount inserts or updates an account.
func (s *Store) SaveAccount(ctx context.Context, a models.Account) error {
	data, err := encode(a)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO accounts (kind, data) VALUES (?, ?)
		ON CONFLICT(kind) DO UPDATE SET data = excluded.data`, a.Kind, data)
	return err
}

// Accounts lists saved accounts.
func (s *Store) Accounts(ctx context.Context) ([]models.Account, error) {
	return list[models.Account](ctx, s, "SELECT data FROM accounts")
}

// SaveAgent writes an agent's identity and session.
func (s *Store) SaveAgent(ctx context.Context, a models.LiveAgent) error {
	identity, err := encode(a.Agent)
	if err != nil {
		return err
	}
	session, err := encode(a.SessionState)
	if err != nil {
		return err
	}
	if _, err = s.db.ExecContext(ctx, `INSERT INTO agents (id, project_id, created_at, data)
		VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE
		SET project_id = excluded.project_id, data = excluded.data`,
		a.ID, a.Project, a.CreatedAt, identity); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO session_states (agent_id, state, data)
		VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE
		SET state = excluded.state, data = excluded.data`, a.ID, a.State, session)
	return err
}

// DeleteAgent removes an agent. Its events stay until retention removes them.
func (s *Store) DeleteAgent(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM agents WHERE id = ?", id)
	return err
}

// Agents lists agents with their sessions, oldest first. Feed, Queued and Approval are not set.
func (s *Store) Agents(ctx context.Context) ([]models.LiveAgent, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT a.data, st.data FROM agents a
		JOIN session_states st ON st.agent_id = a.id ORDER BY a.created_at, a.rowid`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	agents := []models.LiveAgent{}
	for rows.Next() {
		var identity, session string
		if err := rows.Scan(&identity, &session); err != nil {
			return nil, err
		}
		var agent models.LiveAgent
		if err := json.Unmarshal([]byte(identity), &agent.Agent); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(session), &agent.SessionState); err != nil {
			return nil, err
		}
		agents = append(agents, agent)
	}
	return agents, rows.Err()
}

// AddEvent records an event.
func (s *Store) AddEvent(ctx context.Context, e models.Event) error {
	var raw any
	if e.Raw != nil {
		encoded, err := encode(e.Raw)
		if err != nil {
			return err
		}
		raw = encoded
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO events (id, agent_id, at, tool, summary, raw)
		VALUES (?, ?, ?, ?, ?, ?)`, e.ID, e.Agent, e.Time, e.Tool, e.Summary, raw)
	return err
}

// Events lists an agent's events, newest first. `before` pages back; 0 starts from the newest.
func (s *Store) Events(ctx context.Context, agentID string, limit int, before int64) ([]models.Event, error) {
	query := `SELECT id, agent_id, at, tool, summary, raw FROM events WHERE agent_id = ?`
	args := []any{agentID}
	if before > 0 {
		query += " AND at < ?"
		args = append(args, before)
	}
	rows, err := s.db.QueryContext(ctx, query+" ORDER BY at DESC, rowid DESC LIMIT ?",
		append(args, limit)...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	events := []models.Event{}
	for rows.Next() {
		var event models.Event
		var raw sql.NullString
		if err := rows.Scan(&event.ID, &event.Agent, &event.Time, &event.Tool, &event.Summary,
			&raw); err != nil {
			return nil, err
		}
		if raw.Valid {
			if err := json.Unmarshal([]byte(raw.String), &event.Raw); err != nil {
				return nil, err
			}
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

// EventIDs lists every event id, so numbering can carry on after a restart.
func (s *Store) EventIDs(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT id FROM events")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// AddMessage records a message.
func (s *Store) AddMessage(ctx context.Context, m models.Message) error {
	data, err := encode(m)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, "INSERT INTO messages (id, at, data) VALUES (?, ?, ?)",
		m.ID, m.Time, data)
	return err
}

// Messages lists the newest messages, oldest first, as the Conversations page reads them.
func (s *Store) Messages(ctx context.Context, limit int) ([]models.Message, error) {
	items, err := list[models.Message](ctx, s,
		"SELECT data FROM messages ORDER BY at DESC, rowid DESC LIMIT ?", limit)
	if err != nil {
		return nil, err
	}
	for i, j := 0, len(items)-1; i < j; i, j = i+1, j-1 {
		items[i], items[j] = items[j], items[i]
	}
	return items, nil
}

// SaveInstruction inserts or updates an instruction.
func (s *Store) SaveInstruction(ctx context.Context, i models.Instruction) error {
	data, err := encode(i)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO instructions (id, agent_id, status, at, data)
		VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE
		SET status = excluded.status, data = excluded.data`,
		i.ID, i.Agent, i.Status, i.Time, data)
	return err
}

// WaitingInstructions lists instructions waiting for the agent's next checkpoint, oldest first.
func (s *Store) WaitingInstructions(ctx context.Context, agentID string) ([]models.Instruction, error) {
	return list[models.Instruction](ctx, s, `SELECT data FROM instructions
		WHERE agent_id = ? AND status = ? ORDER BY at, rowid`, agentID, models.InstructionWaiting)
}

// SaveApproval inserts or updates an approval.
func (s *Store) SaveApproval(ctx context.Context, a models.Approval) error {
	data, err := encode(a)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO approvals (id, agent_id, decision, at, data)
		VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE
		SET decision = excluded.decision, data = excluded.data`,
		a.ID, a.Agent, a.Decision, a.Time, data)
	return err
}

// Approvals lists approvals, newest first.
func (s *Store) Approvals(ctx context.Context, pendingOnly bool) ([]models.Approval, error) {
	where := ""
	if pendingOnly {
		where = "WHERE decision IS NULL"
	}
	return list[models.Approval](ctx, s,
		"SELECT data FROM approvals "+where+" ORDER BY at DESC, rowid DESC")
}

// SaveLog inserts or updates an activity log row.
func (s *Store) SaveLog(ctx context.Context, e models.LogEntry) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO activity_log
		(id, at, agent, type, message, outcome, chip) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET outcome = excluded.outcome, chip = excluded.chip`,
		e.ID, e.Time, e.Agent, e.Type, e.Message, e.Outcome, e.Chip)
	return err
}

// LogQuery filters the activity log.
type LogQuery struct {
	Search string
	Type   models.LogType
	Limit  int
}

// Log lists activity, newest first.
func (s *Store) Log(ctx context.Context, q LogQuery) ([]models.LogEntry, error) {
	var clauses []string
	var args []any
	if q.Type != "" {
		clauses = append(clauses, "type = ?")
		args = append(args, q.Type)
	}
	if q.Search != "" {
		escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q.Search)
		pattern := "%" + escaped + "%"
		clauses = append(clauses, `(agent LIKE ? ESCAPE '\' OR message LIKE ? ESCAPE '\'
			OR outcome LIKE ? ESCAPE '\')`)
		args = append(args, pattern, pattern, pattern)
	}
	query := "SELECT id, at, agent, type, message, outcome, chip FROM activity_log"
	if len(clauses) > 0 {
		query += " WHERE " + strings.Join(clauses, " AND ")
	}
	limit := q.Limit
	if limit <= 0 {
		limit = 500
	}
	rows, err := s.db.QueryContext(ctx, query+" ORDER BY at DESC, rowid DESC LIMIT ?",
		append(args, limit)...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	entries := []models.LogEntry{}
	for rows.Next() {
		var e models.LogEntry
		if err := rows.Scan(&e.ID, &e.Time, &e.Agent, &e.Type, &e.Message, &e.Outcome,
			&e.Chip); err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

// Meta reads a stored value. Missing keys return "".
func (s *Store) Meta(ctx context.Context, key string) (string, error) {
	var value string
	err := s.db.QueryRowContext(ctx, "SELECT value FROM settings WHERE key = ?", key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return value, err
}

// SetMeta stores a value.
func (s *Store) SetMeta(ctx context.Context, key, value string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO settings (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

// Settings reads the settings, filling anything unset from the defaults.
func (s *Store) Settings(ctx context.Context) (models.Settings, error) {
	settings := models.DefaultSettings()
	raw, err := s.Meta(ctx, MetaSettings)
	if err != nil || raw == "" {
		return settings, err
	}
	err = json.Unmarshal([]byte(raw), &settings)
	return settings, err
}

// SaveSettings stores the settings.
func (s *Store) SaveSettings(ctx context.Context, settings models.Settings) error {
	data, err := encode(settings)
	if err != nil {
		return err
	}
	return s.SetMeta(ctx, MetaSettings, data)
}

// DeleteOlderThan removes tool calls and log entries from before cutoff, in Unix milliseconds.
func (s *Store) DeleteOlderThan(ctx context.Context, cutoff int64) (events, log int64, err error) {
	result, err := s.db.ExecContext(ctx, "DELETE FROM events WHERE at < ?", cutoff)
	if err != nil {
		return 0, 0, err
	}
	if events, err = result.RowsAffected(); err != nil {
		return 0, 0, err
	}
	result, err = s.db.ExecContext(ctx, "DELETE FROM activity_log WHERE at < ?", cutoff)
	if err != nil {
		return 0, 0, err
	}
	log, err = result.RowsAffected()
	return events, log, err
}

// ClearOffice empties agents and everything hanging off them, keeping settings and accounts.
func (s *Store) ClearOffice(ctx context.Context) error {
	return s.clear(ctx, "session_states", "agents", "events", "messages", "instructions",
		"approvals", "activity_log", "projects")
}

// Wipe empties every table.
func (s *Store) Wipe(ctx context.Context) error {
	return s.clear(ctx, "session_states", "agents", "events", "messages", "instructions",
		"approvals", "activity_log", "projects", "accounts", "settings")
}

func (s *Store) clear(ctx context.Context, tables ...string) error {
	return s.Transaction(ctx, func() error {
		for _, table := range tables {
			// Table names come only from the fixed lists above.
			if _, err := s.db.ExecContext(ctx, "DELETE FROM "+table); err != nil { // #nosec G202
				return err
			}
		}
		return nil
	})
}
