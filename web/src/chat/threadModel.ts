// SPDX-License-Identifier: Apache-2.0
// What a thread shows, worked out from the conversations the page holds. An agent's thread is its
// own conversation. A project's thread is its agents' conversations side by side in time, each
// reply naming who gave it, with a message sent to everyone shown once, as a row of replies.
import type { Ask } from '../data/chatApi.ts';
import type { Thread } from '../data/conversation.ts';
import { stateLabel } from '../format.ts';
import type { ConversationItem, Instruction, LiveAgent } from '../gen/models.ts';

export interface Who {
  id: string;
  name: string;
  hue: string;
}

/** What the message box put round the person's own words, found again so it can be shown apart. */
export interface UserParts {
  body: string;
  plan: boolean;
  files: { name: string; path: string }[];
  context: { who: string; text: string }[];
  handedFrom: string;
}

export const PLAN_PREFIX =
  'Plan first. Write out your plan and wait for my go-ahead before you change anything.\n\n';
const FILES_HEAD = 'Attached files, read them by path:\n';
const HANDED = /^Handed over from ([^\n]+?)(?: \([^)\n]*\))?\.\n/;
const CONTEXT = /^Context, (.+?)'s latest reply:\n((?:> ?.*(?:\n|$))+)$/;
const NO_REPLY = /^(.+?) hasn't replied yet\.$/;

/** Takes the message box's additions off the end of what was sent, and notes what they were. */
export function splitUserText(text: string): UserParts {
  let body = text;
  let plan = false;
  if (body.startsWith(PLAN_PREFIX)) {
    plan = true;
    body = body.slice(PLAN_PREFIX.length);
  }
  const files: UserParts['files'] = [];
  const context: UserParts['context'] = [];
  const segments = body.split('\n\n');
  // The additions come last, one block each, so they are read from the end.
  while (segments.length > 1) {
    const last = segments[segments.length - 1]!;
    if (last.startsWith(FILES_HEAD) && /^- \//m.test(last)) {
      const block: UserParts['files'] = [];
      for (const line of last.slice(FILES_HEAD.length).split('\n')) {
        const path = line.replace(/^- /, '').trim();
        if (path) block.push({ name: path.split(/[\\/]/).pop() ?? path, path });
      }
      files.unshift(...block);
    } else if (CONTEXT.test(last)) {
      const [, who, quoted] = CONTEXT.exec(last)!;
      context.unshift({ who: who!, text: quoted!.replace(/^> ?/gm, '').trimEnd() });
    } else if (NO_REPLY.test(last)) {
      context.unshift({ who: NO_REPLY.exec(last)![1]!, text: '' });
    } else {
      break;
    }
    segments.pop();
  }
  body = segments.join('\n\n');
  const handed = HANDED.exec(body);
  return { body, plan, files, context, handedFrom: handed?.[1] ?? '' };
}

export type Row =
  | {
      kind: 'user';
      key: string;
      time: number;
      seq: number;
      item: ConversationItem;
      who: Who | null;
      parts: UserParts;
    }
  | { kind: 'assistant'; key: string; time: number; seq: number; item: ConversationItem; who: Who }
  | {
      kind: 'tool';
      key: string;
      time: number;
      seq: number;
      item: ConversationItem;
      who: Who;
      /** The approval waiting now is for this call, so it hasn't run. */
      waiting?: boolean;
    }
  | { kind: 'notice'; key: string; time: number; seq: number; item: ConversationItem; who: Who }
  | {
      kind: 'pending';
      key: string;
      time: number;
      seq: number;
      instruction: Instruction;
      who: Who | null;
      opening: boolean;
      parts: UserParts;
    }
  | { kind: 'round'; key: string; time: number; seq: number; ask: Ask; columns: RoundColumn[] };

export type ColumnState = 'waiting' | 'working' | 'replied' | 'gone';

export interface RoundColumn {
  who: Who;
  state: ColumnState;
  /** What the agent has said since it was asked, oldest first, as items so they can be copied. */
  replies: ConversationItem[];
  streaming: boolean;
}

export const whoOf = (agent: Pick<LiveAgent, 'id' | 'name' | 'hue'>): Who => ({
  id: agent.id,
  name: agent.name,
  hue: agent.hue,
});

export interface RowInput {
  mode: 'agent' | 'project';
  agents: LiveAgent[];
  threads: Record<string, Thread>;
  asks?: Ask[];
  opening?: Instruction[];
}

/** How close to the ask a delivered message must be to count as that ask, in milliseconds. */
const ASK_SLACK_MS = 2500;

/** What identifies an ask in the text an agent was sent, which has more added after it. */
const askHead = (ask: Ask) => ask.text.trim().slice(0, 60);

function sentFor(ask: Ask, text: string, time: number): boolean {
  return time >= ask.time - ASK_SLACK_MS && text.includes(askHead(ask));
}

/** The pieces of one ask in one agent's conversation. */
function column(ask: Ask, agent: LiveAgent | undefined, who: Who, items: ConversationItem[]) {
  const at = items.findIndex((item) => item.kind === 'user' && sentFor(ask, item.text, item.time));
  const replies: ConversationItem[] = [];
  const used = new Set<string>();
  if (at >= 0) {
    for (const item of items.slice(at + 1)) {
      if (item.kind === 'user') break;
      if (item.kind === 'assistant' && item.parent === '' && (item.text || item.streaming)) {
        replies.push(item);
        used.add(item.id);
      }
    }
  }
  const waiting = agent?.queued?.some((queued) => sentFor(ask, queued.text, queued.time)) ?? false;
  const streaming = replies.some((item) => item.streaming);
  let state: ColumnState;
  if (!agent) state = replies.length ? 'replied' : 'gone';
  else if (replies.length && !streaming && !agent.working) state = 'replied';
  else if (at < 0 || waiting) state = 'waiting';
  else state = 'working';
  return {
    column: { who, state, replies, streaming } satisfies RoundColumn,
    userId: at >= 0 ? items[at]!.id : '',
    used,
  };
}

/**
 * The id of the call an approval is holding up, or "". Claude Code stops at one call to ask, the
 * newest. It hasn't run, so it isn't "Running". A plan's approval isn't about a call.
 */
export function waitingCall(
  items: readonly ConversationItem[],
  approval: LiveAgent['approval'],
): string {
  if (!approval || approval.type === 'plan') return '';
  return items.findLast((item) => item.tool?.state === 'running' && !item.parent)?.id ?? '';
}

/** The rows of a thread, oldest first, with anything still waiting for delivery at the end. */
export function buildRows(input: RowInput): Row[] {
  const byId = new Map(input.agents.map((agent) => [agent.id, agent]));
  const rows: Row[] = [];
  const hidden = new Set<string>();
  const rounds: Row[] = [];
  const consumedQueue = new Set<string>();
  if (input.mode === 'project') {
    for (const ask of input.asks ?? []) {
      const columns: RoundColumn[] = [];
      for (const asked of ask.agents) {
        const agent = byId.get(asked.id);
        const who = agent ? whoOf(agent) : { id: asked.id, name: asked.name, hue: '#9AA0AE' };
        const items = input.threads[asked.id]?.items ?? [];
        const found = column(ask, agent, who, items);
        columns.push(found.column);
        if (found.userId) hidden.add(found.userId);
        for (const id of found.used) hidden.add(id);
        for (const queued of agent?.queued ?? []) {
          if (sentFor(ask, queued.text, queued.time)) consumedQueue.add(queued.id);
        }
      }
      rounds.push({ kind: 'round', key: `round-${ask.id}`, time: ask.time, seq: 0, ask, columns });
    }
  }
  for (const agent of input.agents) {
    const who = whoOf(agent);
    const items = input.threads[agent.id]?.items ?? [];
    const waiting = waitingCall(items, agent.approval);
    for (const item of items) {
      if (hidden.has(item.id)) continue;
      const base = { key: item.id, time: item.time, seq: item.seq, item };
      switch (item.kind) {
        case 'user':
          rows.push({
            ...base,
            kind: 'user',
            who: input.mode === 'project' ? who : null,
            parts: splitUserText(item.text),
          });
          break;
        case 'assistant':
          if (item.text.trim() || item.streaming) rows.push({ ...base, kind: 'assistant', who });
          break;
        case 'tool':
          if (item.tool) rows.push({ ...base, kind: 'tool', who, waiting: item.id === waiting });
          break;
        default:
          rows.push({ ...base, kind: 'notice', who });
      }
    }
  }
  rows.push(...rounds);
  rows.sort(
    input.mode === 'agent'
      ? (a, b) => a.seq - b.seq
      : (a, b) => a.time - b.time || a.seq - b.seq || (a.key < b.key ? -1 : 1),
  );
  const pending: Row[] = [];
  for (const instruction of input.opening ?? []) {
    pending.push({
      kind: 'pending',
      key: instruction.id,
      time: instruction.time,
      seq: 0,
      instruction,
      who: null,
      opening: true,
      parts: splitUserText(instruction.text),
    });
  }
  for (const agent of input.agents) {
    for (const instruction of agent.queued ?? []) {
      if (consumedQueue.has(instruction.id)) continue;
      pending.push({
        kind: 'pending',
        key: instruction.id,
        time: instruction.time,
        seq: 0,
        instruction,
        who: input.mode === 'project' ? whoOf(agent) : null,
        opening: false,
        parts: splitUserText(instruction.text),
      });
    }
  }
  pending.sort((a, b) => a.time - b.time);
  return [...rows, ...pending];
}

export interface DoingNow {
  text: string;
  /** Working is calm. Waiting is on you. Error is red. */
  tone: 'working' | 'waiting' | 'error';
}

/** What one agent is doing, in a phrase: its state, and the step it is on. */
function doingOf(agent: LiveAgent): DoingNow | null {
  if (agent.state === 'approval') return { text: 'Waiting for your approval', tone: 'waiting' };
  if (agent.question) return { text: 'Asking you a question', tone: 'waiting' };
  if (agent.state === 'error') return { text: agent.error || 'Hit an error', tone: 'error' };
  if (agent.state === 'paused')
    return { text: 'Interrupted. Waiting for you to continue', tone: 'waiting' };
  if (!agent.working) return null;
  const step = agent.feed?.[0]?.summary;
  const label = stateLabel(agent.state);
  return { text: step ? `${label}: ${step}` : label, tone: 'working' };
}

/** What a project's line says of one agent: its state in a word or two, not the step it is on. */
function briefOf(agent: LiveAgent): { text: string; waiting: boolean } | null {
  if (agent.state === 'approval') return { text: 'Waiting for your approval', waiting: true };
  if (agent.question) return { text: 'Asking you a question', waiting: true };
  if (agent.state === 'error') return { text: 'Hit an error', waiting: false };
  if (agent.state === 'paused') return { text: 'Interrupted', waiting: true };
  return agent.working ? { text: stateLabel(agent.state), waiting: false } : null;
}

/**
 * The "what it's doing now" line. For an agent it is its phrase, and it is red for an error. For a
 * project it is each busy agent in a word or two, up to three, and it is never red: an error is in
 * the list beside it, and the thread of the agent that has it.
 */
export function doingNow(agents: LiveAgent[], mode: 'agent' | 'project'): DoingNow | null {
  if (mode === 'agent') return agents[0] ? doingOf(agents[0]) : null;
  const lines: { name: string; text: string; waiting: boolean }[] = [];
  for (const agent of agents) {
    const brief = briefOf(agent);
    if (brief) lines.push({ name: agent.name, ...brief });
  }
  if (!lines.length) return null;
  const shown = lines.slice(0, 3).map((line) => `${line.name}: ${line.text}`);
  if (lines.length > 3) shown.push(`and ${lines.length - 3} more`);
  return {
    text: shown.join(' · '),
    tone: lines.some((line) => line.waiting) ? 'waiting' : 'working',
  };
}
