// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCommand, Saved } from '../data/chatApi.ts';
import {
  agentSuggestions,
  canSendNow,
  deliveryOf,
  historyOf,
  loadDraft,
  mentionedIds,
  mentionFile,
  modelSwitch,
  parseDrafts,
  planNote,
  recall,
  replaceTrigger,
  saveDraft,
  slashSuggestions,
  triggerAt,
} from './composerModel.ts';

describe('triggerAt', () => {
  it.each([
    ['look at @src/ap', 15, { kind: 'at', query: 'src/ap', start: 8, end: 15 }],
    ['@', 1, { kind: 'at', query: '', start: 0, end: 1 }],
    ['ask @At', 7, { kind: 'at', query: 'At', start: 4, end: 7 }],
    ['/ux-au', 6, { kind: 'slash', query: 'ux-au', start: 0, end: 6 }],
    ['  /rev', 6, { kind: 'slash', query: 'rev', start: 2, end: 6 }],
  ])('%j with the caret at %i', (text, caret, want) => {
    expect(triggerAt(text, caret)).toEqual(want);
  });

  it.each([
    ['fix the file at path/to/a.ts', 28],
    ['run it, then /clear', 19],
    ['email me@example.com', 20],
    ['no marks here', 13],
    ['@done and moved on', 18],
    ['/command with args', 18],
  ])('finds nothing in %j', (text, caret) => {
    expect(triggerAt(text, caret)).toBeNull();
  });

  it('looks only up to the caret', () => {
    expect(triggerAt('hello @world and more', 9)).toMatchObject({ query: 'wo' });
  });

  it('puts a choice in place of the typed word and moves the caret after it', () => {
    const trigger = triggerAt('check @src/ap now', 13)!;
    expect(replaceTrigger('check @src/ap now', trigger, '@src/app.ts ')).toEqual({
      text: 'check @src/app.ts  now',
      caret: 18,
    });
  });
});

describe('mentions', () => {
  it('quotes a file whose name has a space', () => {
    expect(mentionFile('src/app.ts')).toBe('@src/app.ts');
    expect(mentionFile('my notes/a b.txt')).toBe('@"my notes/a b.txt"');
  });

  it('keeps an agent mention only while its name is still in the text', () => {
    const picked = [
      { id: 'a1', name: 'Atlas' },
      { id: 'a2', name: 'Atlas scribe' },
      { id: 'a3', name: 'Mori' },
    ];
    expect(mentionedIds('use @Atlas for this', picked)).toEqual(['a1']);
    expect(mentionedIds('use @Atlas scribe, please', picked)).toEqual(['a1', 'a2']);
    expect(mentionedIds('use Atlas for this', picked)).toEqual([]);
    expect(mentionedIds('@Moriarty', picked)).toEqual([]);
    expect(mentionedIds('@Mori.', picked)).toEqual(['a3']);
  });
});

describe('suggestions', () => {
  const commands: ChatCommand[] = [
    { name: 'ux-audit', kind: 'command', scope: 'folder', description: 'Audit the UX' },
    { name: 'review', kind: 'command', scope: 'account', description: '' },
    { name: 'tidy', kind: 'skill', scope: 'account', description: 'Tidy up' },
  ];
  const saved: Saved[] = [{ id: 's1', name: 'Review the diff', text: 'Review the diff\nand list risks', created: 1 }];

  it('lists commands, skills and saved instructions that fit, names that start with it first', () => {
    const all = slashSuggestions(commands, saved, '');
    expect(all.map((entry) => entry.kind)).toEqual(['command', 'command', 'skill', 'saved']);
    const some = slashSuggestions(commands, saved, 'rev');
    expect(some.map((entry) => entry.label)).toEqual(['/review', 'Review the diff']);
    expect(slashSuggestions(commands, saved, 'ud').map((entry) => entry.label)).toEqual(['/ux-audit']);
    expect(slashSuggestions(commands, saved, 'zzz')).toEqual([]);
  });

  it('inserts a command with a space after, and a saved instruction as its own words', () => {
    const [command] = slashSuggestions(commands, saved, 'ux');
    expect(command).toMatchObject({ insert: '/ux-audit ', detail: 'Audit the UX' });
    const [, , , item] = slashSuggestions(commands, saved, '');
    expect(item).toMatchObject({ insert: 'Review the diff\nand list risks', detail: 'Review the diff and list risks' });
    // A command with no description still says what it is.
    expect(slashSuggestions(commands, saved, 'review')[0]!.detail).toBe('Command');
  });

  it('offers other agents, never the one being talked to, a subagent or one leaving', () => {
    const agents = [
      { id: 'a1', name: 'Atlas', state: 'idle', leadId: null, leaving: false },
      { id: 'a2', name: 'Atlas scribe', state: 'idle', leadId: 'a1', leaving: false },
      { id: 'a3', name: 'Mori', state: 'idle', leadId: null, leaving: false },
      { id: 'a4', name: 'Moss', state: 'idle', leadId: null, leaving: true },
      { id: 'a5', name: 'Tomi', state: 'idle', leadId: null, leaving: false },
    ] as never[];
    expect(agentSuggestions(agents, '', 'a1').map((entry) => entry.label)).toEqual(['@Mori', '@Tomi']);
    expect(agentSuggestions(agents, 'mo', 'a1').map((entry) => entry.label)).toEqual(['@Mori']);
    expect(agentSuggestions(agents, 'o', 'a1').map((entry) => entry.label)).toEqual(['@Mori', '@Tomi']);
  });
});

describe('recalling earlier messages', () => {
  const history = ['first', 'second', 'third'];
  const fresh = { cursor: null, draft: '' };

  it('goes back from an empty box, one message at a time, and stops at the oldest', () => {
    const one = recall(history, fresh, 'ArrowUp', '')!;
    expect(one.text).toBe('third');
    const two = recall(history, one.state, 'ArrowUp', one.text)!;
    expect(two.text).toBe('second');
    const three = recall(history, two.state, 'ArrowUp', two.text)!;
    const four = recall(history, three.state, 'ArrowUp', three.text)!;
    expect([three.text, four.text]).toEqual(['first', 'first']);
  });

  it('comes forward again and ends on what was being written', () => {
    const back = recall(history, recall(history, fresh, 'ArrowUp', 'half a thou')?.state ?? fresh, 'ArrowUp', '');
    // Up never starts over text being written.
    expect(recall(history, fresh, 'ArrowUp', 'half a thou')).toBeNull();
    expect(back).not.toBeNull();
    const first = recall(history, fresh, 'ArrowUp', '')!;
    const second = recall(history, first.state, 'ArrowUp', first.text)!;
    const forward = recall(history, second.state, 'ArrowDown', second.text)!;
    expect(forward.text).toBe('third');
    const end = recall(history, forward.state, 'ArrowDown', forward.text)!;
    expect(end).toEqual({ text: '', state: { cursor: null, draft: '' } });
  });

  it('keeps the draft it started from', () => {
    const first = recall(history, { cursor: null, draft: '' }, 'ArrowUp', '')!;
    expect(first.state.draft).toBe('');
    expect(recall(history, fresh, 'ArrowDown', '')).toBeNull();
    expect(recall([], fresh, 'ArrowUp', '')).toBeNull();
  });

  it('lists each earlier message once, newest copy, oldest first', () => {
    expect(historyOf(['a', 'b', ' a ', '', 'c'])).toEqual(['b', 'a', 'c']);
    expect(historyOf(['a', 'b', 'c'], 2)).toEqual(['b', 'c']);
  });
});

describe('what sending will do', () => {
  const agent = (overrides: object = {}) =>
    ({ name: 'Ada', provider: 'claude', account: 'claude_code', working: false, state: 'idle', approval: null, question: null, session: null, source: 'claude', leadId: null, ...overrides }) as never;

  it('says an idle agent takes it at once, and a working Claude agent queues it', () => {
    expect(deliveryOf(agent())).toMatchObject({ kind: 'now', button: 'Send', note: 'This goes to Ada straight away.' });
    expect(deliveryOf(agent({ working: true, state: 'editing' }))).toMatchObject({ kind: 'checkpoint', button: 'Queue' });
    // Another AI takes a message while it works.
    expect(deliveryOf(agent({ provider: 'openai', account: 'codex', working: true, state: 'editing' })).kind).toBe('now');
  });

  it('says an agent waiting on you queues it, however it is run', () => {
    expect(deliveryOf(agent({ state: 'approval', working: false })).kind).toBe('waits');
    expect(deliveryOf(agent({ question: {} })).kind).toBe('waits');
    expect(deliveryOf(agent({ provider: 'openai', account: 'codex', approval: {} })).note).toContain('waiting for you');
  });

  it('says a session open elsewhere waits until it runs, and a hub agent until its app asks', () => {
    expect(deliveryOf(agent({ session: { status: 'elsewhere' } })).kind).toBe('later');
    expect(deliveryOf(agent({ provider: 'custom', account: 'hub' })).note).toContain('its app asks');
  });

  it('offers to interrupt and send only to a working session Mabari runs', () => {
    const running = { session: { status: 'running' }, working: true, state: 'editing' };
    expect(canSendNow(agent(running))).toBe(true);
    expect(canSendNow(agent({ ...running, session: { status: 'elsewhere' } }))).toBe(false);
    expect(canSendNow(agent({ ...running, working: false }))).toBe(false);
    expect(canSendNow(agent({ ...running, state: 'approval', approval: {} }))).toBe(false);
    expect(canSendNow(agent({ ...running, question: {} }))).toBe(false);
    expect(canSendNow(agent({ ...running, source: 'sim' }))).toBe(false);
  });

  it('lets the model change only where that is true, and says why not', () => {
    expect(modelSwitch(agent({ source: 'sim' })).can).toBe(true);
    expect(modelSwitch(agent({ session: { status: 'running' } })).can).toBe(true);
    expect(modelSwitch(agent({ session: { status: 'resumable' } })).can).toBe(true);
    expect(modelSwitch(agent({ session: { status: 'running' }, working: true }))).toEqual({
      can: false,
      reason: 'Ada is working. Change its model once it has finished.',
    });
    expect(modelSwitch(agent({ session: { status: 'elsewhere' } }))).toEqual({
      can: false,
      reason: "Ada's model is fixed when its session starts.",
    });
    expect(modelSwitch(agent({ source: 'codex', provider: 'openai' })).can).toBe(false);
  });

  it('promises a plan only as strongly as it can hold the agent to it', () => {
    expect(planNote(agent({ session: { status: 'running' } }))).toContain('holds it to a plan');
    expect(planNote(agent({ session: { status: 'running' }, working: true }))).toContain('request, not a lock');
    expect(planNote(agent({ source: 'sim' }))).toContain('request, not a lock');
    expect(planNote(null)).toContain('request, not a lock');
  });
});

describe('drafts', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keep the text, the plan switch and the files, for each conversation', () => {
    const file = { id: 'ab12', name: 'a.txt', path: '/d/ab12/a.txt', size: 3 };
    saveDraft('agent:1', { text: 'half written', plan: true, files: [file] });
    saveDraft('project:2', { text: 'another', plan: false, files: [] });
    expect(loadDraft('agent:1')).toEqual({ text: 'half written', plan: true, files: [file] });
    expect(loadDraft('project:2').text).toBe('another');
    expect(loadDraft('agent:9')).toEqual({ text: '', plan: false, files: [] });
  });

  it('are forgotten once there is nothing in them', () => {
    saveDraft('agent:1', { text: 'x', plan: false, files: [] });
    saveDraft('agent:1', { text: '', plan: false, files: [] });
    expect(window.localStorage.getItem('mabari.drafts')).toBe('{}');
  });

  it('keep only the newest few dozen', () => {
    for (let i = 0; i < 60; i++) saveDraft(`agent:${i}`, { text: `t${i}`, plan: false, files: [] });
    expect(Object.keys(parseDrafts(window.localStorage.getItem('mabari.drafts')))).toHaveLength(40);
    expect(loadDraft('agent:59').text).toBe('t59');
    expect(loadDraft('agent:0').text).toBe('');
  });

  it('read back only what has the right shape', () => {
    expect(parseDrafts('not json')).toEqual({});
    expect(parseDrafts('[1,2]')).toEqual({});
    expect(parseDrafts(JSON.stringify({ a: { text: 5, plan: 'yes', files: [{ id: 1 }, { id: 'x', name: 'n', path: 'p' }] }, b: 7 }))).toEqual({
      a: { text: '', plan: false, files: [{ id: 'x', name: 'n', path: 'p', size: 0 }] },
    });
    expect(parseDrafts(null)).toEqual({});
  });
});
