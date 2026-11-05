// SPDX-License-Identifier: Apache-2.0
// A project's chat: every message sent to the project's agents from Mabari, oldest first, each
// with where it waits and the reply once it comes. It is read from the same server state as the
// prompt tray, so nothing is kept twice.
import type { LiveAgent, Project } from '../gen/models.ts';
import { aiName } from './relay.ts';

export type ChatStatus = 'opening' | 'queued' | 'sent' | 'replied';

export interface ChatItem {
  /** The instruction's id. */
  id: string;
  at: number;
  text: string;
  /** Who it went to: an agent, or Claude Code while it opens. */
  to: string;
  ai: string;
  status: ChatStatus;
  reply: string;
  repliedAt: number;
  /** The agent holding it, to open its panel. Empty while Claude Code opens. */
  agentId: string;
}

export const CHAT_STATUS: Record<ChatStatus, string> = {
  opening: 'Opening Claude Code',
  queued: 'Waiting for its next checkpoint',
  sent: 'Delivered',
  replied: 'Replied',
};

/**
 * Instructions that can still be taken back: only those waiting for a checkpoint. Claude Code
 * was already opened with a prompt that is "opening", so that one can't be.
 */
export function removable(item: ChatItem): boolean {
  return item.status === 'queued';
}

export function projectChat(project: Project, agents: LiveAgent[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const waiting of project.opening ?? []) {
    items.push({
      id: waiting.id,
      at: waiting.time,
      text: waiting.text,
      to: 'Claude Code',
      ai: 'Claude',
      status: 'opening',
      reply: '',
      repliedAt: 0,
      agentId: '',
    });
  }
  for (const agent of agents) {
    if (agent.projectId !== project.id) continue;
    const base = { to: agent.name, ai: aiName(agent), agentId: agent.id };
    for (const queued of agent.queued ?? []) {
      items.push({
        ...base,
        id: queued.id,
        at: queued.time,
        text: queued.text,
        status: 'queued',
        reply: '',
        repliedAt: 0,
      });
    }
    for (const asked of agent.asked ?? []) {
      items.push({
        ...base,
        id: asked.id,
        at: asked.time,
        text: asked.text,
        status: asked.reply ? 'replied' : 'sent',
        reply: asked.reply,
        repliedAt: asked.repliedAt,
      });
    }
  }
  return items.sort((a, b) => a.at - b.at);
}
