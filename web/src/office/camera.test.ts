// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  clampView,
  fitScale,
  fromScreen,
  nextZoom,
  teamView,
  toScreen,
  viewMatrix,
  type Size,
  type View,
  WALL_BAR,
} from './camera.ts';
import { BASE_H as H, BASE_W as W, deskCorner, floorFor } from './layout.ts';

const whole: View = { cx: W / 2, cy: H / 2, s: 1 };

describe('viewMatrix', () => {
  it('maps the office one to one at its natural size', () => {
    expect(viewMatrix(whole, { width: W, height: H })).toEqual({ a: 1, e: 0, f: 0 });
  });

  it('fits a wide area by height and centres the office', () => {
    const matrix = viewMatrix(whole, { width: W * 2, height: H });
    expect(matrix.a).toBe(1);
    expect(matrix.e).toBe(W / 2);
    expect(matrix.f).toBe(0);
  });

  it('fits a tall area by width', () => {
    const matrix = viewMatrix(whole, { width: W / 2, height: 1000 });
    expect(matrix.a).toBe(0.5);
    expect(matrix.e).toBe(0);
    expect(matrix.f).toBe((1000 - H / 2) / 2);
  });
});

describe('toScreen and fromScreen', () => {
  const sizes: Size[] = [
    { width: 1920, height: 840 },
    { width: 1016, height: 460 },
  ];
  const views: View[] = [whole, { cx: 300, cy: 200, s: 2 }];

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
  it('keeps a zoomed view inside the office', () => {
    expect(clampView({ cx: 0, cy: 0, s: 2 })).toEqual({ cx: W / 4, cy: H / 4, s: 2 });
    expect(clampView({ cx: 9999, cy: 9999, s: 2 })).toEqual({
      cx: (W * 3) / 4,
      cy: (H * 3) / 4,
      s: 2,
    });
  });

  it('centres the whole office at 100%', () => {
    expect(clampView({ cx: 10, cy: 10, s: 1 })).toEqual(whole);
  });
});

describe('teamView', () => {
  it('frames a lead and its subagent, and never zooms past 210%', () => {
    const corners = [2, 6].map((desk) => deskCorner({ desk, bench: false }, floorFor(0, 0, 0)));
    const view = teamView(corners);
    expect(view.s).toBeLessThanOrEqual(2.1);
    expect(view.s).toBeGreaterThan(1);
  });
});

describe('a bigger office', () => {
  const floor = floorFor(40, 8, 30);
  const world = { width: floor.width, height: floor.height };

  it('still fits whole at 100%, zooming out further', () => {
    const size = { width: 1200, height: 760 };
    const fit = fitScale(size, world);
    expect(fit).toBeLessThan(fitScale(size));
    expect(floor.width * fit).toBeLessThanOrEqual(size.width * 1.1);
    expect(floor.height * fit).toBeLessThanOrEqual(size.height * 1.1);
    const matrix = viewMatrix({ cx: floor.width / 2, cy: floor.height / 2, s: 1 }, size, world);
    const corner = toScreen({ x: floor.width, y: floor.height }, matrix);
    expect(corner.x).toBeLessThanOrEqual(size.width + 1);
    expect(corner.y).toBeLessThanOrEqual(size.height * 1.1);
  });

  it('keeps the floor below the wall bar, so the first row of desks shows', () => {
    for (const size of [
      { width: 1200, height: 760 },
      { width: 1800, height: 700 },
    ]) {
      const matrix = viewMatrix({ cx: floor.width / 2, cy: floor.height / 2, s: 1 }, size, world);
      expect(toScreen({ x: 0, y: 44 }, matrix).y).toBeGreaterThanOrEqual(WALL_BAR - 0.001);
      expect(toScreen({ x: 0, y: floor.height }, matrix).y).toBeLessThanOrEqual(
        size.height + 0.001,
      );
    }
  });

  it('pans over the whole floor when zoomed in', () => {
    expect(clampView({ cx: 99999, cy: 99999, s: 2 }, world)).toEqual({
      cx: (floor.width * 3) / 4,
      cy: (floor.height * 3) / 4,
      s: 2,
    });
  });

  it('frames a team at the workflow benches', () => {
    const corners = [0, 1].map((desk) => deskCorner({ desk, bench: true }, floor));
    const view = teamView(corners, world);
    expect(view.cy).toBeGreaterThan(floor.lower!);
  });
});

describe('clampView when zoomed out', () => {
  it('keeps the office centred', () => {
    expect(clampView({ cx: 10, cy: 900, s: 0.5 })).toEqual({ cx: W / 2, cy: H / 2, s: 0.5 });
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

describe('fitScale', () => {
  it('covers the view when the shapes are within 10%, so no empty bands show', () => {
    // 1216 x 704 is the office. A view 5% wider than the office's shape covers it.
    expect(fitScale({ width: 1216 * 1.05, height: 704 })).toBeCloseTo(1.05);
    expect(fitScale({ width: 1216, height: 704 * 1.1 })).toBeCloseTo(1.1);
  });

  it('fits inside when the shapes differ by more than 10%', () => {
    expect(fitScale({ width: 1216 * 1.5, height: 704 })).toBeCloseTo(1);
    expect(fitScale({ width: 608, height: 704 })).toBeCloseTo(0.5);
  });
});
