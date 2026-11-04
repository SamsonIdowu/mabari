// SPDX-License-Identifier: Apache-2.0
import type { Agent, Project, Settings, Snapshot } from '../gen/models.ts';

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

export const api = {
  snapshot: () => request<Snapshot>('/api/snapshot'),
  loadDemo: () => send<{ ok: boolean }>('POST', '/api/demo/load'),
  wipe: () => send<{ ok: boolean }>('POST', '/api/wipe', { confirm: true }),
  updateSettings: (patch: Partial<Settings>) => send<Settings>('PATCH', '/api/settings', patch),
  completeProject: (id: string) => send<Project>('POST', `/api/projects/${id}/complete`),
  reopenProject: (id: string) => send<Project>('POST', `/api/projects/${id}/reopen`),
  agentAction: (id: string, action: 'interrupt' | 'stop' | 'retry') =>
    send<{ ok: boolean }>('POST', `/api/agents/${id}/${action}`),
  updateAgent: (id: string, patch: AgentPatch) => send<Agent>('PATCH', `/api/agents/${id}`, patch),
  addSubagent: (id: string, body: { name: string; task: string; model: string }) =>
    send<Agent>('POST', `/api/agents/${id}/subagents`, body),
};
