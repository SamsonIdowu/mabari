// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { Event, LiveAgent } from '../gen/models.ts';
import { buildTrail, trailKinds } from './trail.ts';

let nextId = 1;

const event = (tool: string, summary: string): Event => ({
  id: `e${nextId++}`,
  agentId: 'a',
  time: 0,
  tool,
  summary,
  raw: null,
});

/** Feeds are newest first, so tests write them oldest first and flip them here. */
const agent = (events: Event[], overrides: Partial<LiveAgent> = {}) =>
  ({
    id: 'a',
    name: 'Ledger',
    task: 'Fix the totals',
    bubble: 'Editing totals.ts',
    feed: [...events].reverse(),
    ...overrides,
  }) as LiveAgent;

describe('buildTrail', () => {
  it('starts with the goal and ends where the agent is now', () => {
    const steps = buildTrail(agent([]), []);
    expect(steps[0]).toEqual({ kind: 'goal', title: 'Fix the totals' });
    expect(steps.at(-1)).toEqual({ kind: 'now', title: 'Editing totals.ts' });
  });

  it('puts events in the order they happened', () => {
    const steps = buildTrail(
      agent([event('read_file', 'src/a.ts'), event('edit_file', 'src/a.ts  +3 −1')]),
      [],
    );
    expect(steps.slice(1, 3)).toEqual([
      { kind: 'read_file', title: 'Read src/a.ts' },
      { kind: 'edit_file', title: 'Edit src/a.ts', detail: '+3 −1' },
    ]);
  });

  it('shows what a command returned', () => {
    const steps = buildTrail(agent([event('run_shell', 'npm test  → all passed')]), []);
    expect(steps[1]).toEqual({ kind: 'run_shell', title: 'npm test' });
    expect(steps[2]).toEqual({ kind: 'ok', title: 'Result: all passed' });
  });

  it('branches the steps taken after a failure', () => {
    const steps = buildTrail(
      agent([
        event('run_shell', 'npm test  → 2 failed'),
        event('think', 'Read the failing test'),
        event('edit_file', 'src/a.ts  +1 −1'),
        event('run_shell', 'npm test  → all passed'),
      ]),
      [],
    );
    const failure = steps.find((step) => step.kind === 'bad');
    expect(failure?.branch?.label).toBe('Retried');
    expect(failure?.branch?.steps.map((step) => step.kind)).toEqual(['think', 'edit_file']);
    expect(steps.some((step) => step.title === 'Result: all passed')).toBe(true);
  });

  it('leaves out messages, which have their own tab', () => {
    const steps = buildTrail(agent([event('message', 'To Sage: hi')]), []);
    expect(steps.map((step) => step.kind)).toEqual(['goal', 'now']);
  });

  it('branches the work handed to subagents', () => {
    const helper = { name: 'Scribe', model: 'haiku', task: 'Write notes' } as LiveAgent;
    const step = buildTrail(agent([]), [helper]).find((item) => item.branch);
    expect(step?.branch?.label).toBe('Subagent took over');
    expect(step?.branch?.steps[0]?.title).toBe('Scribe on haiku');
  });
});

describe('trailKinds', () => {
  it('lists kinds once, including those inside branches', () => {
    const steps = buildTrail(
      agent([event('run_shell', 'npm test  → 2 failed'), event('think', 'Look again')]),
      [],
    );
    expect(trailKinds(steps)).toEqual(['goal', 'run_shell', 'bad', 'think', 'now']);
  });
});
