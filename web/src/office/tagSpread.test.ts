// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { EDGE, overlaps, type Box } from './bubbles.ts';
import { MAX_DOWN, MAX_SIDEWAYS, moved, spreadTags, TAG_GAP, type TagItem } from './tagSpread.ts';

const box = (left: number, top: number, width = 90, height = 34): Box => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});
const tag = (id: string, left: number, top: number, extra: Partial<TagItem> = {}): TagItem => ({
  id,
  box: box(left, top),
  ...extra,
});

/** The tags where the spread puts them. */
function placed(items: TagItem[], width = 1000): Map<string, Box> {
  const shifts = spreadTags(items, width);
  return new Map(items.map((item) => [item.id, moved(item.box, shifts.get(item.id))]));
}

/** Every pair of tags that still touch, counting the air a tag keeps. */
function touching(boxes: Map<string, Box>): string[] {
  const entries = [...boxes];
  const pairs: string[] = [];
  entries.forEach(([a, one], index) => {
    for (const [b, two] of entries.slice(index + 1)) {
      if (overlaps(one, two, TAG_GAP - 0.5)) pairs.push(`${a}+${b}`);
    }
  });
  return pairs;
}

describe('keeping name tags apart', () => {
  it('leaves tags that do not touch exactly where they hang', () => {
    const shifts = spreadTags([tag('a', 100, 100), tag('b', 300, 100), tag('c', 100, 200)], 1000);
    expect(shifts.size).toBe(0);
  });

  it('has nothing to do for one tag or none', () => {
    expect(spreadTags([], 1000).size).toBe(0);
    expect(spreadTags([tag('a', 10, 10)], 1000).size).toBe(0);
  });

  it('moves two tags that overlap sideways, each half of the way, and no further', () => {
    const shifts = spreadTags([tag('a', 100, 100), tag('b', 150, 100)], 1000);
    const a = shifts.get('a')!;
    const b = shifts.get('b')!;
    expect(a.dx).toBeLessThan(0);
    expect(b.dx).toBeGreaterThan(0);
    expect(a.dy).toBe(0);
    expect(b.dy).toBe(0);
    // They overlapped by 40 and need the air as well: about 22 each.
    expect(Math.abs(a.dx)).toBeLessThan(30);
    expect(Math.abs(b.dx + a.dx)).toBeLessThanOrEqual(1);
  });

  it('spreads the meeting room: four agents 58 pixels apart with 90 pixel tags', () => {
    const items = [0, 1, 2, 3].map((index) => tag(`agent-${index}`, 400 + index * 58, 300));
    const result = placed(items);
    expect(touching(result)).toEqual([]);
    // The order along the row is kept, so nobody crosses over.
    const lefts = items.map((item) => result.get(item.id)!.left);
    expect([...lefts].sort((a, b) => a - b)).toEqual(lefts);
  });

  it('does not depend on the order the tags are given in', () => {
    const items = [0, 1, 2, 3, 4].map((index) => tag(`t${index}`, 400 + index * 40, 300));
    const forward = spreadTags(items, 1000);
    const backward = spreadTags([...items].reverse(), 1000);
    expect([...backward].sort()).toEqual([...forward].sort());
  });

  it('puts a tag that is just under another straight down, not sideways', () => {
    const shifts = spreadTags([tag('above', 100, 100), tag('below', 104, 130)], 1000);
    expect(shifts.get('above')).toBeUndefined();
    expect(shifts.get('below')!.dx).toBe(0);
    expect(shifts.get('below')!.dy).toBeGreaterThan(0);
  });

  it('keeps a tag that needs you where it is, and the other gives way all the way', () => {
    const shifts = spreadTags(
      [tag('needs', 100, 100, { fixed: true }), tag('other', 130, 100)],
      1000,
    );
    expect(shifts.get('needs')).toBeUndefined();
    const other = moved(box(130, 100), shifts.get('other'));
    expect(overlaps(box(100, 100), other, TAG_GAP - 0.5)).toBe(false);
  });

  it('two fixed tags that overlap stay overlapped rather than moving the one you picked', () => {
    const shifts = spreadTags(
      [tag('a', 100, 100, { fixed: true }), tag('b', 130, 100, { fixed: true })],
      1000,
    );
    expect(shifts.size).toBe(0);
  });

  it('stays on the floor: a tag against the left edge is pushed right instead', () => {
    const result = placed([tag('a', EDGE, 100), tag('b', EDGE + 30, 100)]);
    expect(result.get('a')!.left).toBeGreaterThanOrEqual(EDGE);
    expect(touching(result)).toEqual([]);
  });

  it('stays on the floor at the right edge too', () => {
    const result = placed([tag('a', 1000 - EDGE - 90, 100), tag('b', 1000 - EDGE - 120, 100)]);
    for (const one of result.values()) expect(one.right).toBeLessThanOrEqual(1000 - EDGE);
    expect(touching(result)).toEqual([]);
  });

  it('never moves a tag far from its agent, and falls back to stacking a crowd at one spot', () => {
    const items = Array.from({ length: 8 }, (_, index) => tag(`t${index}`, 500, 300));
    const shifts = spreadTags(items, 1000);
    for (const shift of shifts.values()) {
      expect(Math.abs(shift.dx)).toBeLessThanOrEqual(MAX_SIDEWAYS);
      expect(shift.dy).toBeGreaterThanOrEqual(0);
      expect(shift.dy).toBeLessThanOrEqual(MAX_DOWN);
    }
    // A crowd that cannot all fit within the limits is not left piled in one spot: most of the
    // pairs are clear.
    const result = placed(items);
    const pairs = (items.length * (items.length - 1)) / 2;
    expect(touching(result).length).toBeLessThan(pairs / 3);
  });

  it('leaves no pair touching across a spread of random floors, within the limits', () => {
    // A small seeded generator, so a failure can be run again.
    let seed = 7;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    let worst = 0;
    for (let round = 0; round < 60; round++) {
      // Up to 14 agents in a 700 by 300 area: busy, but not hopeless.
      const items = Array.from({ length: 4 + Math.floor(random() * 11) }, (_, index) =>
        tag(`r${round}-${index}`, 60 + random() * 600, 60 + random() * 240),
      );
      const result = placed(items, 800);
      worst = Math.max(worst, touching(result).length);
      for (const item of items) {
        const shift = result.get(item.id)!;
        expect(Math.abs(shift.left - item.box.left)).toBeLessThanOrEqual(MAX_SIDEWAYS);
        expect(shift.top - item.box.top).toBeLessThanOrEqual(MAX_DOWN);
      }
    }
    // Not one pair of the sixty floors is left touching.
    expect(worst).toBe(0);
  });

  it('reports shifts in whole pixels, so text is not blurred', () => {
    const shifts = spreadTags([tag('a', 100, 100), tag('b', 133, 100), tag('c', 171, 100)], 1000);
    for (const { dx, dy } of shifts.values()) {
      expect(Number.isInteger(dx)).toBe(true);
      expect(Number.isInteger(dy)).toBe(true);
    }
  });
});
