// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { Estimate, LiveAgent } from '../gen/models.ts';
import { inScope, matches, needsYou, type OfficeFilters } from './uiStore.ts';

const agent = (overrides: Partial<LiveAgent> = {}) =>
  ({
    id: 'a',
    projectId: 'docs',
    provider: 'claude',
    model: 'claude-sonnet-4-5',
    state: 'editing',
    leadId: null,
    estimate: { secondsLeft: 60 } as Estimate,
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

  it('treats agents with an estimate as working', () => {
    expect(matches(agent(), filters({ status: 'active' }))).toBe(true);
    expect(matches(agent({ estimate: null }), filters({ status: 'active' }))).toBe(false);
  });
});
