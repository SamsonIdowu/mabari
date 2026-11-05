// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { AgentDef, LiveAgent } from '../gen/models.ts';
import {
  agentsHere,
  FLOOR_LIST_MIN_WIDTH,
  floorCounts,
  floorGroups,
  floorListShown,
  groupOf,
} from './floorList.ts';
import { needsTone, type OfficeFilters } from './uiStore.ts';

const agent = (overrides: Partial<LiveAgent> = {}) =>
  ({
    id: 'a',
    name: 'Ada',
    projectId: 'docs',
    provider: 'claude',
    model: 'claude-sonnet-4-5',
    state: 'editing',
    task: 'Fix the login page',
    error: '',
    hue: '#7FA8FF',
    leadId: null,
    desk: 0,
    defId: '',
    workflow: false,
    folder: '/work/site',
    leaving: false,
    working: true,
    queued: [],
    approval: null,
    ...overrides,
  }) as LiveAgent;

const def = (overrides: Partial<AgentDef> = {}) =>
  ({
    id: 'account:reader',
    name: 'reader',
    kind: 'claude',
    color: '#B58CFF',
    enabled: true,
    system: false,
    ...overrides,
  }) as AgentDef;

const filters = (overrides: Partial<OfficeFilters> = {}): OfficeFilters => ({
  project: 'all',
  provider: 'all',
  model: 'all',
  status: 'all',
  team: null,
  ...overrides,
});

const projects = [{ id: 'docs', name: 'Docs site', color: '#33AA77' }];

const names = (groups: ReturnType<typeof floorGroups>) =>
  Object.fromEntries(groups.map((group) => [group.id, group.entries.map((entry) => entry.name)]));

describe('floorGroups', () => {
  it('puts those who need you first, then the desks, then the lounge', () => {
    const agents = [
      agent({ id: 'w', name: 'Wren', state: 'editing' }),
      agent({ id: 'e', name: 'Ezra', state: 'error', error: 'Tests failed' }),
      agent({ id: 'i', name: 'Ivy', state: 'idle', working: false }),
      agent({ id: 'p', name: 'Pax', state: 'approval' }),
      agent({ id: 'b', name: 'Bo', state: 'thinking' }),
    ];
    const groups = floorGroups({ agents, defs: [def()], projects }, filters());
    expect(groups.map((group) => group.label)).toEqual(['Needs you', 'Working', 'Lounge']);
    expect(names(groups)).toEqual({
      needs: ['Ezra', 'Pax'],
      working: ['Bo', 'Wren'],
      lounge: ['Ivy', 'reader'],
    });
  });

  it('lists an agent asking a question under Needs you, calmly', () => {
    const question = {
      id: 'q1',
      agentId: 'a',
      time: 0,
      items: [{ question: 'Which branch?', header: 'Branch', options: [], multiSelect: false }],
    };
    const agents = [
      agent({ id: 'a', name: 'Ada', state: 'thinking', question }),
      agent({ id: 'p', name: 'Pax', state: 'approval' }),
    ];
    const [needs] = floorGroups({ agents, defs: [], projects }, filters());
    const rows = needs!.entries.flatMap((entry) => (entry.kind === 'agent' ? [entry] : []));
    expect(rows.map((row) => [row.name, row.detail, row.red])).toEqual([
      ['Ada', 'Asking you · Which branch?', false],
      ['Pax', 'Needs approval · Fix the login page', true],
    ]);
  });

  it('lists a queued instruction in its own amber group, not under Needs you', () => {
    const queued = [{ id: 'i1', text: 'Add a test', time: 0 }] as LiveAgent['queued'];
    const agents = [
      agent({ id: 'q', name: 'Quill', state: 'editing', queued }),
      agent({ id: 'p', name: 'Pax', state: 'approval' }),
    ];
    const groups = floorGroups({ agents, defs: [], projects }, filters());
    expect(groups.map((group) => group.label)).toEqual(['Needs you', 'Queued']);
    expect(names(groups)).toEqual({ needs: ['Pax'], queued: ['Quill'] });
    const row = groups[1]!.entries[0]!;
    expect(row.kind === 'agent' && [row.detail, row.red, row.amber]).toEqual([
      '1 instruction queued',
      false,
      true,
    ]);
  });

  it('keeps an agent with an approval under Needs you even with an instruction queued', () => {
    const queued = [{ id: 'i1', text: 'Add a test', time: 0 }] as LiveAgent['queued'];
    const agents = [agent({ id: 'p', name: 'Pax', state: 'approval', queued })];
    expect(names(floorGroups({ agents, defs: [], projects }, filters()))).toEqual({
      needs: ['Pax'],
    });
  });

  it('colours the count of those who need you red for approvals and errors, calm for questions', () => {
    const question = { id: 'q1', agentId: 'a', time: 0, items: [] };
    expect(needsTone([agent({ state: 'thinking', question })])).toBe('calm');
    expect(needsTone([agent({ state: 'thinking', question }), agent({ state: 'error' })])).toBe(
      'red',
    );
  });

  it('puts finished agents in their own group, not under Working', () => {
    const agents = [
      agent({ id: 'w', name: 'Wren', state: 'editing' }),
      agent({ id: 'd', name: 'Dot', state: 'done', working: false, task: 'Update the README' }),
      agent({ id: 'p', name: 'Pip', state: 'paused', working: false }),
      agent({ id: 'c', name: 'Cal', state: 'idle', working: false, workflow: true }),
    ];
    const groups = floorGroups({ agents, defs: [], projects }, filters());
    expect(groups.map((group) => group.label)).toEqual(['Working', 'Interrupted', 'Done']);
    expect(names(groups)).toEqual({
      working: ['Wren'],
      interrupted: ['Pip'],
      done: ['Cal', 'Dot'],
    });
    const dot = groups.at(-1)!.entries.find((entry) => entry.name === 'Dot')!;
    expect(dot.detail).toBe('Done · Update the README');
  });

  it('adds up: the header and the groups count the same agents, and every agent once', () => {
    const queued = [{ id: 'i1', text: 'Add a test', time: 0 }] as LiveAgent['queued'];
    const question = { id: 'q1', agentId: 'q', time: 0, items: [] };
    const agents = [
      agent({ id: 'a', name: 'Atlas', state: 'approval', working: false }),
      agent({ id: 'm', name: 'Mori', state: 'error', working: false }),
      agent({ id: 'q', name: 'Quill', state: 'thinking', working: false, question }),
      agent({ id: 's', name: 'Sage', state: 'editing', queued }),
      agent({ id: 'w1', name: 'Wren', state: 'editing' }),
      agent({ id: 'w2', name: 'Wynn', state: 'reading' }),
      agent({ id: 'r', name: 'Rune', state: 'done', working: false }),
      agent({ id: 'i', name: 'Ivy', state: 'idle', working: false }),
      agent({ id: 'l', name: 'Leaver', state: 'editing', leaving: true }),
    ];
    const here = agentsHere(agents, filters());
    const counts = floorCounts(here);
    const groups = floorGroups({ agents, defs: [], projects }, filters());
    const size = (id: string) => groups.find((group) => group.id === id)?.entries.length ?? 0;
    // A leaving agent is counted nowhere.
    expect(counts.agents).toBe(8);
    expect(groups.flatMap((group) => group.entries)).toHaveLength(counts.agents);
    expect([counts.need, counts.queued]).toEqual([size('needs'), size('queued')]);
    expect(counts.need).toBe(3);
    expect(counts.tone).toBe('red');
    // Sage works with an instruction queued: it is in Queued, and in the header's working count.
    expect(counts.working).toBe(3);
    expect(size('working') + here.filter((a) => groupOf(a) === 'queued' && a.working).length).toBe(
      counts.working,
    );
  });

  it('keeps the header count calm when only questions wait', () => {
    const question = { id: 'q1', agentId: 'q', time: 0, items: [] };
    const here = [agent({ id: 'q', state: 'thinking', working: false, question })];
    expect(floorCounts(here)).toMatchObject({ need: 1, tone: 'calm' });
  });

  it('says what each one is doing in a few words', () => {
    const agents = [
      agent({ id: 'w', name: 'Wren', state: 'editing', task: 'Fix the footer' }),
      agent({ id: 'e', name: 'Ezra', state: 'error', error: 'Tests failed' }),
      agent({ id: 'i', name: 'Ivy', state: 'idle' }),
      agent({ id: 'd', name: 'Dot', state: 'done', task: '' }),
    ];
    const details = floorGroups({ agents, defs: [def()], projects }, filters()).flatMap((group) =>
      group.entries.map((entry) => [entry.name, entry.detail]),
    );
    expect(Object.fromEntries(details)).toEqual({
      Wren: 'Editing · Fix the footer',
      Ezra: 'Error · Tests failed',
      Ivy: 'Resting',
      Dot: 'Done',
      reader: 'Agent file · not running',
    });
  });

  it('leaves out empty groups, and anyone who is not on the floor or is leaving', () => {
    const agents = [
      agent({ id: 'w', name: 'Wren' }),
      agent({ id: 'off', name: 'Contractor', workflow: true, desk: -1, state: 'idle' }),
      agent({ id: 'gone', name: 'Gone', leaving: true }),
    ];
    const groups = floorGroups({ agents, defs: [], projects }, filters());
    expect(names(groups)).toEqual({ working: ['Wren'] });
  });

  it('names the project a workflow sub-agent works in, and no one else’s', () => {
    const agents = [
      agent({ id: 'c', name: 'Contractor', workflow: true }),
      agent({ id: 'f', name: 'Folder', workflow: true, projectId: null, folder: '/work/api/' }),
      agent({ id: 'w', name: 'Wren' }),
    ];
    const entries = floorGroups({ agents, defs: [], projects }, filters())[0]!.entries;
    const where = Object.fromEntries(
      entries.map((entry) => [entry.name, entry.kind === 'agent' ? entry.where : undefined]),
    );
    expect(where).toEqual({
      Contractor: { name: 'Docs site', color: '#33AA77' },
      Folder: { name: 'api', color: '#8E8E93' },
      Wren: null,
    });
  });

  it('lists a project or team only, as the floor shows it, and no agent files then', () => {
    const agents = [
      agent({ id: 'lead', name: 'Lead', projectId: 'docs' }),
      agent({ id: 'sub', name: 'Sub', projectId: 'docs', leadId: 'lead' }),
      agent({ id: 'other', name: 'Other', projectId: 'api' }),
    ];
    const office = { agents, defs: [def()], projects };
    expect(names(floorGroups(office, filters({ project: 'docs' })))).toEqual({
      working: ['Lead', 'Sub'],
    });
    expect(names(floorGroups(office, filters({ team: 'lead' })))).toEqual({
      working: ['Lead', 'Sub'],
    });
    expect(names(floorGroups(office, filters())).lounge).toEqual(['reader']);
  });

  it('fades those the Models and status filters leave out, as the floor does', () => {
    const agents = [
      agent({ id: 'c', name: 'Claude one', provider: 'claude' }),
      agent({ id: 'o', name: 'Codex one', provider: 'openai', model: 'gpt-5' }),
      agent({ id: 'i', name: 'Idle one', state: 'idle', working: false }),
    ];
    const office = { agents, defs: [], projects };
    const dim = (groups: ReturnType<typeof floorGroups>) =>
      Object.fromEntries(
        groups.flatMap((group) =>
          group.entries.map((entry) => [entry.name, entry.kind === 'agent' && entry.dim]),
        ),
      );
    expect(dim(floorGroups(office, filters({ provider: 'openai' })))).toEqual({
      'Claude one': true,
      'Codex one': false,
      'Idle one': true,
    });
    expect(dim(floorGroups(office, filters({ status: 'active' })))).toEqual({
      'Claude one': false,
      'Codex one': false,
      'Idle one': true,
    });
  });

  it('keeps Mabari’s own file and files with an agent running out of the lounge', () => {
    const agents = [agent({ id: 'r', name: 'Runner', defId: 'account:busy' })];
    const defs = [
      def({ id: 'account:busy', name: 'busy' }),
      def({ id: 'mabari', name: 'mabari', system: true }),
      def({ id: 'account:off', name: 'off', enabled: false }),
      def(),
    ];
    const lounge = floorGroups({ agents, defs, projects }, filters()).find(
      (group) => group.id === 'lounge',
    );
    expect(lounge?.entries.map((entry) => [entry.kind, entry.id])).toEqual([
      ['file', 'def:account:reader'],
    ]);
  });
});

describe('floorListShown', () => {
  it('shows on a wide window and hides on a narrow one, unless chosen', () => {
    expect(FLOOR_LIST_MIN_WIDTH).toBe(1180);
    expect(floorListShown(null, false, false, true)).toBe(true);
    expect(floorListShown(null, false, false, false)).toBe(false);
    expect(floorListShown(true, false, false, false)).toBe(true);
    expect(floorListShown(false, false, false, true)).toBe(false);
  });

  it('hides in full screen until it is turned on there', () => {
    expect(floorListShown(true, false, true, true)).toBe(false);
    expect(floorListShown(null, true, true, false)).toBe(true);
  });
});
