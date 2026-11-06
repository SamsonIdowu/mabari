// SPDX-License-Identifier: Apache-2.0
// Chats, as a kind of result in the quick switcher: "Chat with Atlas" opens that agent's thread,
// "Chat with Docs site" the project's. They are the Chats screen's own links, and they come in the
// order of the screen's list, so whoever needs you is first. Choosing one only opens a thread: it
// sends nothing, and approves nothing.
import { registerSource, type SwitcherResult, type SwitcherSource } from '../shell/switcher.ts';
import { chatEntries } from './chatList.ts';
import { chatHash } from './chatRoute.ts';

export const conversationsSource: SwitcherSource = {
  id: 'conversations',
  heading: 'Chats',
  position: 25,
  results: ({ office }) => {
    if (!office) return [];
    const { agents, projects } = chatEntries(office);
    return [...agents, ...projects].map((entry, order): SwitcherResult => {
      const chip =
        entry.tone === 'red'
          ? { text: 'Needs you', tone: 'red' as const }
          : entry.needs
            ? { text: 'Asking you', tone: 'ask' as const }
            : undefined;
      return {
        id: `chat:${entry.kind}:${entry.id}`,
        label: `Chat with ${entry.name}`,
        detail: entry.detail,
        color: entry.color,
        glyph: entry.kind === 'agent' ? 'square' : 'dot',
        ...(chip ? { chip } : {}),
        href: entry.kind === 'agent' ? chatHash.agent(entry.id) : chatHash.project(entry.id),
        order,
      };
    });
  },
};

registerSource(conversationsSource);
