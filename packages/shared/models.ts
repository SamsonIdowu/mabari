import type { ProviderName } from './tokens.ts';

export type AgentStateName =
  | 'thinking'
  | 'reading'
  | 'editing'
  | 'running'
  | 'browsing'
  | 'approval'
  | 'spawning'
  | 'idle'
  | 'done'
  | 'error'
  | 'paused';

export type AccountKind = 'codex' | 'claude_code' | 'anthropic_key' | 'openai_key' | 'hub';
export type AccountStatus = 'off' | 'connecting' | 'connected' | 'expired' | 'stale';
export type AgentSource = 'sim' | 'claude_code' | 'codex' | 'api' | 'hub';

export interface Repository {
  path: string;
  url: string | null;
  branch: string | null;
}

export interface Project {
  id: string;
  name: string;
  color: string;
  instructions: string;
  files: string[];
  repository: Repository | null;
  createdAt: number;
}

export interface Account {
  id: string;
  kind: AccountKind;
  status: AccountStatus;
  email: string | null;
  models: string[];
  lastEventAt: number | null;
}

export interface Agent {
  id: string;
  projectId: string | null;
  name: string;
  provider: ProviderName;
  model: string;
  account: AccountKind;
  source: AgentSource;
  leadId: string | null;
  /** The model this agent's subagents use, or `inherit` to use this agent's own model. */
  subModel: string;
  desk: number;
  folder: string;
  allowedTools: string[];
  dailyCostCap: number | null;
  hue: string;
  createdAt: number;
}

export interface SessionState {
  state: AgentStateName;
  task: string;
  /** 0 to 1. */
  progress: number;
  /** Progress per office second, which drives the time estimate. */
  rate: number;
  elapsed: number;
  tokensIn: number;
  tokensOut: number;
  error: string;
  /** Files this agent is working on, used by tool feeds and the dispatcher. */
  files: string[];
  bubble: string;
  reply: string;
  replyUntil: number;
  talk: string;
  talkUntil: number;
  talkColor: string;
  leaving: boolean;
}

export interface AgentEvent {
  id: string;
  agentId: string;
  at: number;
  tool: string;
  summary: string;
  raw: unknown;
}

export type MessageKind = 'handoff' | 'question' | 'answer' | 'report' | 'review' | 'broadcast';

export interface Message {
  id: string;
  fromId: string;
  toIds: string[];
  fromName: string;
  toName: string;
  projectId: string | null;
  kind: MessageKind;
  text: string;
  at: number;
}

export type InstructionMode = 'instruct' | 'query';
export type InstructionStatus = 'delivered' | 'waiting' | 'answered';

export interface Instruction {
  id: string;
  /** Null means it went through the dispatcher and no agent was chosen. */
  agentId: string | null;
  text: string;
  mode: InstructionMode;
  status: InstructionStatus;
  at: number;
  logId: string | null;
}

export type ApprovalType = 'command' | 'file' | 'plan';
export type RiskLevel = 'low' | 'high';
export type ApprovalDecision = 'allowed' | 'denied';
export type DecidedBy = 'user' | 'auto';

export interface DiffLine {
  kind: 'ctx' | 'add' | 'del';
  text: string;
}

export interface ApprovalDetail {
  cmd?: string;
  path?: string;
  lines?: DiffLine[];
  project?: string;
  steps?: string[];
}

export interface Approval {
  id: string;
  agentId: string;
  type: ApprovalType;
  title: string;
  detail: ApprovalDetail;
  /** Plain words for the card, such as "This changes the staging database." */
  risk: string;
  riskLevel: RiskLevel;
  decision: ApprovalDecision | null;
  decidedBy: DecidedBy | null;
  at: number;
}

/** An agent as the UI sees it: identity, live session, and what is waiting on it. */
export interface LiveAgent extends Agent, SessionState {
  feed: AgentEvent[];
  queued: Instruction[];
  approval: Approval | null;
}

export type LogType = 'Instruction' | 'Query' | 'Approval' | 'Session';
export type LogChip = '' | 'ok' | 'amber' | 'red';

export interface LogEntry {
  id: string;
  at: number;
  agent: string;
  type: LogType;
  message: string;
  outcome: string;
  chip: LogChip;
}

export type AutoApproveScope = 'safe' | 'all';

export interface Settings {
  queryModel: string;
  voice: 'browser' | 'whisper';
  spoken: boolean;
  retentionDays: number;
  lan: boolean;
  defaults: { claude: string; codex: string; anthropic: string; openai: string };
  autoApprove: { on: boolean; scope: AutoApproveScope };
}

export interface Snapshot {
  bootId: string;
  seq: number;
  firstRun: boolean;
  projects: Project[];
  accounts: Account[];
  agents: LiveAgent[];
  messages: Message[];
  log: LogEntry[];
  settings: Settings;
}

/** Everything that changes after a snapshot. The client applies these in `seq` order. */
export type ServerEvent =
  | { type: 'agent.upsert'; agent: LiveAgent }
  | { type: 'agent.patch'; id: string; patch: Partial<LiveAgent> }
  | { type: 'agent.remove'; id: string }
  | { type: 'event.add'; event: AgentEvent }
  | { type: 'message.add'; message: Message }
  | { type: 'log.upsert'; entry: LogEntry }
  | { type: 'project.upsert'; project: Project }
  | { type: 'project.remove'; id: string }
  | { type: 'account.upsert'; account: Account }
  | { type: 'settings'; settings: Settings }
  | { type: 'toast'; text: string }
  /** Too much changed to patch, so reload the snapshot. Sent after demo load and wipe. */
  | { type: 'reset' };

export type SequencedEvent = ServerEvent & { seq: number };

export type ServerMessage =
  | SequencedEvent
  | { type: 'hello'; bootId: string; seq: number }
  /** The client's position can't be resumed, so it must reload the snapshot. */
  | { type: 'resync' };
