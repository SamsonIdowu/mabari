// SPDX-License-Identifier: Apache-2.0
// The message box's decisions, apart from the page: what a typed "@" or "/" is asking for, how a
// choice goes into the text, how Up recalls an earlier message, what sending will do and say, and
// what a draft keeps across a reload.
import type { ChatCommand, Saved } from '../data/chatApi.ts';
import type { LiveAgent } from '../gen/models.ts';

export interface Trigger {
  kind: 'at' | 'slash';
  /** What was typed after the mark. */
  query: string;
  /** Where the mark is, and where the caret is: the part to replace. */
  start: number;
  end: number;
}

/**
 * Whether the caret is in a word that starts with "@" or "/". An "@" can start any word, as a file
 * or another agent. A "/" asks for a command, which only runs at the start of a message, so
 * anywhere else it is just a slash in a path.
 */
export function triggerAt(text: string, caret: number): Trigger | null {
  const head = text.slice(0, caret);
  const match = /(^|\s)([@/])([^\s]*)$/.exec(head);
  if (!match) return null;
  const start = head.length - match[3]!.length - 1;
  if (match[2] === '/' && head.slice(0, start).trim() !== '') return null;
  return { kind: match[2] === '@' ? 'at' : 'slash', query: match[3]!, start, end: caret };
}

/** The text with the typed word replaced by a choice, and where the caret goes. */
export function replaceTrigger(text: string, trigger: Trigger, insert: string) {
  const next = text.slice(0, trigger.start) + insert + text.slice(trigger.end);
  return { text: next, caret: trigger.start + insert.length };
}

/** A file written so a space in its name doesn't end the mention. */
export function mentionFile(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

/** The agents whose "@name" is still in the text, by id. Taking the name out takes the mention out. */
export function mentionedIds(text: string, picked: { id: string; name: string }[]): string[] {
  const ids: string[] = [];
  for (const { id, name } of picked) {
    const at = text.indexOf(`@${name}`);
    const end = at + name.length + 1;
    if (at >= 0 && (end >= text.length || /[\s.,;:!?)]/.test(text[end]!)) && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

export interface Suggestion {
  id: string;
  kind: 'agent' | 'file' | 'dir' | 'command' | 'skill' | 'saved';
  /** What is listed: a name or a path. */
  label: string;
  /** A second line: what an agent is doing, or what a command does. */
  detail: string;
  /** What goes into the text. */
  insert: string;
}

const lower = (text: string) => text.toLowerCase();

/** Commands, skills and saved instructions that fit what was typed after the slash. */
export function slashSuggestions(
  commands: ChatCommand[],
  saved: Saved[],
  query: string,
): Suggestion[] {
  const wanted = lower(query);
  const rank = (name: string) => {
    const at = lower(name).indexOf(wanted);
    return at < 0 ? -1 : at === 0 ? 0 : 1;
  };
  const found: { suggestion: Suggestion; rank: number }[] = [];
  for (const command of commands) {
    const fit = rank(command.name);
    if (fit < 0) continue;
    found.push({
      rank: fit,
      suggestion: {
        id: `${command.kind}:${command.scope}:${command.name}`,
        kind: command.kind,
        label: `/${command.name}`,
        detail: command.description || (command.kind === 'skill' ? 'Skill' : 'Command'),
        insert: `/${command.name} `,
      },
    });
  }
  for (const item of saved) {
    const fit = rank(item.name);
    if (fit < 0) continue;
    found.push({
      rank: fit,
      suggestion: {
        id: `saved:${item.id}`,
        kind: 'saved',
        label: item.name,
        detail: item.text.replace(/\s+/g, ' ').slice(0, 100),
        insert: item.text,
      },
    });
  }
  return found
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.suggestion)
    .slice(0, 12);
}

/** Other agents that fit what was typed after the "@", ones that need you not first: just by name. */
export function agentSuggestions(
  agents: Pick<LiveAgent, 'id' | 'name' | 'state' | 'leadId' | 'leaving'>[],
  query: string,
  selfId: string,
): Suggestion[] {
  const wanted = lower(query);
  return agents
    .filter((agent) => agent.id !== selfId && !agent.leadId && !agent.leaving)
    .filter((agent) => lower(agent.name).includes(wanted))
    .sort((a, b) => {
      const first =
        Number(!lower(a.name).startsWith(wanted)) - Number(!lower(b.name).startsWith(wanted));
      return first || a.name.localeCompare(b.name);
    })
    .slice(0, 5)
    .map((agent) => ({
      id: `agent:${agent.id}`,
      kind: 'agent',
      label: `@${agent.name}`,
      detail: `Add ${agent.name}'s latest reply`,
      insert: `@${agent.name} `,
    }));
}

export interface RecallState {
  /** Which earlier message is showing, or null when the box holds the person's own text. */
  cursor: number | null;
  /** What was in the box before recalling, to come back to. */
  draft: string;
}

/**
 * Up and Down through earlier messages, oldest first in `history`. Up starts only from an empty
 * box, so it never takes the arrow from someone moving about in what they are writing. Down past
 * the newest brings back what was being written. Returns null when the key isn't for recall.
 */
export function recall(
  history: string[],
  state: RecallState,
  key: 'ArrowUp' | 'ArrowDown',
  current: string,
): { text: string; state: RecallState } | null {
  if (key === 'ArrowUp') {
    if (!history.length || (state.cursor === null && current !== '')) return null;
    const cursor = state.cursor === null ? history.length - 1 : Math.max(0, state.cursor - 1);
    return {
      text: history[cursor]!,
      state: { cursor, draft: state.cursor === null ? current : state.draft },
    };
  }
  if (state.cursor === null) return null;
  if (state.cursor >= history.length - 1) {
    return { text: state.draft, state: { cursor: null, draft: '' } };
  }
  return {
    text: history[state.cursor + 1]!,
    state: { cursor: state.cursor + 1, draft: state.draft },
  };
}

/** An earlier message in the list, once: the newest copy of each, at most `limit`, oldest first. */
export function historyOf(texts: string[], limit = 50): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (let at = texts.length - 1; at >= 0 && kept.length < limit; at--) {
    const text = texts[at]!.trim();
    if (text && !seen.has(text)) {
      seen.add(text);
      kept.unshift(text);
    }
  }
  return kept;
}

export type DeliveryKind = 'now' | 'checkpoint' | 'later' | 'waits';

export interface Delivery {
  kind: DeliveryKind;
  /** Said plainly under the box. */
  note: string;
  /** What the main button says: it queues, or it sends. */
  button: string;
}

const busyNow = (agent: Pick<LiveAgent, 'working' | 'state'>) =>
  agent.working && agent.state !== 'approval';

/** What sending to this agent will do, in the words the box uses, so nobody has to guess. */
export function deliveryOf(
  agent: Pick<
    LiveAgent,
    'name' | 'provider' | 'account' | 'working' | 'state' | 'approval' | 'question' | 'session'
  >,
): Delivery {
  const name = agent.name;
  if (agent.approval || agent.question || agent.state === 'approval') {
    return {
      kind: 'waits',
      note: `${name} is waiting for you. This is queued for its next checkpoint.`,
      button: 'Queue',
    };
  }
  if (agent.provider === 'claude' && busyNow(agent)) {
    return {
      kind: 'checkpoint',
      note: `${name} is working. This is queued and read at its next checkpoint.`,
      button: 'Queue',
    };
  }
  if (agent.provider === 'claude' && agent.session?.status === 'elsewhere' && !busyNow(agent)) {
    return {
      kind: 'later',
      note: `${name}'s session is open somewhere else. This is queued until it next runs a step.`,
      button: 'Queue',
    };
  }
  if (agent.account === 'hub') {
    return {
      kind: 'later',
      note: `${name} reads this the next time its app asks for instructions.`,
      button: 'Queue',
    };
  }
  return { kind: 'now', note: `This goes to ${name} straight away.`, button: 'Send' };
}

/** Whether the box can interrupt this agent and send at once, which only a session Mabari runs allows. */
export function canSendNow(
  agent: Pick<
    LiveAgent,
    'source' | 'working' | 'state' | 'approval' | 'question' | 'session' | 'leadId'
  >,
): boolean {
  return (
    agent.source === 'claude' &&
    agent.session?.status === 'running' &&
    !agent.leadId &&
    agent.working &&
    agent.state !== 'approval' &&
    !agent.approval &&
    !agent.question
  );
}

/** Whether the model can be switched with the next message, and if not, why. */
export function modelSwitch(
  agent: Pick<
    LiveAgent,
    'name' | 'source' | 'working' | 'state' | 'approval' | 'question' | 'session' | 'leadId'
  >,
): { can: boolean; reason: string } {
  if (agent.source === 'sim') return { can: true, reason: '' };
  if (
    agent.source === 'claude' &&
    agent.session &&
    agent.session.status !== 'elsewhere' &&
    !agent.leadId
  ) {
    if (agent.working || agent.approval || agent.question || agent.state === 'approval') {
      return {
        can: false,
        reason: `${agent.name} is working. Change its model once it has finished.`,
      };
    }
    return { can: true, reason: '' };
  }
  return { can: false, reason: `${agent.name}'s model is fixed when its session starts.` };
}

/** What the Plan first switch promises, which depends on whether the session can be held to it. */
export function planNote(
  agent: Pick<
    LiveAgent,
    'source' | 'working' | 'state' | 'approval' | 'question' | 'session' | 'leadId'
  > | null,
): string {
  const held =
    agent !== null &&
    agent.source === 'claude' &&
    agent.session?.status === 'running' &&
    !agent.leadId &&
    !agent.working &&
    !agent.approval &&
    !agent.question;
  return held
    ? 'Claude Code holds it to a plan. Nothing changes until you approve.'
    : 'Asks for a plan and a go-ahead first. This is a request, not a lock.';
}

export interface Draft {
  text: string;
  plan: boolean;
  files: { id: string; name: string; path: string; size: number }[];
}

export const EMPTY_DRAFT: Draft = { text: '', plan: false, files: [] };
const DRAFTS_KEY = 'mabari.drafts';
const DRAFTS_KEPT = 40;

/** Reads the drafts back, keeping only values of the right shape. */
export function parseDrafts(raw: string | null): Record<string, Draft> {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!data || typeof data !== 'object') return {};
  const drafts: Record<string, Draft> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const files = Array.isArray(record.files)
      ? record.files.flatMap((file: unknown) => {
          const entry = file as Record<string, unknown> | null;
          return entry &&
            typeof entry.id === 'string' &&
            typeof entry.name === 'string' &&
            typeof entry.path === 'string'
            ? [{ id: entry.id, name: entry.name, path: entry.path, size: Number(entry.size) || 0 }]
            : [];
        })
      : [];
    drafts[key] = {
      text: typeof record.text === 'string' ? record.text : '',
      plan: record.plan === true,
      files,
    };
  }
  return drafts;
}

const isEmpty = (draft: Draft) => !draft.text && !draft.plan && draft.files.length === 0;

export function loadDraft(key: string): Draft {
  try {
    return parseDrafts(window.localStorage.getItem(DRAFTS_KEY))[key] ?? EMPTY_DRAFT;
  } catch {
    return EMPTY_DRAFT;
  }
}

/** Keeps a draft, or forgets it when there is nothing in it. The oldest go past a few dozen. */
export function saveDraft(key: string, draft: Draft): void {
  try {
    const drafts = parseDrafts(window.localStorage.getItem(DRAFTS_KEY));
    delete drafts[key];
    if (!isEmpty(draft)) drafts[key] = draft;
    const keys = Object.keys(drafts);
    for (const old of keys.slice(0, Math.max(0, keys.length - DRAFTS_KEPT))) delete drafts[old];
    window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // Drafts are a convenience: without storage they last until the page is left.
  }
}
