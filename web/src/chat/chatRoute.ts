// SPDX-License-Identifier: Apache-2.0
// Where the Chats screen is, as its address says: `#conversations?agent=<id>` or `?project=<id>`
// for With you, and `?tab=between` for what agents say to each other. A bare `#conversations` is
// With you, as it should be for the screen people work in.
import { useSyncExternalStore } from 'react';
import { hashParam } from '../routes.ts';

export type ChatTab = 'with' | 'between';

export interface ChatPlace {
  tab: ChatTab;
  agent: string | null;
  project: string | null;
}

/** What an address names. An agent wins over a project if one is silly enough to name both. */
export function chatPlace(hash: string): ChatPlace {
  const agent = hashParam(hash, 'agent');
  const project = agent ? null : hashParam(hash, 'project');
  return {
    tab: hashParam(hash, 'tab') === 'between' && !agent && !project ? 'between' : 'with',
    agent,
    project,
  };
}

export const chatHash = {
  agent: (id: string) => `#conversations?agent=${encodeURIComponent(id)}`,
  project: (id: string) => `#conversations?project=${encodeURIComponent(id)}`,
  with: () => '#conversations',
  between: () => '#conversations?tab=between',
};

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

/** The address now, kept up to date as it changes. */
export function useChatHash(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash);
}
