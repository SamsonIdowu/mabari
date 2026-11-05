// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { Snapshot } from './gen/models.ts';
import {
  BINDINGS,
  cleanView,
  DEFAULT_VIEW,
  fromHash,
  hashMove,
  knowsAgent,
  parseView,
  type SavedView,
} from './viewState.ts';

const [agentBinding, chatBinding] = BINDINGS;
if (!agentBinding || !chatBinding) throw new Error('the bindings changed');

const office = {
  projects: [{ id: 'shop' }, { id: 'docs' }],
  agents: [
    { id: 'a1', model: 'claude-sonnet-4-5', provider: 'claude' },
    { id: 'a2', model: 'gpt-5', provider: 'openai' },
  ],
  defs: [{ id: 'reader' }],
} as unknown as Snapshot;

describe('the saved view', () => {
  it('reads back what was saved', () => {
    const view: SavedView = {
      project: 'shop',
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      status: 'needs',
      threadProject: 'docs',
      projectsTab: 'open',
    };
    expect(parseView(JSON.stringify(view))).toEqual(view);
  });

  it('ignores anything that is not a view', () => {
    expect(parseView(null)).toEqual({});
    expect(parseView('not json')).toEqual({});
    expect(parseView('[1,2]')).toEqual({});
    expect(parseView('7')).toEqual({});
  });

  it('keeps only values of the right shape', () => {
    const raw = JSON.stringify({ project: 4, status: 'everything', projectsTab: 'all', model: '' });
    expect(parseView(raw)).toEqual({ projectsTab: 'all' });
  });

  it('drops a project, model or provider the office does not have', () => {
    const gone: SavedView = {
      ...DEFAULT_VIEW,
      project: 'deleted',
      provider: 'nobody',
      model: 'gpt-4',
      threadProject: 'deleted',
      status: 'active',
      projectsTab: 'done',
    };
    expect(cleanView(gone, office)).toEqual({
      ...DEFAULT_VIEW,
      status: 'active',
      projectsTab: 'done',
    });
  });

  it('drops a provider no agent has, as it drops a project or a model no one has (RT-6)', () => {
    const stale: SavedView = { ...DEFAULT_VIEW, provider: 'claude', model: 'claude-opus-4-1' };
    // The office is empty, as after the demo is turned off: nothing matches, so nothing is kept.
    const empty = { projects: [], agents: [] } as unknown as Snapshot;
    expect(cleanView(stale, empty)).toEqual(DEFAULT_VIEW);
    expect(cleanView({ ...DEFAULT_VIEW, project: 'shop' }, empty)).toEqual(DEFAULT_VIEW);
    // Only Codex agents are left, so "All Claude" matches nothing and goes, and Codex stays.
    const codexOnly = {
      projects: [],
      agents: [{ id: 'c1', model: 'gpt-5', provider: 'openai' }],
    } as unknown as Snapshot;
    expect(cleanView({ ...DEFAULT_VIEW, provider: 'claude' }, codexOnly).provider).toBe('all');
    expect(cleanView({ ...DEFAULT_VIEW, provider: 'openai' }, codexOnly).provider).toBe('openai');
    // A name that is no provider at all goes too.
    expect(cleanView({ ...DEFAULT_VIEW, provider: 'nobody' }, office).provider).toBe('all');
  });

  it('keeps choices the office still has', () => {
    const kept: SavedView = {
      ...DEFAULT_VIEW,
      project: 'shop',
      provider: 'openai',
      model: 'gpt-5',
      threadProject: 'docs',
    };
    expect(cleanView(kept, office)).toEqual(kept);
  });
});

describe('what the address means', () => {
  it('opens the agent a link names', () => {
    expect(fromHash(agentBinding, '#office?agent=a1', null, null)).toEqual({
      action: 'open',
      value: 'a1',
    });
    expect(fromHash(agentBinding, '#office?agent=def%3Areader', null, null)).toEqual({
      action: 'open',
      value: 'def:reader',
    });
  });

  it('does nothing when the agent is already open', () => {
    expect(fromHash(agentBinding, '#office?agent=a1', 'a1', '#office')).toEqual({
      action: 'none',
    });
  });

  it('opens the chat a link names, on the Projects page only', () => {
    expect(fromHash(chatBinding, '#projects?chat=shop', null, null)).toEqual({
      action: 'open',
      value: 'shop',
    });
    expect(fromHash(chatBinding, '#office?chat=shop', null, null)).toEqual({ action: 'none' });
    expect(fromHash(agentBinding, '#projects?agent=a1', null, null)).toEqual({ action: 'none' });
  });

  it('closes the panel when Back or the page link leaves the address bare', () => {
    expect(fromHash(agentBinding, '#office', 'a1', '#office?agent=a1')).toEqual({
      action: 'close',
    });
  });

  it('keeps the panel when you come to the page from another one, and shows it in the address', () => {
    expect(fromHash(agentBinding, '#office', 'a1', '#activity')).toEqual({
      action: 'mirror',
      hash: '#office?agent=a1',
    });
  });

  it('has nothing to do with a bare address and nothing open', () => {
    expect(fromHash(agentBinding, '#office', null, null)).toEqual({ action: 'none' });
    expect(fromHash(agentBinding, '#office', null, '#home')).toEqual({ action: 'none' });
  });
});

describe('how the address follows what is open', () => {
  it('adds a history step when something opens, so Back closes it', () => {
    expect(hashMove(agentBinding, '#office', null, 'a1', false)).toBe('push');
  });

  it('replaces the step when another agent opens', () => {
    expect(hashMove(agentBinding, '#office?agent=a1', 'a1', 'a2', true)).toBe('replace');
  });

  it('goes back when it closes a step it added', () => {
    expect(hashMove(agentBinding, '#office?agent=a1', 'a1', null, true)).toBe('back');
  });

  it('rewrites the address when it closes a step it did not add', () => {
    expect(hashMove(agentBinding, '#office?agent=a1', 'a1', null, false)).toBe('replace');
  });

  it('leaves the address alone on another page, or when it already says so', () => {
    expect(hashMove(agentBinding, '#home', null, 'a1', false)).toBe('none');
    expect(hashMove(agentBinding, '#office?agent=a1', null, 'a1', false)).toBe('none');
    expect(hashMove(agentBinding, '#office', 'a1', null, true)).toBe('none');
  });
});

describe('knowing an agent', () => {
  it('finds a live agent and an agent file resting in the lounge', () => {
    expect(knowsAgent(office, 'a2')).toBe(true);
    expect(knowsAgent(office, 'def:reader')).toBe(true);
    expect(knowsAgent(office, 'ghost')).toBe(false);
  });
});
