// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { LiveAgent } from '../gen/models.ts';
import { nextVisit, onRound, projectUpdate, REPORT_GAP_MS, worthSaying } from './rounds.ts';

const agent = (overrides: Partial<LiveAgent>) =>
  ({
    id: 'a',
    projectId: null,
    desk: 0,
    state: 'editing',
    leaving: false,
    working: true,
    ...overrides,
  }) as LiveAgent;

describe("Mabari's rounds", () => {
  const agents = [
    agent({ id: 'shop-2', projectId: 'shop', desk: 5 }),
    agent({ id: 'none', desk: 1 }),
    agent({ id: 'docs', projectId: 'docs', desk: 9 }),
    agent({ id: 'shop-1', projectId: 'shop', desk: 2 }),
    agent({ id: 'resting', projectId: 'shop', state: 'idle', working: false }),
    agent({ id: 'waiting', projectId: 'shop', state: 'approval', working: false, desk: 3 }),
    agent({ id: 'going', projectId: 'docs', leaving: true }),
  ];

  it('visits the agents at work, project by project and desk by desk', () => {
    expect(onRound(agents).map((item) => item.id)).toEqual(['docs', 'shop-1', 'shop-2', 'none']);
  });

  it('goes round and round, and has nobody to visit when nobody works', () => {
    const round = onRound(agents);
    expect(nextVisit(round, null)!.id).toBe('docs');
    expect(nextVisit(round, 'shop-2')!.id).toBe('none');
    expect(nextVisit(round, 'none')!.id).toBe('docs');
    expect(nextVisit(round, 'gone')!.id).toBe('docs');
    expect(nextVisit([], 'docs')).toBeNull();
  });

  it("puts a project's numbers into words", () => {
    const shop = { name: 'Shop', progress: 0.482, estimate: { secondsLeft: 1200 } as never };
    expect(projectUpdate(shop, agents, 'shop')).toBe(
      'Shop: 2 working, 1 needs you, 48% done, about 20 min left.',
    );
    expect(projectUpdate(null, agents, null)).toBe('Outside any project: 1 working.');
  });

  it('says a change, but not more often than every couple of minutes', () => {
    expect(worthSaying('a', undefined, 0)).toBe(true);
    expect(worthSaying('a', { text: 'a', at: 0 }, REPORT_GAP_MS * 9)).toBe(false);
    expect(worthSaying('b', { text: 'a', at: 0 }, REPORT_GAP_MS - 1)).toBe(false);
    expect(worthSaying('b', { text: 'a', at: 0 }, REPORT_GAP_MS)).toBe(true);
  });
});
