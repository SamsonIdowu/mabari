-- SPDX-License-Identifier: Apache-2.0
-- Each agent's conversation with the person, in order. Items are stored as JSON like most records,
-- beside the columns that reading a page and keeping to the retention setting need.
CREATE TABLE conversation_items (
  agent_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (agent_id, seq)
);

CREATE UNIQUE INDEX conversation_items_by_id ON conversation_items (agent_id, item_id);
CREATE INDEX conversation_items_at ON conversation_items (at);
