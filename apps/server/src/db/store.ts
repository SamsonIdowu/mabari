import type {
  Account,
  AccountKind,
  Agent,
  AgentEvent,
  Approval,
  Instruction,
  LogEntry,
  LogType,
  Message,
  Project,
  SessionState,
  Settings,
} from '@mabari/shared';
import { DEFAULT_SETTINGS } from '@mabari/shared';
import type { Db } from './database.ts';

type Row = Record<string, unknown>;

const parse = <T>(value: unknown, fallback: T): T =>
  typeof value === 'string' ? (JSON.parse(value) as T) : fallback;

const toProject = (r: Row): Project => ({
  id: r.id as string,
  name: r.name as string,
  color: r.color as string,
  instructions: r.instructions as string,
  files: parse(r.files, []),
  repository: parse(r.repository, null),
  createdAt: r.created_at as number,
});

const toAccount = (r: Row): Account => ({
  id: r.id as string,
  kind: r.kind as AccountKind,
  status: r.status as Account['status'],
  email: r.email as string | null,
  models: parse(r.models, []),
  lastEventAt: r.last_event_at as number | null,
});

const toAgent = (r: Row): Agent & SessionState => ({
  id: r.id as string,
  projectId: r.project_id as string | null,
  name: r.name as string,
  provider: r.provider as Agent['provider'],
  model: r.model as string,
  account: r.account as AccountKind,
  source: r.source as Agent['source'],
  leadId: r.lead_id as string | null,
  subModel: r.sub_model as string,
  desk: r.desk as number,
  folder: r.folder as string,
  allowedTools: parse(r.allowed_tools, []),
  dailyCostCap: r.daily_cost_cap as number | null,
  hue: r.hue as string,
  createdAt: r.created_at as number,
  state: r.state as SessionState['state'],
  task: r.task as string,
  progress: r.progress as number,
  rate: r.rate as number,
  elapsed: r.elapsed as number,
  tokensIn: r.tokens_in as number,
  tokensOut: r.tokens_out as number,
  error: r.error as string,
  files: parse(r.files, []),
  bubble: r.bubble as string,
  reply: r.reply as string,
  replyUntil: r.reply_until as number,
  talk: r.talk as string,
  talkUntil: r.talk_until as number,
  talkColor: r.talk_color as string,
  leaving: r.leaving === 1,
});

const toEvent = (r: Row): AgentEvent => ({
  id: r.id as string,
  agentId: r.agent_id as string,
  at: r.at as number,
  tool: r.tool as string,
  summary: r.summary as string,
  raw: parse(r.raw, null),
});

const toMessage = (r: Row): Message => ({
  id: r.id as string,
  fromId: r.from_id as string,
  toIds: parse(r.to_ids, []),
  fromName: r.from_name as string,
  toName: r.to_name as string,
  projectId: r.project_id as string | null,
  kind: r.kind as Message['kind'],
  text: r.text as string,
  at: r.at as number,
});

const toInstruction = (r: Row): Instruction => ({
  id: r.id as string,
  agentId: r.agent_id as string | null,
  text: r.text as string,
  mode: r.mode as Instruction['mode'],
  status: r.status as Instruction['status'],
  at: r.at as number,
  logId: r.log_id as string | null,
});

const toApproval = (r: Row): Approval => ({
  id: r.id as string,
  agentId: r.agent_id as string,
  type: r.type as Approval['type'],
  title: r.title as string,
  detail: parse(r.detail, {}),
  risk: r.risk as string,
  riskLevel: r.risk_level as Approval['riskLevel'],
  decision: r.decision as Approval['decision'],
  decidedBy: r.decided_by as Approval['decidedBy'],
  at: r.at as number,
});

const toLog = (r: Row): LogEntry => ({
  id: r.id as string,
  at: r.at as number,
  agent: r.agent as string,
  type: r.type as LogType,
  message: r.message as string,
  outcome: r.outcome as string,
  chip: r.chip as LogEntry['chip'],
});

export interface LogQuery {
  q?: string;
  type?: LogType;
  limit?: number;
}

/** All SQL lives here, so the rest of the server deals only in shared types. */
export class Store {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  transaction(work: () => void): void {
    this.db.transaction(work)();
  }

  close(): void {
    this.db.close();
  }

  listProjects(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at, id').all() as Row[];
    return rows.map(toProject);
  }

  getProject(id: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return row && toProject(row);
  }

  saveProject(p: Project): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, color, instructions, files, repository, created_at)
         VALUES (@id, @name, @color, @instructions, @files, @repository, @createdAt)
         ON CONFLICT(id) DO UPDATE SET name = @name, color = @color,
           instructions = @instructions, files = @files, repository = @repository`,
      )
      .run({
        ...p,
        files: JSON.stringify(p.files),
        repository: p.repository && JSON.stringify(p.repository),
      });
  }

  deleteProject(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  listAccounts(): Account[] {
    const rows = this.db.prepare('SELECT * FROM accounts ORDER BY kind').all() as Row[];
    return rows.map(toAccount);
  }

  saveAccount(a: Account): void {
    this.db
      .prepare(
        `INSERT INTO accounts (id, kind, status, email, models, last_event_at)
         VALUES (@id, @kind, @status, @email, @models, @lastEventAt)
         ON CONFLICT(id) DO UPDATE SET status = @status, email = @email,
           models = @models, last_event_at = @lastEventAt`,
      )
      .run({ ...a, models: JSON.stringify(a.models) });
  }

  listAgents(): (Agent & SessionState)[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agents a JOIN session_states s ON s.agent_id = a.id
         ORDER BY a.created_at, a.id`,
      )
      .all() as Row[];
    return rows.map(toAgent);
  }

  saveAgent(a: Agent & SessionState): void {
    this.db
      .prepare(
        `INSERT INTO agents (id, project_id, name, provider, model, account, source, lead_id,
           sub_model, desk, folder, allowed_tools, daily_cost_cap, hue, created_at)
         VALUES (@id, @projectId, @name, @provider, @model, @account, @source, @leadId,
           @subModel, @desk, @folder, @allowedTools, @dailyCostCap, @hue, @createdAt)
         ON CONFLICT(id) DO UPDATE SET project_id = @projectId, name = @name, model = @model,
           lead_id = @leadId, sub_model = @subModel, desk = @desk, folder = @folder,
           allowed_tools = @allowedTools, daily_cost_cap = @dailyCostCap`,
      )
      .run({
        id: a.id,
        projectId: a.projectId,
        name: a.name,
        provider: a.provider,
        model: a.model,
        account: a.account,
        source: a.source,
        leadId: a.leadId,
        subModel: a.subModel,
        desk: a.desk,
        folder: a.folder,
        allowedTools: JSON.stringify(a.allowedTools),
        dailyCostCap: a.dailyCostCap,
        hue: a.hue,
        createdAt: a.createdAt,
      });
    this.db
      .prepare(
        `INSERT OR REPLACE INTO session_states (agent_id, state, task, progress, rate, elapsed,
           tokens_in, tokens_out, error, files, bubble, reply, reply_until, talk, talk_until,
           talk_color, leaving)
         VALUES (@id, @state, @task, @progress, @rate, @elapsed, @tokensIn, @tokensOut, @error,
           @files, @bubble, @reply, @replyUntil, @talk, @talkUntil, @talkColor, @leaving)`,
      )
      .run({
        id: a.id,
        state: a.state,
        task: a.task,
        progress: a.progress,
        rate: a.rate,
        elapsed: a.elapsed,
        tokensIn: a.tokensIn,
        tokensOut: a.tokensOut,
        error: a.error,
        files: JSON.stringify(a.files),
        bubble: a.bubble,
        reply: a.reply,
        replyUntil: a.replyUntil,
        talk: a.talk,
        talkUntil: a.talkUntil,
        talkColor: a.talkColor,
        leaving: a.leaving ? 1 : 0,
      });
  }

  deleteAgent(id: string): void {
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  }

  addEvent(e: AgentEvent): void {
    this.db
      .prepare(
        `INSERT INTO events (id, agent_id, at, tool, summary, raw)
         VALUES (@id, @agentId, @at, @tool, @summary, @raw)`,
      )
      .run({ ...e, raw: e.raw === null ? null : JSON.stringify(e.raw) });
  }

  recentEvents(agentId: string, limit: number): AgentEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE agent_id = ? ORDER BY at DESC, rowid DESC LIMIT ?')
      .all(agentId, limit) as Row[];
    return rows.map(toEvent);
  }

  countEventsFor(agentId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE agent_id = ?')
      .get(agentId) as { n: number };
    return row.n;
  }

  addMessage(m: Message): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, from_id, to_ids, from_name, to_name, project_id, kind, text, at)
         VALUES (@id, @fromId, @toIds, @fromName, @toName, @projectId, @kind, @text, @at)`,
      )
      .run({ ...m, toIds: JSON.stringify(m.toIds) });
  }

  /** Oldest first, as the Conversations page reads them. */
  recentMessages(limit: number): Message[] {
    const rows = this.db
      .prepare('SELECT * FROM messages ORDER BY at DESC, rowid DESC LIMIT ?')
      .all(limit) as Row[];
    return rows.map(toMessage).reverse();
  }

  saveInstruction(i: Instruction): void {
    this.db
      .prepare(
        `INSERT INTO instructions (id, agent_id, text, mode, status, at, log_id)
         VALUES (@id, @agentId, @text, @mode, @status, @at, @logId)
         ON CONFLICT(id) DO UPDATE SET status = @status`,
      )
      .run({ ...i });
  }

  waitingInstructions(agentId: string): Instruction[] {
    const rows = this.db
      .prepare(`SELECT * FROM instructions WHERE agent_id = ? AND status = 'waiting' ORDER BY at`)
      .all(agentId) as Row[];
    return rows.map(toInstruction);
  }

  saveApproval(a: Approval): void {
    this.db
      .prepare(
        `INSERT INTO approvals (id, agent_id, type, title, detail, risk, risk_level, decision,
           decided_by, at)
         VALUES (@id, @agentId, @type, @title, @detail, @risk, @riskLevel, @decision,
           @decidedBy, @at)
         ON CONFLICT(id) DO UPDATE SET decision = @decision, decided_by = @decidedBy`,
      )
      .run({ ...a, detail: JSON.stringify(a.detail) });
  }

  getApproval(id: string): Approval | undefined {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
    return row && toApproval(row);
  }

  listApprovals(pendingOnly: boolean): Approval[] {
    const where = pendingOnly ? 'WHERE decision IS NULL' : '';
    const rows = this.db
      .prepare(`SELECT * FROM approvals ${where} ORDER BY at DESC, rowid DESC`)
      .all() as Row[];
    return rows.map(toApproval);
  }

  pendingApproval(agentId: string): Approval | undefined {
    const row = this.db
      .prepare('SELECT * FROM approvals WHERE agent_id = ? AND decision IS NULL')
      .get(agentId) as Row | undefined;
    return row && toApproval(row);
  }

  saveLog(e: LogEntry): void {
    this.db
      .prepare(
        `INSERT INTO activity_log (id, at, agent, type, message, outcome, chip)
         VALUES (@id, @at, @agent, @type, @message, @outcome, @chip)
         ON CONFLICT(id) DO UPDATE SET outcome = @outcome, chip = @chip`,
      )
      .run({ ...e });
  }

  getLog(id: string): LogEntry | undefined {
    const row = this.db.prepare('SELECT * FROM activity_log WHERE id = ?').get(id) as
      | Row
      | undefined;
    return row && toLog(row);
  }

  /** Newest first. */
  searchLog({ q, type, limit = 500 }: LogQuery = {}): LogEntry[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit };
    if (type) {
      clauses.push('type = @type');
      params.type = type;
    }
    if (q) {
      clauses.push(
        `(agent LIKE @q ESCAPE '\\' OR message LIKE @q ESCAPE '\\' OR outcome LIKE @q ESCAPE '\\')`,
      );
      params.q = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM activity_log ${where} ORDER BY at DESC, rowid DESC LIMIT @limit`)
      .all(params) as Row[];
    return rows.map(toLog);
  }

  getSettings(): Settings {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'app'`).get() as
      | { value: string }
      | undefined;
    return { ...DEFAULT_SETTINGS, ...(row ? (JSON.parse(row.value) as Partial<Settings>) : {}) };
  }

  saveSettings(settings: Settings): void {
    this.setMeta('app', JSON.stringify(settings));
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  /** Deletes tool calls and log entries from before `cutoff`. Returns how many went. */
  deleteOlderThan(cutoff: number): { events: number; log: number } {
    const events = this.db.prepare('DELETE FROM events WHERE at < ?').run(cutoff).changes;
    const log = this.db.prepare('DELETE FROM activity_log WHERE at < ?').run(cutoff).changes;
    return { events, log };
  }

  /** Empties agents and everything hanging off them, keeping settings and accounts. */
  clearOffice(): void {
    this.transaction(() => {
      for (const table of [
        'session_states',
        'agents',
        'events',
        'messages',
        'instructions',
        'approvals',
        'activity_log',
        'projects',
      ]) {
        this.db.exec(`DELETE FROM ${table}`);
      }
    });
  }

  /** Empties every table, including settings and accounts. */
  wipe(): void {
    this.clearOffice();
    this.transaction(() => {
      this.db.exec('DELETE FROM accounts');
      this.db.exec('DELETE FROM settings');
    });
  }
}
