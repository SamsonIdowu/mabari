// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  bubbleBox,
  CLEARANCE,
  MAX_LIFT,
  MAX_SETTLE,
  overlaps,
  placeBubbles,
  rowOf,
  tagBox,
  type Box,
  type BubbleItem,
} from './bubbles.ts';

const box = (left: number, top: number, width: number, height: number): Box => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

const bubble = (id: string, rank: number, at: Box, short?: Box): BubbleItem => ({
  id,
  rank,
  box: at,
  short,
});

const floor = 1000;
const stay = { lift: 0, shift: 0, short: false, hidden: false };

describe('the boxes tags and bubbles fill', () => {
  it('centres a tag under its anchor at scale 1, and a bubble over it', () => {
    expect(tagBox(100, 50, 80, 30, 1)).toEqual(box(60, 54, 80, 30));
    expect(bubbleBox(100, 50, 60, 20, 1)).toEqual(box(70, 30, 60, 20));
  });

  it('follows the transform the overlay really uses when scaled: translate, then scale', () => {
    // translate(-50%) happens inside the scale, so a scaled box is not centred on its anchor.
    const tag = tagBox(100, 50, 100, 40, 0.8);
    expect([tag.left, tag.right]).toEqual([100 + 50 - 80, 100 + 50]);
    expect(tag.bottom - tag.top).toBeCloseTo(32);
    const bub = bubbleBox(100, 50, 100, 40, 0.8);
    expect(bub.right - bub.left).toBeCloseTo(80);
    expect(bub.bottom).toBeCloseTo(50 + 40 * 0.2);
  });

  it('counts air as covering', () => {
    expect(overlaps(box(0, 0, 10, 10), box(11, 0, 10, 10))).toBe(false);
    expect(overlaps(box(0, 0, 10, 10), box(11, 0, 10, 10), 2)).toBe(true);
  });
});

describe('placing bubbles', () => {
  it('leaves bubbles that cover nothing where they are', () => {
    const result = placeBubbles(
      [bubble('a', 0, box(100, 100, 80, 30))],
      [box(300, 300, 50, 40)],
      floor,
    );
    expect(result.get('a')).toEqual(stay);
  });

  it('settles a bubble nearer its agent when it only grazes the tag above', () => {
    // The tag of the row above ends where the bubble starts, so only the air around it is missing.
    const tag = box(100, 60, 80, 40);
    const placed = placeBubbles([bubble('a', 0, box(100, 100, 80, 34))], [tag], floor).get('a')!;
    expect(placed.hidden).toBe(false);
    expect(placed.short).toBe(false);
    expect(placed.lift).toBeLessThan(0);
    expect(placed.lift).toBeGreaterThanOrEqual(-MAX_SETTLE);
    expect(100 - placed.lift - CLEARANCE).toBeGreaterThanOrEqual(tag.bottom);
  });

  it('lets a raised bubble come all the way down to the usual place to clear a tag', () => {
    // An error bubble is raised 26 pixels, so it has that much room to come back down.
    const tag = box(100, 60, 80, 55);
    const high = bubble('error', 2, box(100, 100, 80, 34));
    const stuck = placeBubbles([high], [tag], floor).get('error')!;
    const free = placeBubbles([{ ...high, settle: MAX_SETTLE + 26 }], [tag], floor).get('error')!;
    expect(stuck.lift).toBe(0);
    expect(free.lift).toBeLessThan(-MAX_SETTLE);
    expect(100 - free.lift).toBeGreaterThanOrEqual(tag.bottom + CLEARANCE);
  });

  it('cuts a bubble to one line when settling is not enough', () => {
    // Overlaps the tag above by 9 pixels: more than settling gives, less than a line.
    const tag = box(100, 60, 80, 49);
    const long = box(100, 100, 80, 38);
    const one = box(100, 114, 80, 24);
    const placed = placeBubbles([bubble('a', 0, long, one)], [tag], floor).get('a')!;
    expect(placed).toMatchObject({ short: true, hidden: false });
    expect(overlaps(box(100, 114 - placed.lift, 80, 24), tag, CLEARANCE)).toBe(false);
  });

  it('lifts a bubble that grazes a name tag below it until it clears it', () => {
    const tag = box(100, 128, 80, 40);
    const placed = placeBubbles([bubble('a', 0, box(100, 100, 80, 34))], [tag], floor).get('a')!;
    expect(placed.hidden).toBe(false);
    expect(placed.lift).toBeGreaterThan(0);
    expect(placed.lift).toBeLessThanOrEqual(MAX_LIFT);
    // It really clears: its bottom is above the tag's top, with the air kept around it.
    expect(100 + 34 - placed.lift + CLEARANCE).toBeLessThanOrEqual(tag.top);
  });

  it('hides a quiet bubble that sits on a name tag it cannot clear', () => {
    const result = placeBubbles(
      [bubble('a', 0, box(100, 100, 80, 34))],
      [box(100, 90, 80, 60)],
      floor,
    );
    expect(result.get('a')?.hidden).toBe(true);
  });

  it('never hides a bubble that needs you or answers you, even over a tag', () => {
    const tags = [box(100, 90, 80, 60)];
    const result = placeBubbles(
      [bubble('approval', 3, box(100, 100, 80, 34)), bubble('reply', 2, box(100, 100, 80, 34))],
      tags,
      floor,
    );
    expect(result.get('approval')?.hidden).toBe(false);
    expect(result.get('reply')?.hidden).toBe(false);
  });

  it('lets the higher rank keep its place and moves or hides the quieter bubble', () => {
    const items = [
      bubble('status', 0, box(100, 100, 80, 34)),
      bubble('ask', 3, box(100, 100, 80, 34)),
    ];
    const result = placeBubbles(items, [], floor);
    expect(result.get('ask')).toEqual(stay);
    // The status bubble moves clear of it, or steps aside, but never sits on it.
    const status = result.get('status')!;
    expect(status.hidden || status.lift !== 0).toBe(true);
  });

  it('keeps any two bubbles that are showing from covering each other', () => {
    const items = [
      bubble('first', 0, box(100, 100, 80, 34)),
      bubble('second', 0, box(110, 105, 80, 34)),
    ];
    const result = placeBubbles(items, [], floor);
    expect(result.get('first')).toEqual(stay);
    const second = result.get('second')!;
    if (!second.hidden) {
      const moved = box(110, 105 - second.lift, 80, 34);
      expect(overlaps(moved, box(100, 100, 80, 34), CLEARANCE)).toBe(false);
    }
  });

  it('slides a bubble back onto the floor at either edge', () => {
    const right = placeBubbles([bubble('a', 0, box(960, 100, 80, 30))], [], floor).get('a')!;
    expect(right.shift).toBe(floor - 4 - 1040);
    const left = placeBubbles([bubble('b', 0, box(-20, 100, 80, 30))], [], floor).get('b')!;
    expect(left.shift).toBe(24);
  });

  it('keeps a crowded floor clear and cheap: no showing quiet bubble covers a tag or another bubble', () => {
    // 96 agents in a grid, as many as the office holds, each with a tag and a two line bubble.
    // The numbers come from a small generator, so the floor is the same on every run.
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const tags: Box[] = [];
    const items: BubbleItem[] = [];
    for (let index = 0; index < 96; index++) {
      // `y` is where the agent stands: its tag hangs from there, and its bubble sits 48 above.
      const x = 100 + (index % 12) * 150;
      const y = 140 + Math.floor(index / 12) * 124;
      tags.push(tagBox(x, y, 100, 44, 1));
      const rank = next() < 0.1 ? 2 : 0;
      const wide = 90 + Math.floor(next() * 60);
      items.push(
        bubble(
          `b${index}`,
          rank,
          bubbleBox(x, y - 48, wide, 38, 1),
          bubbleBox(x, y - 48, wide, 24, 1),
        ),
      );
    }
    const started = performance.now();
    const placed = placeBubbles(items, tags, 1900);
    const took = performance.now() - started;
    // Far inside what a frame can spare: it runs for every bubble, every frame.
    expect(took).toBeLessThan(50);

    const shown = items.filter((item) => !placed.get(item.id)!.hidden && item.rank < 2);
    const boxOf = (item: BubbleItem) => {
      const at = placed.get(item.id)!;
      const base = at.short && item.short ? item.short : item.box;
      return {
        ...base,
        left: base.left + at.shift,
        right: base.right + at.shift,
        top: base.top - at.lift,
        bottom: base.bottom - at.lift,
      };
    };
    for (const item of shown) {
      for (const tag of tags) expect(overlaps(boxOf(item), tag)).toBe(false);
    }
    for (let first = 0; first < shown.length; first++) {
      for (let second = first + 1; second < shown.length; second++) {
        expect(overlaps(boxOf(shown[first]!), boxOf(shown[second]!))).toBe(false);
      }
    }
    // Some are still shown, so the rule thins a crowd and does not empty it.
    expect(shown.length).toBeGreaterThan(10);
  });

  it('reads the same every time for the same floor, so bubbles do not flicker', () => {
    const items = [
      bubble('a', 0, box(100, 100, 80, 34)),
      bubble('b', 1, box(120, 110, 80, 34)),
      bubble('c', 0, box(400, 100, 80, 34)),
    ];
    const tags = [box(90, 130, 80, 40)];
    expect([...placeBubbles(items, tags, floor)]).toEqual([...placeBubbles(items, tags, floor)]);
  });
});

// REV-4: a bubble cut to one line hangs from the same place, so at a scale above 1 its bottom edge
// is lower than the full bubble's. Only tags near the full box were looked at, so the short one
// could be put over a tag the search never saw.
describe('the one line bubble at a scale above 1', () => {
  const scale = 1.6;
  const full = bubbleBox(100, 100, 100, 60, scale);
  const short = bubbleBox(100, 100, 100, 20, scale);

  it('hangs lower than the full bubble, which is what the search missed', () => {
    expect(short.bottom).toBeGreaterThan(full.bottom + MAX_SETTLE + CLEARANCE);
  });

  it('keeps clear of a tag only the one line bubble reaches', () => {
    // One tag grazes the full bubble, so it must be cut short or lifted. Another is under the
    // short one only: it is past anything the full bubble's own box reaches.
    const grazed = box(full.left, full.top + 4, 160, 10);
    const below = box(short.left, short.bottom - 6, 160, 30);
    expect(overlaps(full, below, CLEARANCE + MAX_SETTLE)).toBe(false);
    expect(overlaps(short, below)).toBe(true);
    const item = bubble('a', 0, full, short);
    const result = placeBubbles([item], [grazed, below], floor).get('a')!;
    if (!result.hidden) {
      const shown = result.short ? short : full;
      const moved = {
        left: shown.left + result.shift,
        right: shown.right + result.shift,
        top: shown.top - result.lift,
        bottom: shown.bottom - result.lift,
      };
      expect(overlaps(moved, grazed)).toBe(false);
      expect(overlaps(moved, below)).toBe(false);
    }
  });

  it('uses the one line bubble when it does clear what is near it', () => {
    // Only the grazed tag is there: cutting the bubble short is the answer, as before.
    const grazed = box(full.left, full.top + 4, 160, 10);
    const result = placeBubbles([bubble('a', 0, full, short)], [grazed], floor).get('a')!;
    expect(result.hidden).toBe(false);
  });
});

// RT-11: with many agents at work, row after row of identical "Working out what to do next" bubbles
// is noise. A quiet bubble shows once for the same words in a row.
describe('identical quiet bubbles in a row', () => {
  const words = 'Working out what to do next';
  const quiet = (id: string, left: number, row = 0, text = words, rank = 0): BubbleItem => ({
    ...bubble(id, rank, box(left, 100 + row * 110, 80, 34)),
    text,
    row: rowOf(100 + row * 110),
  });
  const shown = (items: BubbleItem[]) => {
    const placed = placeBubbles(items, [], 2000);
    return items.filter((item) => !placed.get(item.id)!.hidden).map((item) => item.id);
  };

  it('shows one of seven, the leftmost', () => {
    const row = ['g', 'c', 'a', 'f', 'b', 'e', 'd'].map((id, index) =>
      quiet(id, 900 - index * 120),
    );
    // Their left edges run from 900 down to 180; the last, "d", is leftmost.
    expect(shown(row)).toEqual(['d']);
  });

  it('shows one for each row', () => {
    const items = [
      quiet('a1', 100, 0),
      quiet('a2', 300, 0),
      quiet('b1', 100, 1),
      quiet('b2', 300, 1),
      quiet('b3', 500, 1),
    ];
    expect(shown(items)).toEqual(['a1', 'b1']);
  });

  it('leaves different words in the same row alone', () => {
    const items = [
      quiet('a', 100, 0, 'Reading the config'),
      quiet('b', 300, 0, 'Running the tests'),
      quiet('c', 500, 0, words),
      quiet('d', 700, 0, words),
    ];
    expect(shown(items)).toEqual(['a', 'b', 'c']);
  });

  it('never thins what needs you, answers you, or an error, however many say the same', () => {
    for (const rank of [3, 2]) {
      const items = [quiet('a', 100, 0, 'Same', rank), quiet('b', 300, 0, 'Same', rank)];
      expect(shown(items), `rank ${rank}`).toEqual(['a', 'b']);
    }
    // Nor agents talking to each other.
    const talk = [quiet('a', 100, 0, 'Same', 1), quiet('b', 300, 0, 'Same', 1)];
    expect(shown(talk)).toEqual(['a', 'b']);
  });

  it('does not let a quiet bubble that is thinned away push anyone aside', () => {
    // b is the same words as a and sits over where c's bubble goes: with b gone, c stays put.
    const a = quiet('a', 100, 0);
    const b = quiet('b', 300, 0);
    const c = { ...quiet('c', 300, 0, 'Another thing'), box: box(300, 100, 80, 34) };
    const result = placeBubbles([a, b, c], [], 2000);
    expect(result.get('b')!.hidden).toBe(true);
    expect(result.get('c')).toEqual(stay);
  });

  it('thins nothing when there is no text or row to go by', () => {
    const plain = [bubble('a', 0, box(100, 100, 80, 34)), bubble('b', 0, box(300, 100, 80, 34))];
    expect(shown(plain)).toEqual(['a', 'b']);
  });

  it('puts agents on one row when their feet are the same height, and others on their own', () => {
    expect(rowOf(300)).toBe(rowOf(300.4));
    expect(rowOf(300)).not.toBe(rowOf(410));
  });
});
