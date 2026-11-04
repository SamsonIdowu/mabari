/** Applied in order. `PRAGMA user_version` records how many have run, so never edit old entries. */
export const migrations: string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    files TEXT NOT NULL DEFAULT '[]',
    repository TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'off',
    email TEXT,
    models TEXT NOT NULL DEFAULT '[]',
    last_event_at INTEGER
  );

  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    account TEXT NOT NULL,
    source TEXT NOT NULL,
    lead_id TEXT,
    sub_model TEXT NOT NULL DEFAULT 'inherit',
    desk INTEGER NOT NULL,
    folder TEXT NOT NULL,
    allowed_tools TEXT NOT NULL DEFAULT '[]',
    daily_cost_cap REAL,
    hue TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE session_states (
    agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    task TEXT NOT NULL,
    progress REAL NOT NULL,
    rate REAL NOT NULL,
    elapsed INTEGER NOT NULL,
    tokens_in INTEGER NOT NULL,
    tokens_out INTEGER NOT NULL,
    error TEXT NOT NULL DEFAULT '',
    files TEXT NOT NULL DEFAULT '[]',
    bubble TEXT NOT NULL DEFAULT '',
    reply TEXT NOT NULL DEFAULT '',
    reply_until INTEGER NOT NULL DEFAULT 0,
    talk TEXT NOT NULL DEFAULT '',
    talk_until INTEGER NOT NULL DEFAULT 0,
    talk_color TEXT NOT NULL DEFAULT '',
    leaving INTEGER NOT NULL DEFAULT 0
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
    from_id TEXT NOT NULL,
    to_ids TEXT NOT NULL,
    from_name TEXT NOT NULL,
    to_name TEXT NOT NULL,
    project_id TEXT,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX messages_by_time ON messages (at);

  CREATE TABLE instructions (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    text TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    at INTEGER NOT NULL,
    log_id TEXT
  );
  CREATE INDEX instructions_waiting ON instructions (agent_id, status);

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    risk TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    decision TEXT,
    decided_by TEXT,
    at INTEGER NOT NULL
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
  `,
];
