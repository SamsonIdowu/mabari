// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { LiveAgent, Project, Watch } from '../gen/models.ts';
import { agentWatchable, chainsFor, projectWatchable, tellable, watchOf } from './watches.ts';

const watch = (fields: Partial<Watch>): Watch =>
  ({
    id: 'w',
    kind: 'agent',
    target: 'a',
    name: 'Ledger',
    time: 1,
    then: null,
    ...fields,
  }) as Watch;

describe('watches', () => {
  it('finds the watch on an agent or a project, and none when there is none', () => {
    const watches = [
      watch({ id: 'w1', target: 'a' }),
      watch({ id: 'w2', kind: 'project', target: 'a' }),
    ];
    expect(watchOf(watches, 'agent', 'a')?.id).toBe('w1');
    expect(watchOf(watches, 'project', 'a')?.id).toBe('w2');
    expect(watchOf(watches, 'agent', 'b')).toBeUndefined();
    expect(watchOf(undefined, 'agent', 'a')).toBeUndefined();
  });

  it('lists the watches that will tell an agent something', () => {
    const watches = [
      watch({ id: 'w1', then: { agentId: 'q', agentName: 'Quill', text: 'review it' } }),
      watch({ id: 'w2', target: 'b' }),
      watch({ id: 'w3', target: 'c', then: { agentId: 'z', agentName: 'Zed', text: 'x' } }),
    ];
    expect(chainsFor(watches, 'q').map((item) => item.id)).toEqual(['w1']);
    expect(chainsFor(watches, 'nobody')).toEqual([]);
    expect(chainsFor(undefined, 'q')).toEqual([]);
  });

  it('has nothing to wait for on work that has finished', () => {
    for (const state of ['thinking', 'editing', 'approval', 'idle', 'paused']) {
      expect(agentWatchable({ state } as LiveAgent)).toBe(true);
    }
    expect(agentWatchable({ state: 'done' } as LiveAgent)).toBe(false);
    expect(agentWatchable({ state: 'error' } as LiveAgent)).toBe(false);
    for (const status of ['new', 'active', 'needs', 'idle']) {
      expect(projectWatchable({ status } as Project)).toBe(true);
    }
    expect(projectWatchable({ status: 'ready' } as Project)).toBe(false);
    expect(projectWatchable({ status: 'done' } as Project)).toBe(false);
  });

  it('offers anyone to tell but the agent watched and those leaving', () => {
    const agents = [
      { id: 'a', name: 'Ledger', leaving: false },
      { id: 'b', name: 'Quill', leaving: false },
      { id: 'c', name: 'Gone', leaving: true },
    ];
    expect(tellable(agents, 'agent', 'a').map((agent) => agent.name)).toEqual(['Quill']);
    expect(tellable(agents, 'project', 'p').map((agent) => agent.name)).toEqual([
      'Ledger',
      'Quill',
    ]);
  });
});
