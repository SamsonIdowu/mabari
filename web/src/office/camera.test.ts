// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  clampView,
  fromScreen,
  nextZoom,
  teamView,
  toScreen,
  viewMatrix,
  type Size,
  type View,
} from './camera.ts';
import { H, W } from './layout.ts';

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
    const view = teamView([2, 6]);
    expect(view.s).toBeLessThanOrEqual(2.1);
    expect(view.s).toBeGreaterThan(1);
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
