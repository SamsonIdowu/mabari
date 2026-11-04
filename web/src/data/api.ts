// SPDX-License-Identifier: Apache-2.0
import type {
  AccountKind,
  Agent,
  DiffLine,
  Estimate,
  Project,
  Settings,
  Snapshot,
} from '../gen/models.ts';

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed: ${response.status}`);
  }
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
}

export interface TeamLine {
  name: string;
  state: string;
  estimate: string;
  task: string;
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
  state: string;
  task: string;
  estimate: Estimate | null;
  summary: string;
  approvalId: string;
}

export interface VeeReply {
  text: string;
  gesture: string;
  kind: '' | 'needs' | 'when' | 'status' | 'office' | 'empty' | 'dispatch' | 'newAgent';
  lines: VeeLine[] | null;
  estimate: Estimate | null;
  working: number;
  total: number;
  need: number;
  message: string;
}

export interface VeeResult {
  reply: VeeReply;
  message: MessageResult | null;
}

/** What Connect would change in Claude Code's settings, from GET /api/accounts/claude. */
export interface ClaudePlan {
  attached: boolean;
  path: string;
  diff: DiffLine[];
  backup: string;
}

export interface Scope {
  projectId: string;
  teamId: string;
}

export const api = {
  snapshot: () => request<Snapshot>('/api/snapshot'),
  loadDemo: () => send<{ ok: boolean }>('POST', '/api/demo/load'),
  wipe: () => send<{ ok: boolean }>('POST', '/api/wipe', { confirm: true }),
  updateSettings: (patch: Partial<Settings>) => send<Settings>('PATCH', '/api/settings', patch),
  completeProject: (id: string) => send<Project>('POST', `/api/projects/${id}/complete`),
  reopenProject: (id: string) => send<Project>('POST', `/api/projects/${id}/reopen`),
  previewDispatch: (text: string, scope: Scope) =>
    send<{ decision: Decision | null }>('POST', '/api/dispatch/preview', { text, ...scope }),
  sendMessage: (text: string, mode: MessageMode, target: string, scope: Scope) =>
    send<MessageResult>('POST', '/api/messages', { text, mode, target, ...scope }),
  decide: (id: string, decision: 'allowed' | 'denied') =>
    send<{ applied: boolean }>('POST', `/api/approvals/${id}/decision`, { decision }),
  autoApprove: (on: boolean, scope: string, acknowledged: boolean) =>
    send<{ settled: number }>('POST', '/api/auto-approve', { on, scope, acknowledged }),
  vee: (text: string, dispatch: boolean) => send<VeeResult>('POST', '/api/vee', { text, dispatch }),
  agentAction: (id: string, action: 'interrupt' | 'stop' | 'retry') =>
    send<{ ok: boolean }>('POST', `/api/agents/${id}/${action}`),
  createAgent: (body: NewAgentBody) => send<Agent>('POST', '/api/agents', body),
  updateAgent: (id: string, patch: AgentPatch) => send<Agent>('PATCH', `/api/agents/${id}`, patch),
  addSubagent: (id: string, body: { name: string; task: string; model: string }) =>
    send<Agent>('POST', `/api/agents/${id}/subagents`, body),
  saveKey: (kind: AccountKind, key: string) =>
    send<{ ok: boolean }>('PUT', `/api/accounts/${kind}/key`, { key }),
  deleteKey: (kind: AccountKind) => send<{ ok: boolean }>('DELETE', `/api/accounts/${kind}/key`),
  newHubToken: () => send<{ token: string }>('POST', '/api/accounts/hub/token'),
  revokeHubToken: () => send<{ ok: boolean }>('DELETE', '/api/accounts/hub/token'),
  codexLogin: () => send<{ authUrl: string }>('POST', '/api/accounts/codex/login'),
  codexLogout: () => send<{ ok: boolean }>('POST', '/api/accounts/codex/logout'),
  claudePlan: () => request<ClaudePlan>('/api/accounts/claude'),
  connectClaude: () =>
    send<{ ok: boolean }>('POST', '/api/accounts/claude/connect', { confirm: true }),
  disconnectClaude: () => send<{ ok: boolean }>('POST', '/api/accounts/claude/disconnect'),
};
