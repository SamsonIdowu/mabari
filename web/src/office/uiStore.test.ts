// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Estimate, LiveAgent } from '../gen/models.ts';
import {
  inScope,
  matches,
  needsYou,
  openAgent,
  openThread,
  threadKey,
  useOfficeUi,
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
});

describe('matches', () => {
  it('filters by provider and model', () => {
    expect(matches(agent(), filters({ provider: 'openai' }))).toBe(false);
    expect(matches(agent(), filters({ provider: 'claude' }))).toBe(true);
    expect(matches(agent(), filters({ model: 'gpt-5' }))).toBe(false);
  });

  it('counts approvals, errors and queued instructions as needing you', () => {
    expect(needsYou(agent({ state: 'approval' }))).toBe(true);
    expect(needsYou(agent({ state: 'error' }))).toBe(true);
    expect(needsYou(agent({ queued: [{ id: 'q' } as LiveAgent['queued'][number]] }))).toBe(true);
    expect(needsYou(agent())).toBe(false);
    expect(matches(agent(), filters({ status: 'needs' }))).toBe(false);
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

  it('opens a thread across every project', () => {
    useOfficeUi.getState().set({ threadProject: 'docs' });
    openThread(threadKey('Sage', 'Ledger'));
    const ui = useOfficeUi.getState();
    expect([ui.thread, ui.threadProject]).toEqual(['Ledger|Sage', 'all']);
    expect(window.location.hash).toBe('#conversations');
  });

  it('forgets the view after a reset', () => {
    useOfficeUi.getState().set({ selected: 'a', project: 'docs', target: 'a', thread: 'A|B' });
    useOfficeUi.getState().resetOffice();
    const ui = useOfficeUi.getState();
    expect([ui.selected, ui.project, ui.target, ui.thread]).toEqual([null, 'all', 'auto', 'all']);
  });
});
