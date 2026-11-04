// SPDX-License-Identifier: Apache-2.0
import type { LiveAgent, ServerMessage, Snapshot } from '../gen/models.ts';

const FEED_LIMIT = 40;
const MESSAGE_LIMIT = 400;
const LOG_LIMIT = 500;

function upsert<T extends { id: string }>(items: T[], item: T, atStart = false): T[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index < 0) return atStart ? [item, ...items] : [...items, item];
  return items.map((existing) => (existing.id === item.id ? item : existing));
}

/** Agent messages leave the feed out, so the one we already have carries over. */
function withFeed(agents: LiveAgent[], next: LiveAgent): LiveAgent {
  const existing = agents.find((agent) => agent.id === next.id);
  return { ...next, feed: existing?.feed ?? [], queued: next.queued ?? [] };
}

/** Applies one numbered change to a snapshot. It never changes the snapshot it is given. */
export function applyMessage(state: Snapshot, message: ServerMessage): Snapshot {
  // Numbers only go up. A message the snapshot already holds is skipped, not applied twice.
  if (message.seq <= state.seq) return state;
  const next: Snapshot = { ...state, seq: message.seq };
  switch (message.type) {
    case 'agent':
      if (!message.agent) return next;
      return { ...next, agents: upsert(state.agents, withFeed(state.agents, message.agent)) };
    case 'agent.remove':
      return {
        ...next,
        agents: state.agents.filter((agent) => agent.id !== message.id),
        projects: state.projects.filter((project) => project.id !== message.id),
      };
    case 'event': {
      const event = message.event;
      if (!event) return next;
      const agents = state.agents.map((agent) =>
        agent.id === event.agentId
          ? { ...agent, feed: [event, ...(agent.feed ?? [])].slice(0, FEED_LIMIT) }
          : agent,
      );
      return { ...next, agents };
    }
    case 'message':
      if (!message.message) return next;
      return {
        ...next,
        messages: [...state.messages, message.message].slice(-MESSAGE_LIMIT),
      };
    case 'log':
      if (!message.log) return next;
      return { ...next, log: upsert(state.log, message.log, true).slice(0, LOG_LIMIT) };
    case 'project':
      if (!message.project) return next;
      return { ...next, projects: upsert(state.projects, message.project) };
    case 'account':
      if (!message.account) return next;
      return { ...next, accounts: upsert(state.accounts, message.account) };
    case 'settings':
      return message.settings ? { ...next, settings: message.settings } : next;
    default:
      return next;
  }
}
