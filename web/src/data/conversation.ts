// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';
import type { Conversation, ConversationItem, ServerMessage } from '../gen/models.ts';
import { api } from './api.ts';

/** One agent's conversation as far as the page has loaded it. */
export interface Thread {
  items: ConversationItem[];
  hasMore: boolean;
  /** False until the first page has come back. */
  loaded: boolean;
}

export const emptyThread: Thread = { items: [], hasMore: false, loaded: false };

/** Puts an item in its place by number, replacing the one with its number if there is one. */
function placed(items: ConversationItem[], item: ConversationItem): ConversationItem[] {
  const index = items.findIndex((existing) => existing.seq >= item.seq);
  if (index < 0) return [...items, item];
  if (items[index]?.seq === item.seq) return items.map((old, at) => (at === index ? item : old));
  return [...items.slice(0, index), item, ...items.slice(index)];
}

/** Applies a live change. It never changes the thread it is given. */
export function applyToThread(thread: Thread, message: ServerMessage): Thread {
  if (message.type === 'conversation' && message.item) {
    return { ...thread, items: placed(thread.items, message.item) };
  }
  if (message.type === 'conversation.delta' && message.id) {
    const text = message.text ?? '';
    return {
      ...thread,
      items: thread.items.map((item) =>
        // A finished item already holds all of its text, so a late delta would repeat it.
        item.id === message.id && item.streaming ? { ...item, text: item.text + text } : item,
      ),
    };
  }
  return thread;
}

/**
 * Puts a page from the server together with what has arrived live. What the page holds is newer
 * for any number both have, unless the page's copy has finished and the live one hasn't.
 */
export function mergePage(thread: Thread, page: Conversation, older: boolean): Thread {
  let items = page.items ?? [];
  for (const live of thread.items) {
    const fetched = items.find((item) => item.seq === live.seq);
    if (
      !fetched ||
      (!live.streaming && fetched.streaming) ||
      live.streaming === fetched.streaming
    ) {
      items = placed(items, fetched && live.streaming === fetched.streaming ? fetched : live);
    }
  }
  return { items, hasMore: older ? page.hasMore : page.hasMore || thread.hasMore, loaded: true };
}

const agentOf = (message: ServerMessage): string | null | undefined =>
  message.type === 'conversation' ? message.item?.agentId : message.agentId;

interface ConversationState {
  threads: Record<string, Thread>;
  /** Loads the newest page of an agent's conversation, so live changes have something to join. */
  open: (agentId: string) => Promise<void>;
  /** Loads the page before what is held. */
  older: (agentId: string) => Promise<void>;
  apply: (message: ServerMessage) => void;
  /** Reloads what is open, after the page missed changes or the office was replaced. */
  reloadAll: () => void;
}

export const useConversations = create<ConversationState>((set, get) => ({
  threads: {},
  open: async (agentId) => {
    const page = await api.conversation(agentId);
    set((state) => ({
      threads: {
        ...state.threads,
        [agentId]: mergePage(state.threads[agentId] ?? emptyThread, page, false),
      },
    }));
  },
  older: async (agentId) => {
    const before = get().threads[agentId]?.items[0]?.seq;
    if (before === undefined) return;
    const page = await api.conversation(agentId, before);
    set((state) => ({
      threads: {
        ...state.threads,
        [agentId]: mergePage(state.threads[agentId] ?? emptyThread, page, true),
      },
    }));
  },
  apply: (message) => {
    const agentId = agentOf(message);
    if (!agentId) return;
    set((state) => {
      // A thread nobody has opened loads whole when someone does.
      const thread = state.threads[agentId];
      if (!thread?.loaded) return state;
      return { threads: { ...state.threads, [agentId]: applyToThread(thread, message) } };
    });
  },
  reloadAll: () => {
    const open = Object.keys(get().threads);
    set({ threads: {} });
    for (const agentId of open) void get().open(agentId);
  },
}));
