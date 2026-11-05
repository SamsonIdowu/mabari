// SPDX-License-Identifier: Apache-2.0
import type { Relay } from '../office/relay.ts';
import type {
  AccountKind,
  Agent,
  AgentDef,
  DiffLine,
  Estimate,
  LiveAgent,
  Project,
  QuestionAnswer,
  Settings,
  Snapshot,
  WhisperStatus,
} from '../gen/models.ts';
import { keepSession, sessionHeaders } from './session.ts';

export interface NewAgentBody {
  name: string;
  account: AccountKind;
  model: string;
  task: string;
  projectId: string;
  folder: string;
  dailyCostCap: number;
  allowedTools: string[];
  desk?: number;
  leadId?: string;
}

export interface AgentPatch {
  model?: string;
  subModel?: string;
  projectId?: string;
  folder?: string;
  dailyCostCap?: number;
  allowedTools?: string[];
}

/** Sent on window when Mabari asks for the access key, so the sign in can show. */
export const SIGN_IN_EVENT = 'mabari:sign-in';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(sessionHeaders())) headers.set(name, value);
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      login?: boolean;
    } | null;
    if (response.status === 401 && body?.login) {
      keepSession('');
      window.dispatchEvent(new Event(SIGN_IN_EVENT));
    }
    throw new Error(body?.error ?? `Request failed: ${response.status}`);
  }
  // A delete answers with no content.
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

export type MessageMode = 'instruct' | 'query';

export interface Decision {
  agentId: string;
  name: string;
  hue: string;
  reason: string;
}

export interface Answer {
  question: string;
  agentId: string;
  name: string;
  state: string;
  task: string;
  reads: number;
  edits: number;
  runs: number;
  latestTool: string;
  latestSummary: string;
  estimate: string;
  model: string;
  events: string[];
  /** The query model's own answer, when one answered. */
  text: string;
  answeredBy: string;
}

export interface TeamLine {
  name: string;
  state: string;
  estimate: string;
  task: string;
}

/** What Reload from disk found. Mirrors internal/agentdefs.Report. */
export interface DefsReport {
  account: number;
  codex: number;
  projects: Record<string, number> | null;
  problems: string[] | null;
}

export interface MessageResult {
  agents: string[];
  answer: Answer | null;
  team: TeamLine[] | null;
  routed: Decision | null;
}

export interface VeeLine {
  agentId: string;
  name: string;
  hue: string;
  /** What kind of agent it is, shown after the name, such as "workflow sub-agent", or empty. */
  label: string;
  state: string;
  task: string;
  estimate: Estimate | null;
  summary: string;
  approvalId: string;
  /** Set for an agent asking you a question, which is answered in its panel. */
  questionId: string;
  /** In a list of replies: which AI answered, and the start of what it said. */
  ai: string;
  reply: string;
}

/** Mirrors internal/vee.Reply. "relayed" is the page's own: an agent's reply Mabari passes on. */
export interface VeeReply {
  text: string;
  gesture: string;
  kind:
    | ''
    | 'needs'
    | 'when'
    | 'status'
    | 'office'
    | 'empty'
    | 'newAgent'
    | 'replies'
    | 'relayed'
    | 'improve'
    | 'builder'
    | 'pickProject';
  lines: VeeLine[] | null;
  estimate: Estimate | null;
  working: number;
  total: number;
  need: number;
  /** What a builder reply works on: the agent to improve, or what a new agent should do. */
  target?: string;
  /** Set when Mabari passed an instruction on and will relay the reply. */
  relay: Relay | null;
  /** The project a message went to. */
  project?: ProjectChoice | null;
  /** The choices when Mabari asks which project a message is for. */
  projects?: ProjectChoice[] | null;
  /** What is read aloud, when it differs from the text. */
  spoken?: string;
  /** A relayed reply too long for the bubble names its agent, to read the rest there. */
  agentId?: string | undefined;
}

/** A project as Mabari's replies show it. Mirrors internal/vee.ProjectChoice. */
export interface ProjectChoice {
  id: string;
  name: string;
  color: string;
  folder: string;
}

/** Where a project message went. Mirrors internal/server.projectSendResult. */
export interface ProjectSendResult {
  notice: string;
  agentId: string;
  instructionId: string;
  opened: boolean;
}

export interface VeeResult {
  reply: VeeReply;
  message: MessageResult | null;
}

/** What Connect would change in Claude Code's settings, from GET /api/accounts/claude. */
export interface ClaudePlan {
  attached: boolean;
  /** The attached hooks are too old to wait for answers to Claude's questions. */
  outdated?: boolean;
  path: string;
  diff: DiffLine[];
  backup: string;
}

/** Whether Mabari is Claude Code's default agent, and what switching would change. */
export interface DefaultAgentPlan {
  on: boolean;
  /** Another agent someone set as the default, which making Mabari the default replaces. */
  other: string;
  path: string;
  diff: DiffLine[];
  backup: string;
}

export interface PlanMember {
  role: string;
  label: string;
  name: string;
  task: string;
  on: boolean;
  minutes: number;
}

/** A proposed team, from the planner. Its minutes come from the server. */
export interface ProjectPlan {
  name: string;
  color: string;
  account: AccountKind;
  leadName: string;
  leadModel: string;
  subModel: string;
  leadTask: string;
  members: PlanMember[];
  minutes: number;
}

export interface PlanRequest {
  said: string[];
  previous: ProjectPlan | null;
  instructions: string;
  files: { name: string; text: string }[];
  repo: { name: string; lang: string; files: number } | null;
}

export interface FolderScan {
  root: string;
  path: string;
  count: number;
  markers: string[];
  lang: string;
  manifest: string;
  tests: string;
  instructions: string;
  instructionsFrom: string;
  /** The agent files in the folder's .claude/agents, by name. */
  agents: string[] | null;
}

export interface FolderCheck {
  path: string;
  url: boolean;
  name: string;
  hint: string;
  scan: FolderScan | null;
  error: string;
}

export interface ProjectStart {
  plan: ProjectPlan;
  name: string;
  instructions: string;
  files: string[];
  folder: string;
  branch: string;
  mode: 'plan' | 'go';
  brief: string;
}

export interface Scope {
  projectId: string;
  teamId: string;
}

/** The local service that starts Mabari at login. Mirrors internal/service.Status. */
export interface LoginStatus {
  supported: boolean;
  installed: boolean;
  running: boolean;
  detail: string;
}

export interface SessionInfo {
  needed: boolean;
  signedIn: boolean;
  token?: string;
}

/** The access key and where other devices reach Mabari. Mirrors internal/server accessInfo. */
export interface AccessInfo {
  key: string;
  addresses: string[] | null;
  lanControl: boolean;
  token?: string;
}

/** The reply to POST /api/desks/start. Mirrors internal/server deskStartResult. */
export interface DeskStartResult {
  notice: string;
  opened: boolean;
  agentId: string;
}

export const api = {
  session: () => request<SessionInfo>('/api/session'),
  signIn: (key: string) =>
    send<SessionInfo>('POST', '/api/login', { key }).then((info) => {
      keepSession(info.token ?? '');
      return info;
    }),
  signOut: () => send<SessionInfo>('POST', '/api/logout'),
  access: () => request<AccessInfo>('/api/access'),
  rotateAccess: () =>
    send<AccessInfo>('POST', '/api/access/rotate').then((info) => {
      // Whoever made the new key stays signed in with it.
      if (info.token) keepSession(info.token);
      return info;
    }),
  snapshot: () => request<Snapshot>('/api/snapshot'),
  loadDemo: () => send<{ ok: boolean }>('POST', '/api/demo/load'),
  stopDemo: () => send<{ ok: boolean }>('POST', '/api/demo/stop'),
  loginService: () => request<LoginStatus>('/api/service'),
  setLoginService: (on: boolean) => send<LoginStatus>('POST', '/api/service', { on }),
  whisperStatus: () => request<WhisperStatus>('/api/voice/whisper'),
  downloadWhisper: () => send<WhisperStatus>('POST', '/api/voice/whisper/model'),
  removeWhisper: () => send<WhisperStatus>('DELETE', '/api/voice/whisper/model'),
  /** Turns a 16 kHz WAV recording into text with Local Whisper, on this computer. */
  transcribe: (wav: Blob, lang: string, signal?: AbortSignal) =>
    request<{ text: string }>(`/api/voice/transcribe?lang=${encodeURIComponent(lang)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav,
      signal: signal ?? null,
    }),
  wipe: () => send<{ ok: boolean }>('POST', '/api/wipe', { confirm: true }),
  updateSettings: (patch: Partial<Settings>) => send<Settings>('PATCH', '/api/settings', patch),
  completeProject: (id: string) => send<Project>('POST', `/api/projects/${id}/complete`),
  reopenProject: (id: string) => send<Project>('POST', `/api/projects/${id}/reopen`),
  updateProject: (
    id: string,
    patch: { name?: string; color?: string; instructions?: string; folder?: string },
  ) => send<Project>('PATCH', `/api/projects/${id}`, patch),
  deleteProject: (id: string) => send<unknown>('DELETE', `/api/projects/${id}`),
  /** Opens Claude Code in the project's folder, in a terminal on this computer. */
  openProjectClaude: (id: string, prompt = '') =>
    send<{ notice: string }>('POST', `/api/projects/${id}/claude`, { prompt }),
  /**
   * Passes a message to a project: to the agent there that can take it, or to Claude Code opened
   * in the project's folder with it. Slash commands always open Claude Code, which runs them.
   */
  sendToProject: (id: string, text: string) =>
    send<ProjectSendResult>('POST', `/api/projects/${id}/send`, { text }),
  /**
   * Puts one of the agent files at the free desk, working on a task: for real, Claude Code opens
   * in the project's folder running as that agent; in the demo, the agent sits down at once.
   */
  startAtDesk: (defId: string, projectId: string, task: string) =>
    send<DeskStartResult>('POST', '/api/desks/start', { defId, projectId, task }),
  /** Takes back an instruction before it is delivered. */
  removeInstruction: (id: string) =>
    send<unknown>('DELETE', `/api/instructions/${encodeURIComponent(id)}`),
  previewDispatch: (text: string, scope: Scope) =>
    send<{ decision: Decision | null }>('POST', '/api/dispatch/preview', { text, ...scope }),
  sendMessage: (text: string, mode: MessageMode, target: string, scope: Scope) =>
    send<MessageResult>('POST', '/api/messages', { text, mode, target, ...scope }),
  decide: (id: string, decision: 'allowed' | 'denied') =>
    send<{ applied: boolean }>('POST', `/api/approvals/${id}/decision`, { decision }),
  autoApprove: (on: boolean, scope: string, acknowledged: boolean) =>
    send<{ settled: number }>('POST', '/api/auto-approve', { on, scope, acknowledged }),
  /** projectId is the project picked next to the box, "any", or empty for Mabari to choose. */
  vee: (text: string, projectId = '') => send<VeeResult>('POST', '/api/vee', { text, projectId }),
  agentAction: (id: string, action: 'interrupt' | 'continue' | 'stop' | 'retry') =>
    send<{ ok: boolean }>('POST', `/api/agents/${id}/${action}`),
  createAgent: (body: NewAgentBody) => send<Agent>('POST', '/api/agents', body),
  updateAgent: (id: string, patch: AgentPatch) => send<Agent>('PATCH', `/api/agents/${id}`, patch),
  addSubagent: (id: string, body: { name: string; task: string; model: string }) =>
    send<Agent>('POST', `/api/agents/${id}/subagents`, body),
  /** Answers the question the agent is asking; the server checks the answers fit it. */
  answerQuestion: (id: string, questionId: string, answers: QuestionAnswer[]) =>
    send<{ answered: boolean }>('POST', `/api/agents/${encodeURIComponent(id)}/answer`, {
      questionId,
      answers,
    }),
  saveKey: (kind: AccountKind, key: string) =>
    send<{ ok: boolean }>('PUT', `/api/accounts/${kind}/key`, { key }),
  deleteKey: (kind: AccountKind) => send<{ ok: boolean }>('DELETE', `/api/accounts/${kind}/key`),
  newHubToken: () => send<{ token: string }>('POST', '/api/accounts/hub/token'),
  revokeHubToken: () => send<{ ok: boolean }>('DELETE', '/api/accounts/hub/token'),
  codexLogin: () => send<{ authUrl: string }>('POST', '/api/accounts/codex/login'),
  codexLogout: () => send<{ ok: boolean }>('POST', '/api/accounts/codex/logout'),
  plan: (body: PlanRequest) =>
    send<{ plan: ProjectPlan; reply: string }>('POST', '/api/planner', body),
  estimatePlan: (plan: ProjectPlan) =>
    send<{ minutes: number }>('POST', '/api/planner/estimate', plan),
  startProject: (body: ProjectStart) =>
    send<{ project: Project; leadId: string; notice: string }>('POST', '/api/projects/start', body),
  checkFolder: (path: string, allowUrl: boolean) =>
    send<FolderCheck>('POST', '/api/folders/check', { path, allowUrl }),
  pickFolder: () => send<{ path: string }>('POST', '/api/folders/pick'),
  recentFolders: () => request<string[]>('/api/folders/recent'),
  saveDef: (def: AgentDef, previousId: string, by = '') =>
    send<AgentDef>('POST', '/api/defs', { def, previousId, by }),
  deleteDef: (id: string) => send<{ ok: boolean }>('DELETE', `/api/defs/${encodeURIComponent(id)}`),
  enableDef: (id: string, on: boolean) =>
    send<{ ok: boolean }>('POST', `/api/defs/${encodeURIComponent(id)}/enabled`, { on }),
  runDef: (id: string) => send<LiveAgent>('POST', `/api/defs/${encodeURIComponent(id)}/run`),
  rescanDefs: () => send<DefsReport>('POST', '/api/defs/rescan'),
  claudePlan: () => request<ClaudePlan>('/api/accounts/claude'),
  connectClaude: () =>
    send<{ ok: boolean }>('POST', '/api/accounts/claude/connect', { confirm: true }),
  disconnectClaude: () => send<{ ok: boolean }>('POST', '/api/accounts/claude/disconnect'),
  defaultAgentPlan: () => request<DefaultAgentPlan>('/api/accounts/claude/default-agent'),
  /** Makes Mabari the agent every new Claude Code session runs as, or stops it, after a backup. */
  setDefaultAgent: (on: boolean) =>
    send<{ on: boolean }>('POST', '/api/accounts/claude/default-agent', { on, confirm: true }),
};
