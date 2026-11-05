// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  clampView,
  fitScale,
  fromScreen,
  homeView,
  nextZoom,
  teamView,
  toScreen,
  viewMatrix,
  visibleWorld,
  type Size,
  type View,
  WALL_BAR,
} from './camera.ts';
import { BASE_H as H, BASE_W as W, deskCorner, desksUpTo, floorFor } from './layout.ts';

const sizeOf = (floor: { width: number; height: number }): Size => ({
  width: floor.width,
  height: floor.height,
});

/** Where a world point is on screen with the view at rest. */
const atRest = (point: { x: number; y: number }, size: Size, world: Size) => {
  const home = homeView(size, world);
  return toScreen(point, viewMatrix({ cx: home.x, cy: home.y, s: 1 }, size, world));
};

describe('fitScale', () => {
  it("is the prototype office's scale, whatever the office's size", () => {
    // 1216 x 704 is the prototype's office; its floor fits under the wall bar.
    expect(fitScale({ width: W, height: H })).toBeCloseTo((H - WALL_BAR) / (H - 44));
    expect(fitScale({ width: W * 2, height: 2000 })).toBeCloseTo(2);
    expect(fitScale({ width: W / 2, height: 1000 })).toBeCloseTo(0.5);
  });
});

describe('the office at rest', () => {
  const sizes: Size[] = [
    { width: 1200, height: 760 },
    { width: 1800, height: 700 },
    { width: 400, height: 800 },
  ];

  it('sits at the left, so it never moves as it grows or shrinks, or a room opens', () => {
    const small = sizeOf(floorFor(desksUpTo(2)));
    const big = sizeOf(floorFor(desksUpTo(40), 9, ['meeting']));
    for (const size of sizes) {
      const desk = deskCorner({ desk: 0 });
      const before = atRest(desk, size, small);
      const after = atRest(desk, size, big);
      expect(after.x).toBeCloseTo(before.x);
      expect(after.y).toBeCloseTo(before.y);
      expect(atRest({ x: 0, y: 0 }, size, small).x).toBeCloseTo(0);
    }
  });

  it('keeps the floor below the wall bar, so the first row of desks shows', () => {
    const world = sizeOf(floorFor(desksUpTo(40), 9, ['meeting']));
    for (const size of sizes.slice(0, 2)) {
      expect(atRest({ x: 0, y: 44 }, size, world).y).toBeGreaterThanOrEqual(WALL_BAR - 0.001);
      expect(atRest({ x: 0, y: H }, size, world).y).toBeLessThanOrEqual(size.height + 0.001);
    }
  });
});

describe('toScreen and fromScreen', () => {
  const sizes: Size[] = [
    { width: 1920, height: 840 },
    { width: 1016, height: 460 },
  ];
  const views: View[] = [
    { cx: W / 2, cy: H / 2, s: 1 },
    { cx: 300, cy: 200, s: 2 },
  ];

  it.each(sizes)('round trip so clicks hit what is drawn at %o', (size) => {
    for (const view of views) {
      const matrix = viewMatrix(view, size);
      const back = fromScreen(toScreen({ x: 123, y: 456 }, matrix), matrix);
      expect(back.x).toBeCloseTo(123);
      expect(back.y).toBeCloseTo(456);
    }
  });
});

describe('clampView', () => {
  const world = sizeOf(floorFor(desksUpTo(60), 30, ['meeting']));
  const size = { width: 1200, height: 760 };
  const visible = visibleWorld(size);

  it('pans a wide office to either end at 100%, and no further', () => {
    expect(world.width).toBeGreaterThan(visible.width);
    expect(clampView({ cx: 99999, cy: 99999, s: 1 }, world, visible)).toEqual({
      cx: world.width - visible.width / 2,
      cy: H / 2,
      s: 1,
    });
    expect(clampView({ cx: -5, cy: 0, s: 1 }, world, visible).cx).toBe(visible.width / 2);
  });

  it('keeps a zoomed view inside the office', () => {
    const zoomed = clampView({ cx: 0, cy: 0, s: 2 }, world, visible);
    expect(zoomed.cx).toBe(visible.width / 4);
    expect(zoomed.cy).toBe(visible.height / 4);
  });

  it('holds a small office at its left edge, even zoomed', () => {
    const small = sizeOf(floorFor(desksUpTo(2)));
    for (const s of [0.5, 1, 1.25]) {
      expect(clampView({ cx: 999, cy: 999, s }, small, visible).cx).toBe(visible.width / 2 / s);
    }
  });
});

describe('teamView', () => {
  it('frames a lead and its subagent, and never zooms past 210%', () => {
    const corners = [2, 6].map((desk) => deskCorner({ desk }));
    const view = teamView(corners, visibleWorld({ width: 1200, height: 760 }));
    expect(view.s).toBeLessThanOrEqual(2.1);
    expect(view.s).toBeGreaterThan(1);
  });

  it('frames a team at the far end of the desks', () => {
    const corners = [56, 57].map((desk) => deskCorner({ desk }));
    const view = teamView(corners, visibleWorld({ width: 1200, height: 760 }));
    expect(view.cx).toBeGreaterThan(1200);
  });
});

describe('nextZoom', () => {
  it('steps through the levels and stops at the ends', () => {
    expect(nextZoom(1, 1)).toBe(1.25);
    expect(nextZoom(3, 1)).toBe(3);
    expect(nextZoom(1, -1)).toBe(0.8);
    expect(nextZoom(0.5, -1)).toBe(0.5);
    expect(nextZoom(2, -1)).toBe(1.5);
    expect(nextZoom(1.1, 1)).toBe(1.25);
  });
});
