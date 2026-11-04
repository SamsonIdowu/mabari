-- Most records are stored as JSON beside the columns that queries need.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE accounts (
  kind TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  created_at INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE session_states (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  tool TEXT NOT NULL,
  summary TEXT NOT NULL,
  raw TEXT
);
CREATE INDEX events_by_agent ON events (agent_id, at DESC);
CREATE INDEX events_by_time ON events (at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX messages_by_time ON messages (at);

CREATE TABLE instructions (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  status TEXT NOT NULL,
  at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX instructions_waiting ON instructions (agent_id, status);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  decision TEXT,
  at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX approvals_pending ON approvals (agent_id, decision);

CREATE TABLE activity_log (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  agent TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  outcome TEXT NOT NULL,
  chip TEXT NOT NULL DEFAULT ''
);
CREATE INDEX activity_by_time ON activity_log (at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
