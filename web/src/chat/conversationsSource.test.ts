// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { LiveAgent, Snapshot } from '../gen/models.ts';
import {
  flatten,
  registeredSources,
  search,
  type SwitcherContext,
  type SwitcherControls,
} from '../shell/switcher.ts';
import { conversationsSource } from './conversationsSource.ts';

const agent = (overrides: Partial<LiveAgent> = {}) =>
  ({
    id: 'a',
    name: 'Ada',
    projectId: 'shop',
    state: 'idle',
    working: false,
    desk: 0,
    leaving: false,
    leadId: null,
    hue: '#7FA8FF',
    task: 'Fix the login page',
    error: '',
    queued: [],
    approval: null,
    question: null,
    ...overrides,
  }) as LiveAgent;

const controls: SwitcherControls = {
  quietOn: false,
  theme: 'light',
  toggleQuiet: () => undefined,
  toggleTheme: () => undefined,
  newAgent: () => undefined,
  newProject: () => undefined,
};

const context = (agents: LiveAgent[]): SwitcherContext => ({
  office: {
    agents,
    projects: [
      { id: 'shop', name: 'Checkout revamp', color: '#FF6B9A', status: 'active' },
      { id: 'old', name: 'Landing page', color: '#7BED9F', status: 'done' },
    ],
  } as unknown as Snapshot,
  openAgent: () => undefined,
  controls,
});

describe('the Chats source', () => {
  it('is registered, so the switcher offers it with the rest', () => {
    expect(registeredSources().some((source) => source.id === 'conversations')).toBe(true);
  });

  it('offers nothing before the office has loaded', () => {
    expect(conversationsSource.results({ ...context([]), office: null })).toEqual([]);
  });

  it('links each agent and each open project to its thread, those that need you first', () => {
    const results = conversationsSource.results(
      context([
        agent({ id: 'a1', name: 'Quiet' }),
        agent({ id: 'a2', name: 'Needy', state: 'approval' }),
        agent({ id: 'a3', name: 'Helper', leadId: 'a2' }),
      ]),
    );
    expect(results.map((result) => [result.label, result.href])).toEqual([
      ['Chat with Needy', '#conversations?agent=a2'],
      ['Chat with Quiet', '#conversations?agent=a1'],
      ['Chat with Checkout revamp', '#conversations?project=shop'],
    ]);
    expect(results.map((result) => result.order)).toEqual([0, 1, 2]);
    // Every one is a link, never an action, so choosing one runs nothing.
    expect(results.every((result) => result.href && !result.run)).toBe(true);
  });

  it('is red only for an approval or an error, and a question is shown calmly', () => {
    const [approval, question, quiet] = conversationsSource.results(
      context([
        agent({ id: 'a1', name: 'A', state: 'approval' }),
        agent({ id: 'a2', name: 'B', question: {} as never }),
        agent({ id: 'a3', name: 'C' }),
      ]),
    );
    expect(approval!.chip).toEqual({ text: 'Needs you', tone: 'red' });
    expect(question!.chip).toEqual({ text: 'Asking you', tone: 'ask' });
    expect(quiet!.chip).toBeUndefined();
  });

  it('is found by what a person types, in its own group', () => {
    const groups = search(context([agent({ name: 'Ada' })]), 'chat ada');
    const chats = groups.find((group) => group.id === 'conversations');
    expect(chats?.results.map((result) => result.label)).toEqual(['Chat with Ada']);
    expect(flatten(groups).length).toBeGreaterThan(0);
  });
});
