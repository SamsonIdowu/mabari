-- SPDX-License-Identifier: Apache-2.0
-- Each time an agent starts or stops working, waits on the person, or errors, so the day's
-- timeline can be drawn from what happened rather than guessed.
CREATE TABLE state_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  at INTEGER NOT NULL,
  phase TEXT NOT NULL
);
CREATE INDEX state_changes_by_agent ON state_changes (agent_id, at);
CREATE INDEX state_changes_by_time ON state_changes (at);
