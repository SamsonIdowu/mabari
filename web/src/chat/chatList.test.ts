// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { LiveAgent, Project } from '../gen/models.ts';
import { chatEntries, entryMatches } from './chatList.ts';

const agent = (overrides: Partial<LiveAgent> = {}) =>
  ({
    id: 'a',
    name: 'Ada',
    projectId: 'p',
    leadId: null,
    state: 'idle',
    working: false,
    desk: 0,
    leaving: false,
    hue: '#7FA8FF',
    task: 'Fix the login page',
    error: '',
    queued: [],
    approval: null,
    question: null,
    ...overrides,
  }) as LiveAgent;

const project = (overrides: Partial<Project> = {}) =>
  ({ id: 'p', name: 'Shop', color: '#33AA77', status: 'active', ...overrides }) as Project;

describe('chatEntries', () => {
  it('puts agents that need you first, then working, then waiting, then the rest, by name', () => {
    const { agents } = chatEntries({
      projects: [],
      agents: [
        agent({ id: '1', name: 'Idle', state: 'idle' }),
        agent({ id: '2', name: 'Queued', queued: [{ id: 'q' } as never] }),
        agent({ id: '3', name: 'Working', state: 'editing', working: true }),
        agent({ id: '4', name: 'Asking', question: {} as never }),
        agent({ id: '5', name: 'Approval', state: 'approval' }),
        agent({ id: '6', name: 'Broken', state: 'error' }),
        agent({ id: '7', name: 'Aardvark', state: 'idle' }),
      ],
    });
    expect(agents.map((entry) => entry.name)).toEqual([
      'Approval',
      'Broken',
      'Asking',
      'Working',
      'Queued',
      'Aardvark',
      'Idle',
    ]);
  });

  it('is red only for an approval or an error, amber for a queued instruction, never for a question', () => {
    const { agents } = chatEntries({
      projects: [],
      agents: [
        agent({ id: '1', name: 'A', state: 'approval' }),
        agent({ id: '2', name: 'B', question: {} as never }),
        agent({ id: '3', name: 'C', queued: [{ id: 'q' } as never] }),
        agent({ id: '4', name: 'D' }),
      ],
    });
    expect(Object.fromEntries(agents.map((entry) => [entry.name, entry.tone]))).toEqual({
      A: 'red',
      B: 'calm',
      C: 'amber',
      D: 'calm',
    });
    expect(agents.find((entry) => entry.name === 'B')).toMatchObject({
      needs: 1,
      label: 'Asking you',
    });
  });

  it('leaves out subagents, agents leaving and those off the floor', () => {
    const { agents } = chatEntries({
      projects: [],
      agents: [
        agent({ id: '1', name: 'Lead' }),
        agent({ id: '2', name: 'Helper', leadId: '1' }),
        agent({ id: '3', name: 'Gone', leaving: true }),
        agent({ id: '4', name: 'Off', desk: -1 }),
      ],
    });
    expect(agents.map((entry) => entry.name)).toEqual(['Lead']);
  });

  it('lists open projects, ones with agents that need you first, and counts their agents', () => {
    const { projects } = chatEntries({
      projects: [
        project({ id: 'p1', name: 'Quiet' }),
        project({ id: 'p2', name: 'Needy' }),
        project({ id: 'p3', name: 'Done', status: 'done' }),
        project({ id: 'p4', name: 'Busy' }),
      ],
      agents: [
        agent({ id: '1', projectId: 'p2', state: 'approval' }),
        agent({ id: '2', projectId: 'p4', state: 'editing', working: true }),
        agent({ id: '3', projectId: 'p4', name: 'Two', leadId: '2' }),
      ],
    });
    expect(projects.map((entry) => entry.name)).toEqual(['Needy', 'Busy', 'Quiet']);
    expect(projects[0]).toMatchObject({ tone: 'red', needs: 1, detail: '1 agent · 1 needs you' });
    expect(projects[1]!.detail).toBe('1 agent · 1 working');
    expect(projects[2]!.detail).toBe('Nobody works here yet');
  });

  it('searches names and what each is doing', () => {
    const [entry] = chatEntries({
      projects: [],
      agents: [agent({ name: 'Ada', task: 'Fix the login page' })],
    }).agents;
    expect(entryMatches(entry!, 'ada')).toBe(true);
    expect(entryMatches(entry!, 'LOGIN')).toBe(true);
    expect(entryMatches(entry!, 'billing')).toBe(false);
    expect(entryMatches(entry!, '  ')).toBe(true);
  });
});
