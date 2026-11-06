// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Estimate, LiveAgent } from '../gen/models.ts';
import {
  areaOf,
  filesShown,
  hasQueued,
  inScope,
  matches,
  needsTone,
  needsYou,
  openAgent,
  openThread,
  threadKey,
  useOfficeUi,
  whoNeedsYou,
  type OfficeFilters,
} from './uiStore.ts';

const agent = (overrides: Partial<LiveAgent> = {}) =>
  ({
    id: 'a',
    projectId: 'docs',
    provider: 'claude',
    model: 'claude-sonnet-4-5',
    state: 'editing',
    leadId: null,
    estimate: { secondsLeft: 60 } as Estimate,
    working: true,
    queued: [],
    ...overrides,
  }) as LiveAgent;

const filters = (overrides: Partial<OfficeFilters> = {}): OfficeFilters => ({
  project: 'all',
  provider: 'all',
  model: 'all',
  status: 'all',
  area: 'all',
  team: null,
  ...overrides,
});

describe('inScope', () => {
  it('shows everyone by default', () => {
    expect(inScope(agent(), filters(), [])).toBe(true);
  });

  it('narrows to a project', () => {
    expect(inScope(agent(), filters({ project: 'docs' }), [])).toBe(true);
    expect(inScope(agent(), filters({ project: 'tests' }), [])).toBe(false);
  });

  it('narrows to a lead and its subagents', () => {
    const lead = agent({ id: 'lead' });
    const sub = agent({ id: 'sub', leadId: 'lead' });
    const other = agent({ id: 'other' });
    const everyone = [lead, sub, other];
    const team = filters({ team: 'lead' });
    expect(everyone.map((item) => inScope(item, team, everyone))).toEqual([true, true, false]);
  });

  it('shows only the work area or only the lounge when asked', () => {
    const busy = agent({ id: 'busy', state: 'editing' });
    const resting = agent({ id: 'resting', state: 'idle' });
    const briefing = agent({ id: 'briefing', state: 'spawning' });
    const everyone = [busy, resting, briefing];
    const shown = (area: 'all' | 'work' | 'lounge') =>
      everyone.filter((item) => inScope(item, filters({ area }), everyone)).map((item) => item.id);
    expect(shown('all')).toEqual(['busy', 'resting', 'briefing']);
    expect(shown('work')).toEqual(['busy', 'briefing']);
    expect(shown('lounge')).toEqual(['resting']);
  });
});

describe('areaOf', () => {
  it('puts idle agents in the lounge and everyone else in the work area', () => {
    expect(areaOf(agent({ state: 'idle' }))).toBe('lounge');
    for (const state of ['thinking', 'approval', 'error', 'paused', 'done', 'spawning'] as const) {
      expect(areaOf(agent({ state }))).toBe('work');
    }
  });

  it('never puts a workflow sub-agent in the lounge, as it leaves when off duty', () => {
    expect(areaOf(agent({ state: 'idle', workflow: true }))).toBe('work');
  });
});

describe('filesShown', () => {
  it('shows agent files in the lounge unless a project, team or the work area is chosen', () => {
    expect(filesShown(filters())).toBe(true);
    expect(filesShown(filters({ area: 'lounge' }))).toBe(true);
    expect(filesShown(filters({ area: 'work' }))).toBe(false);
    expect(filesShown(filters({ project: 'docs' }))).toBe(false);
  });
});

describe('matches', () => {
  it('filters by provider and model', () => {
    expect(matches(agent(), filters({ provider: 'openai' }))).toBe(false);
    expect(matches(agent(), filters({ provider: 'claude' }))).toBe(true);
    expect(matches(agent(), filters({ model: 'gpt-5' }))).toBe(false);
  });

  it('counts approvals, errors and questions as needing you, and not a queued instruction', () => {
    const queued = [{ id: 'q' } as LiveAgent['queued'][number]];
    const question = { id: 'q1', agentId: 'a', time: 0, items: [] } as LiveAgent['question'];
    expect(needsYou(agent({ state: 'approval' }))).toBe(true);
    expect(needsYou(agent({ state: 'error' }))).toBe(true);
    expect(needsYou(agent({ question }))).toBe(true);
    // A queued instruction is a wait, not a request (decision 1).
    expect(needsYou(agent({ queued }))).toBe(false);
    expect(hasQueued(agent({ queued }))).toBe(true);
    expect(needsYou(agent())).toBe(false);
    expect(matches(agent(), filters({ status: 'needs' }))).toBe(false);
    expect(matches(agent({ queued }), filters({ status: 'needs' }))).toBe(false);
    expect(matches(agent({ question }), filters({ status: 'needs' }))).toBe(true);
  });

  it('counts the same agents everywhere: on the floor, and not on the way out', () => {
    const everyone = [
      agent({ id: 'w', state: 'approval', desk: 0 }),
      agent({ id: 'g', state: 'approval', desk: 1, leaving: true }),
      agent({ id: 'o', state: 'error', desk: -1 }),
      agent({ id: 'c', desk: 3 }),
    ];
    expect(whoNeedsYou(everyone).map((item) => item.id)).toEqual(['w']);
  });

  it('colours the count red for an approval or an error, and calm for questions alone', () => {
    const question = { id: 'q1', agentId: 'a', time: 0, items: [] } as LiveAgent['question'];
    expect(needsTone([agent({ question })])).toBe('calm');
    expect(needsTone([agent({ question }), agent({ state: 'error' })])).toBe('red');
    expect(needsTone([agent({ state: 'approval' })])).toBe('red');
  });

  it('treats agents the server says are working as working, with or without an estimate', () => {
    expect(matches(agent(), filters({ status: 'active' }))).toBe(true);
    expect(matches(agent({ estimate: null }), filters({ status: 'active' }))).toBe(true);
    expect(matches(agent({ working: false, estimate: null }), filters({ status: 'active' }))).toBe(
      false,
    );
  });
});

describe('opening an agent', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { hash: '' } });
    useOfficeUi.getState().resetOffice();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends the next message to that agent and keeps a filter that already shows it', () => {
    const docs = agent({ id: 'd', projectId: 'docs' });
    useOfficeUi.getState().set({ project: 'docs' });
    openAgent(docs, [docs]);
    const ui = useOfficeUi.getState();
    expect([ui.selected, ui.target, ui.project]).toEqual(['d', 'selected', 'docs']);
    // The address names the agent, so a link opens its panel and Back closes it.
    expect(window.location.hash).toBe('#office?agent=d');
  });

  it('widens the floor when the agent is out of view', () => {
    const lead = agent({ id: 'lead', projectId: 'docs' });
    const other = agent({ id: 'o', projectId: 'tests' });
    useOfficeUi.getState().set({ project: 'docs', team: 'lead' });
    openAgent(other, [lead, other]);
    const ui = useOfficeUi.getState();
    expect([ui.selected, ui.project, ui.team]).toEqual(['o', 'all', null]);
  });

  it('shows the whole floor again when the agent is in the part that is hidden', () => {
    const busy = agent({ id: 'b', state: 'editing' });
    useOfficeUi.getState().set({ area: 'lounge' });
    openAgent(busy, [busy]);
    expect(useOfficeUi.getState().area).toBe('all');
  });

  it('opens a thread across every project', () => {
    useOfficeUi.getState().set({ threadProject: 'docs' });
    openThread(threadKey('Sage', 'Ledger'));
    const ui = useOfficeUi.getState();
    expect([ui.thread, ui.threadProject]).toEqual(['Ledger|Sage', 'all']);
    expect(window.location.hash).toBe('#conversations?tab=between');
  });

  it('forgets the view after a reset', () => {
    useOfficeUi.getState().set({ selected: 'a', project: 'docs', target: 'a', thread: 'A|B' });
    useOfficeUi.getState().resetOffice();
    const ui = useOfficeUi.getState();
    expect([ui.selected, ui.project, ui.target, ui.thread]).toEqual([null, 'all', 'auto', 'all']);
  });
});
