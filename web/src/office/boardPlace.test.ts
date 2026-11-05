// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { agentFootprint, BOARD_KEEP_BOTTOM, BOARD_TOP, clearTop, type Rect } from './boardPlace.ts';

const stage = { width: 1125, height: 690 };
const card = { width: 280, height: 80, gap: 14, stage };
// The card at its usual place spans x 831 to 1111, y 66 to 146.
const lounger = (x: number, y: number): Rect => ({
  left: x - 40,
  right: x + 40,
  top: y,
  bottom: y + 36,
});

describe('where the approvals card sits', () => {
  it('stays at the top, under the wall bar, with nothing in its way', () => {
    expect(clearTop({ ...card, current: BOARD_TOP, obstacles: [] })).toBe(BOARD_TOP);
    // An agent at a desk, well to the left, is not in its way.
    expect(clearTop({ ...card, current: BOARD_TOP, obstacles: [lounger(300, 100)] })).toBe(
      BOARD_TOP,
    );
  });

  it('moves down the right edge to the first place that covers no agent', () => {
    // Bolt rests in the lounge at the top right, with Pixel lower down.
    const bolt = lounger(970, 80);
    const pixel = lounger(960, 330);
    const top = clearTop({ ...card, current: BOARD_TOP, obstacles: [bolt, pixel] });
    expect(top).toBeGreaterThan(bolt.bottom);
    expect(top + card.height).toBeLessThan(pixel.top);
    const at = { left: 831, right: 1111, top, bottom: top + card.height };
    for (const box of [bolt, pixel]) {
      expect(at.bottom <= box.top || at.top >= box.bottom).toBe(true);
    }
  });

  it('stays where it is while that covers nothing, so it does not follow agents about', () => {
    const bolt = lounger(970, 80);
    const placed = clearTop({ ...card, current: BOARD_TOP, obstacles: [bolt] });
    expect(placed).toBeGreaterThan(BOARD_TOP);
    // Bolt walks off. The card does not hop back up.
    expect(clearTop({ ...card, current: placed, obstacles: [] })).toBe(placed);
    // It goes on moving only when something comes under it.
    const under = lounger(970, placed + 20);
    expect(clearTop({ ...card, current: placed, obstacles: [under] })).not.toBe(placed);
  });

  it('takes the place that covers the fewest agents when none covers none, and keeps the bottom edge to itself', () => {
    // Two agents at the top, one lower down, and a stack that leaves no gap the card fits in.
    const crowd: Rect[] = [
      { left: 800, right: 1125, top: 0, bottom: 120 },
      { left: 800, right: 1125, top: 126, bottom: 220 },
      { left: 800, right: 1125, top: 226, bottom: 320 },
      { left: 800, right: 1125, top: 326, bottom: 600 },
    ];
    const top = clearTop({ ...card, current: BOARD_TOP, obstacles: crowd });
    const covers = (at: number) =>
      crowd.filter((box) => at < box.bottom + 6 && box.top < at + card.height + 6).length;
    expect(covers(top)).toBeLessThan(covers(BOARD_TOP));
    // Everything covered the same, it stays at the usual top.
    const wall: Rect[] = [{ left: 0, right: stage.width, top: 0, bottom: stage.height }];
    expect(clearTop({ ...card, current: 200, obstacles: wall })).toBe(BOARD_TOP);
    // However far it moves, it never comes down over the readout and the tool strip.
    const high: Rect = { left: 800, right: 1125, top: 0, bottom: 590 - card.height };
    const placed = clearTop({ ...card, current: BOARD_TOP, obstacles: [high] });
    expect(placed + card.height).toBeLessThanOrEqual(stage.height - BOARD_KEEP_BOTTOM);
  });

  it('keeps clear of an agent by a margin, not to the pixel', () => {
    const bolt = lounger(970, 80);
    const top = clearTop({ ...card, current: BOARD_TOP, obstacles: [bolt] });
    expect(top - bolt.bottom).toBeGreaterThanOrEqual(6);
  });

  it('takes an agent to cover the character above its tag, at the tags scale', () => {
    const tag: Rect = { left: 100, right: 190, top: 300, bottom: 336 };
    expect(agentFootprint(tag, 1)).toEqual({ ...tag, top: 244 });
    expect(agentFootprint(tag, 1.6).top).toBeCloseTo(300 - 89.6);
  });
});
