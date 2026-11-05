// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { AgentDef, LiveAgent } from '../gen/models.ts';
import { FLOOR_LIST_MIN_WIDTH, floorGroups, floorListShown } from './floorList.ts';
import type { OfficeFilters } from './uiStore.ts';

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
