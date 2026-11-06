// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { Ask } from '../data/chatApi.ts';
import type { Thread } from '../data/conversation.ts';
import type { ConversationItem, Instruction, LiveAgent } from '../gen/models.ts';
import { buildRows, doingNow, PLAN_PREFIX, splitUserText } from './threadModel.ts';

const agent = (overrides: Partial<LiveAgent> = {}) =>
  ({
    id: 'a',
    name: 'Ada',
    provider: 'claude',
    state: 'idle',
    working: false,
    error: '',
    hue: '#7FA8FF',
    queued: [],
    approval: null,
    question: null,
    feed: [],
    ...overrides,
  }) as LiveAgent;

let counter = 0;
const item = (overrides: Partial<ConversationItem>): ConversationItem => ({
  id: `i${++counter}`,
  agentId: 'a',
  seq: counter,
  time: 1000 + counter,
  kind: 'assistant',
  text: 'hello',
  streaming: false,
  tool: null,
  from: '',
  parent: '',
  clipped: false,
  ...overrides,
});

const thread = (...items: ConversationItem[]): Thread => ({ items, hasMore: false, loaded: true });

const queued = (id: string, text: string, time: number): Instruction =>
  ({
    id,
    text,
    time,
    status: 'waiting_for_checkpoint',
    agentId: 'a',
    mode: 'instruct',
    logId: '',
    reply: '',
    repliedAt: 0,
  }) as Instruction;

describe('splitUserText', () => {
  it('leaves what a person typed alone', () => {
    expect(splitUserText('Fix the header')).toEqual({
      body: 'Fix the header',
      plan: false,
      files: [],
      context: [],
      handedFrom: '',
    });
  });

  it('finds the plan request, the files and the quoted replies the message box added', () => {
    const sent =
      PLAN_PREFIX +
      "Use what Atlas found\n\nContext, Atlas's latest reply:\n> It is in src/a.ts\n> \n> And b.ts\n\nMori hasn't replied yet.\n\nAttached files, read them by path:\n- /data/attachments/ab12/notes.txt\n- /data/attachments/cd34/shot one.png";
    const parts = splitUserText(sent);
    expect(parts.plan).toBe(true);
    expect(parts.body).toBe('Use what Atlas found');
    expect(parts.context).toEqual([
      { who: 'Atlas', text: 'It is in src/a.ts\n\nAnd b.ts' },
      { who: 'Mori', text: '' },
    ]);
    expect(parts.files).toEqual([
      { name: 'notes.txt', path: '/data/attachments/ab12/notes.txt' },
      { name: 'shot one.png', path: '/data/attachments/cd34/shot one.png' },
    ]);
  });

  it('does not take text for an addition unless it has the whole shape', () => {
    const typed = 'Please read:\n\nAttached files are great.\n\nContext, thanks.';
    expect(splitUserText(typed).body).toBe(typed);
    expect(splitUserText('a\n\nAttached files, read them by path:\nnothing').files).toEqual([]);
  });

  it('notes who a handed over reply came from', () => {
    const handed =
      'Handed over from Rune (Docs site).\n\nIt was answering:\n> fix it\n\nIts reply:\n> done';
    expect(splitUserText(handed).handedFrom).toBe('Rune');
    expect(splitUserText('Handed over from Rune.\nrest').handedFrom).toBe('Rune');
  });
});

describe('an agent thread', () => {
  it('follows the order the server numbered it in, whatever the clock said', () => {
    const rows = buildRows({
      mode: 'agent',
      agents: [agent()],
      threads: {
        a: thread(
          item({ seq: 1, time: 5000, kind: 'user', text: 'one' }),
          item({ seq: 2, time: 4000, kind: 'assistant', text: 'two' }),
        ),
      },
    });
    expect(rows.map((row) => row.kind)).toEqual(['user', 'assistant']);
  });

  it('leaves out an assistant item with nothing in it, unless it is still arriving', () => {
    const rows = buildRows({
      mode: 'agent',
      agents: [agent()],
      threads: {
        a: thread(
          item({ kind: 'assistant', text: '  ' }),
          item({ kind: 'assistant', text: '', streaming: true }),
          item({
            kind: 'tool',
            text: '',
            tool: { name: 'Read', summary: 'Read a.ts', input: '', output: '', state: 'done' },
          }),
          item({ kind: 'notice', text: 'Session started.' }),
        ),
      },
    });
    expect(rows.map((row) => row.kind)).toEqual(['assistant', 'tool', 'notice']);
  });

  it('puts what is waiting to be delivered last, as the person wrote it', () => {
    const rows = buildRows({
      mode: 'agent',
      agents: [agent({ queued: [queued('q1', 'later please', 9)] })],
      threads: { a: thread(item({ kind: 'assistant', text: 'working' })) },
    });
    expect(rows.map((row) => row.kind)).toEqual(['assistant', 'pending']);
  });
});

describe('a project thread', () => {
  const atlas = agent({ id: 'a1', name: 'Atlas' });
  const mori = agent({ id: 'a2', name: 'Mori', hue: '#F00' });

  it('merges the agents by time and names who each reply came from', () => {
    const rows = buildRows({
      mode: 'project',
      agents: [atlas, mori],
      threads: {
        a1: thread(
          item({ agentId: 'a1', seq: 1, time: 100, kind: 'user', text: 'go' }),
          item({ agentId: 'a1', seq: 2, time: 300, text: 'atlas says' }),
        ),
        a2: thread(
          item({ agentId: 'a2', seq: 1, time: 200, kind: 'assistant', text: 'mori says' }),
        ),
      },
    });
    expect(
      rows.map((row) =>
        row.kind === 'user' || row.kind === 'assistant'
          ? `${row.who?.name}:${row.item.text}`
          : row.kind,
      ),
    ).toEqual(['Atlas:go', 'Mori:mori says', 'Atlas:atlas says']);
  });

  const ask: Ask = {
    id: 'k1',
    projectId: 'p',
    text: 'status in one line?',
    time: 1000,
    agents: [
      { id: 'a1', name: 'Atlas' },
      { id: 'a2', name: 'Mori' },
      { id: 'a9', name: 'Left' },
    ],
  };

  it('shows a message to everyone once, with each agent’s reply beside the others', () => {
    const threads = {
      a1: thread(
        item({ agentId: 'a1', seq: 1, time: 1010, kind: 'user', text: 'status in one line?' }),
        item({ agentId: 'a1', seq: 2, time: 1500, kind: 'assistant', text: 'Atlas: on track' }),
      ),
      a2: thread(
        item({
          agentId: 'a2',
          seq: 1,
          time: 1020,
          kind: 'user',
          text: 'status in one line?\n\nAttached files, read them by path:\n- /x/y.txt',
        }),
      ),
    };
    const rows = buildRows({ mode: 'project', agents: [atlas, mori], threads, asks: [ask] });
    expect(rows.map((row) => row.kind)).toEqual(['round']);
    const round = rows[0]!;
    if (round.kind !== 'round') throw new Error('not a round');
    const [first, second, third] = round.columns;
    expect(first).toMatchObject({ state: 'replied', who: { name: 'Atlas' } });
    expect(first!.replies.map((reply) => reply.text)).toEqual(['Atlas: on track']);
    // Mori has the message and hasn't answered: it is working on it.
    expect(second).toMatchObject({ state: 'working' });
    // An agent that has left is named, and says nothing.
    expect(third).toMatchObject({ state: 'gone', who: { name: 'Left' } });
  });

  it('says an agent is waiting while the message sits in its queue, and shows it once', () => {
    const waiting = agent({
      id: 'a2',
      name: 'Mori',
      queued: [queued('q9', 'status in one line?', 1030)],
    });
    const rows = buildRows({
      mode: 'project',
      agents: [atlas, waiting],
      threads: { a1: thread(), a2: thread() },
      asks: [{ ...ask, agents: ask.agents.slice(0, 2) }],
    });
    expect(rows.map((row) => row.kind)).toEqual(['round']);
    const round = rows[0]!;
    if (round.kind !== 'round') throw new Error('not a round');
    expect(round.columns.map((column) => column.state)).toEqual(['waiting', 'waiting']);
  });

  it('does not take a later, different message for the ask', () => {
    const threads = {
      a1: thread(item({ agentId: 'a1', seq: 1, time: 5000, kind: 'user', text: 'something else' })),
      a2: thread(),
    };
    const rows = buildRows({ mode: 'project', agents: [atlas, mori], threads, asks: [ask] });
    expect(rows.map((row) => row.kind).sort()).toEqual(['round', 'user']);
  });

  it('shows prompts waiting for a session Mabari opened', () => {
    const rows = buildRows({
      mode: 'project',
      agents: [atlas],
      threads: { a1: thread() },
      opening: [queued('o1', '/ux-audit', 5)],
    });
    expect(rows[0]).toMatchObject({ kind: 'pending', opening: true });
  });
});

describe('what it is doing now', () => {
  it('says nothing for an agent at rest', () => {
    expect(doingNow([agent()], 'agent')).toBeNull();
    expect(doingNow([agent({ state: 'done' })], 'agent')).toBeNull();
  });

  it('names the step an agent is on', () => {
    const working = agent({
      state: 'reading',
      working: true,
      feed: [{ summary: 'Read src/app.ts' } as never],
    });
    expect(doingNow([working], 'agent')).toEqual({
      text: 'Reading files: Read src/app.ts',
      tone: 'working',
    });
    expect(doingNow([agent({ state: 'thinking', working: true })], 'agent')).toEqual({
      text: 'Thinking',
      tone: 'working',
    });
  });

  it('says plainly what waits on you, and shows an error in red', () => {
    expect(doingNow([agent({ state: 'approval' })], 'agent')).toEqual({
      text: 'Waiting for your approval',
      tone: 'waiting',
    });
    expect(doingNow([agent({ question: {} as never })], 'agent')?.tone).toBe('waiting');
    expect(doingNow([agent({ state: 'error', error: 'It broke' })], 'agent')).toEqual({
      text: 'It broke',
      tone: 'error',
    });
  });

  it('sums up a project in a few words', () => {
    const agents = ['A', 'B', 'C', 'D', 'E'].map((name) =>
      agent({ id: name, name, state: 'thinking', working: true }),
    );
    const line = doingNow([...agents, agent({ id: 'z', name: 'Z' })], 'project');
    expect(line?.text).toBe('A: Thinking · B: Thinking · C: Thinking · and 2 more');
    expect(doingNow([agent()], 'project')).toBeNull();
  });
});
