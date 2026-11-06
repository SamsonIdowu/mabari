// SPDX-License-Identifier: Apache-2.0
// What the Chats screen asks of the server. The types mirror internal/server/chat*.go.
import { create } from 'zustand';
import { request, send } from './api.ts';

export interface ChatBody {
  agentId?: string;
  projectId?: string;
  text: string;
  plan?: boolean;
  model?: string;
  now?: boolean;
  everyone?: boolean;
  attachments?: string[];
  mentions?: string[];
}

export interface AskedAgent {
  id: string;
  name: string;
}

/** A message sent to everyone on a project. */
export interface Ask {
  id: string;
  projectId: string;
  text: string;
  time: number;
  agents: AskedAgent[];
}

export interface ChatResult {
  notice: string;
  agentId: string;
  instructionId: string;
  queued: boolean;
  opened: boolean;
  ask: Ask | null;
}

export interface Attachment {
  id: string;
  name: string;
  path: string;
  size: number;
}

export interface ChatFile {
  path: string;
  dir: boolean;
}

export interface ChatCommand {
  name: string;
  kind: 'command' | 'skill';
  scope: 'folder' | 'account';
  description: string;
}

export interface Saved {
  id: string;
  name: string;
  text: string;
  created: number;
}

/** Who a message box talks to, as the server wants it named: an agent or a project, never a path. */
export type Subject = { agent: string } | { project: string };

const subjectQuery = (subject: Subject) =>
  'agent' in subject
    ? `agent=${encodeURIComponent(subject.agent)}`
    : `project=${encodeURIComponent(subject.project)}`;

export const chatApi = {
  send: (body: ChatBody) => send<ChatResult>('POST', '/api/chat/send', body),
  /** The most the server keeps of one file. */
  maxFileBytes: 25 * 1024 * 1024,
  attach: (file: File, signal?: AbortSignal) =>
    request<Attachment>(`/api/attachments?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
      signal: signal ?? null,
    }),
  files: (subject: Subject, query: string, signal?: AbortSignal) =>
    request<{ files: ChatFile[] }>(
      `/api/chat/files?${subjectQuery(subject)}&q=${encodeURIComponent(query)}`,
      { signal: signal ?? null },
    ).then((reply) => reply.files),
  commands: (subject: Subject) =>
    request<{ commands: ChatCommand[]; saved: Saved[] }>(
      `/api/chat/commands?${subjectQuery(subject)}`,
    ),
  saved: () => request<Saved[]>('/api/saved-instructions'),
  save: (name: string, text: string) =>
    send<Saved>('POST', '/api/saved-instructions', { name, text }),
  forget: (id: string) =>
    send<unknown>('DELETE', `/api/saved-instructions/${encodeURIComponent(id)}`),
  hand: (from: string, itemId: string, to: string, note: string) =>
    send<ChatResult>('POST', `/api/agents/${encodeURIComponent(from)}/hand`, { itemId, to, note }),
  asks: (project: string) =>
    request<Ask[]>(`/api/projects/${encodeURIComponent(project)}/asks`),
};

interface SavedState {
  items: Saved[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (name: string, text: string) => Promise<Saved>;
  remove: (id: string) => Promise<void>;
}

/** The saved instructions, shared by every message box. */
export const useSaved = create<SavedState>((set, get) => ({
  items: [],
  loaded: false,
  load: async () => {
    const items = await chatApi.saved();
    set({ items, loaded: true });
  },
  add: async (name, text) => {
    const made = await chatApi.save(name, text);
    set({ items: [...get().items, made] });
    return made;
  },
  remove: async (id) => {
    await chatApi.forget(id);
    set({ items: get().items.filter((item) => item.id !== id) });
  },
}));

interface AsksState {
  byProject: Record<string, Ask[]>;
  load: (project: string) => Promise<void>;
  add: (ask: Ask) => void;
  /** After a wipe or a reset, what was held is gone. */
  clear: () => void;
}

/** The messages sent to everyone on each project, so their side by side replies survive a reload. */
export const useAsks = create<AsksState>((set) => ({
  byProject: {},
  load: async (project) => {
    const asks = await chatApi.asks(project);
    set((state) => ({ byProject: { ...state.byProject, [project]: asks } }));
  },
  add: (ask) =>
    set((state) => {
      const have = state.byProject[ask.projectId] ?? [];
      if (have.some((item) => item.id === ask.id)) return state;
      return { byProject: { ...state.byProject, [ask.projectId]: [...have, ask] } };
    }),
  clear: () => set({ byProject: {} }),
}));
