// SPDX-License-Identifier: Apache-2.0

package store

import (
	"context"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// MetaAlive is the last time the server was known to be running, in Unix milliseconds. It tells
// the timeline how long a gap was when Mabari stopped and started again.
const MetaAlive = "alive_at"

// AddStateChange records the moment an agent's phase changed.
func (s *Store) AddStateChange(ctx context.Context, c models.StateChange) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO state_changes (agent_id, agent, at, phase)
		VALUES (?, ?, ?, ?)`, c.AgentID, c.Agent, c.Time, c.Phase)
	return err
}

func (s *Store) stateChanges(ctx context.Context, query string, args ...any) ([]models.StateChange, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	changes := []models.StateChange{}
	for rows.Next() {
		var c models.StateChange
		if err := rows.Scan(&c.AgentID, &c.Agent, &c.Time, &c.Phase); err != nil {
			return nil, err
		}
		changes = append(changes, c)
	}
	return changes, rows.Err()
}

// StateChanges lists the changes from `from` up to, not including, `to`, oldest first.
func (s *Store) StateChanges(ctx context.Context, from, to int64) ([]models.StateChange, error) {
	return s.stateChanges(ctx, `SELECT agent_id, agent, at, phase FROM state_changes
		WHERE at >= ? AND at < ? ORDER BY at, id`, from, to)
}

// StateBefore lists, for each agent, its last change before `before`: what it was doing when
// that moment came.
func (s *Store) StateBefore(ctx context.Context, before int64) ([]models.StateChange, error) {
	return s.stateChanges(ctx, `SELECT agent_id, agent, at, phase FROM state_changes c
		WHERE at < ? AND id = (SELECT id FROM state_changes WHERE agent_id = c.agent_id AND at < ?
			ORDER BY at DESC, id DESC LIMIT 1) ORDER BY at, id`, before, before)
}

// LastStateChanges is each agent's latest change, by agent id.
func (s *Store) LastStateChanges(ctx context.Context) (map[string]models.StateChange, error) {
	changes, err := s.stateChanges(ctx, `SELECT agent_id, agent, at, phase FROM state_changes c
		WHERE id = (SELECT id FROM state_changes WHERE agent_id = c.agent_id
			ORDER BY at DESC, id DESC LIMIT 1)`)
	if err != nil {
		return nil, err
	}
	last := make(map[string]models.StateChange, len(changes))
	for _, change := range changes {
		last[change.AgentID] = change
	}
	return last, nil
}

// deleteStateChangesBefore removes changes from before cutoff, except each agent's latest, so an
// agent that has stayed in one phase for longer than the retention is still known to be in it.
func (s *Store) deleteStateChangesBefore(ctx context.Context, cutoff int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM state_changes WHERE at < ?
		AND id NOT IN (SELECT MAX(id) FROM state_changes GROUP BY agent_id)`, cutoff)
	return err
}

// ApprovalsBetween lists the approvals asked for from `from` up to, not including, `to`, oldest
// first.
func (s *Store) ApprovalsBetween(ctx context.Context, from, to int64) ([]models.Approval, error) {
	return list[models.Approval](ctx, s, `SELECT data FROM approvals
		WHERE at >= ? AND at < ? ORDER BY at, rowid`, from, to)
}

// InstructionsBetween lists the instructions sent to an agent from `from` up to, not including,
// `to`, oldest first. One taken back before it was delivered is left out, and so is a prompt for a
// project that no agent has taken.
func (s *Store) InstructionsBetween(ctx context.Context, from, to int64) ([]models.Instruction, error) {
	return list[models.Instruction](ctx, s, `SELECT data FROM instructions
		WHERE agent_id IS NOT NULL AND agent_id != '' AND status != ? AND at >= ? AND at < ?
		ORDER BY at, rowid`, models.InstructionRemoved, from, to)
}
