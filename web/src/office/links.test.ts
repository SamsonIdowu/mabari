// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { teamLinks, type Linked } from './links.ts';

const at = (id: string, x: number, y: number, extra: Partial<Linked> = {}): Linked => ({
  id,
  leadId: null,
  x,
  y,
  working: false,
  leaving: false,
  ...extra,
});

describe('teamLinks', () => {
  it('joins a lead to each of its subagents, from body to body', () => {
    const links = teamLinks([
      at('lead', 100, 200),
      at('a', 300, 200, { leadId: 'lead', working: true }),
      at('b', 100, 400, { leadId: 'lead' }),
      at('other', 500, 500),
    ]);
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({
      from: { x: 100, y: 182 },
      to: { x: 300, y: 182 },
      live: true,
    });
    expect(links[1]!.live).toBe(false);
    // The curve rises above both ends.
    for (const link of links) expect(link.bend.y).toBeLessThan(Math.min(link.from.y, link.to.y));
  });

  it('leaves out subagents whose lead is not shown, and anyone on the way out', () => {
    expect(teamLinks([at('a', 0, 0, { leadId: 'hidden' })])).toEqual([]);
    expect(
      teamLinks([at('lead', 0, 0, { leaving: true }), at('a', 10, 10, { leadId: 'lead' })]),
    ).toEqual([]);
    expect(
      teamLinks([at('lead', 0, 0), at('a', 10, 10, { leadId: 'lead', leaving: true })]),
    ).toEqual([]);
  });
});
