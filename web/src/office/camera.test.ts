// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  clampView,
  FRAME_SLACK,
  fitScale,
  frameView,
  fromScreen,
  homeView,
  nextZoom,
  PHONE_FIT,
  PHONE_WIDTH,
  teamView,
  toScreen,
  ZOOMS,
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

describe('fitScale on a phone', () => {
  it('draws the floor big enough to read, not squeezed whole into the width', () => {
    // 332 by 523 is the floor area of a 390 pixel phone, with the rail beside it.
    const phone = { width: 332, height: 523 };
    const whole = phone.width / W;
    expect(fitScale(phone)).toBeGreaterThan(whole * 2);
    expect(fitScale(phone)).toBeGreaterThanOrEqual(PHONE_FIT.min);
    expect(fitScale(phone)).toBeLessThanOrEqual(PHONE_FIT.max);
    // So an agent is about 24 pixels across and 33 tall, where it was 9 and 12: a face and a name
    // you can see.
    expect(fitScale(phone) * 32).toBeGreaterThan(22);
    expect(fitScale(phone) * 44).toBeGreaterThan(30);
  });

  it('shows the first desks and lets the rest be dragged to', () => {
    const phone = { width: 332, height: 523 };
    const world = sizeOf(floorFor(desksUpTo(22)));
    expect(visibleWorld(phone).width).toBeLessThan(world.width / 2);
    // Dragging reaches both ends, and no further.
    const visible = visibleWorld(phone);
    const end = clampView({ cx: 99999, cy: 352, s: 1 }, world, visible);
    expect(end.cx).toBe(world.width - visible.width / 2);
    expect(clampView({ cx: -99999, cy: 352, s: 1 }, world, visible).cx).toBe(visible.width / 2);
  });

  it('puts the floor right under the wall bar, so no screen is left empty above it', () => {
    const phone = { width: 332, height: 727 };
    const world = sizeOf(floorFor(desksUpTo(4)));
    const top = atRest({ x: 0, y: 44 }, phone, world);
    expect(top.y).toBeCloseTo(WALL_BAR, 3);
    // A wider screen still centres the floor.
    const wide = { width: 1124, height: 802 };
    expect(atRest({ x: 0, y: 44 }, wide, world).y).toBeGreaterThan(WALL_BAR + 20);
  });

  it('grows with a taller phone, up to a limit, and never past what the height allows', () => {
    const short = fitScale({ width: 332, height: 420 });
    const tall = fitScale({ width: 332, height: 900 });
    expect(tall).toBeGreaterThanOrEqual(short);
    expect(tall).toBeLessThanOrEqual(PHONE_FIT.max);
  });

  it('leaves every wider screen exactly as it was', () => {
    for (const width of [PHONE_WIDTH, 700, 1024, 1440]) {
      const size = { width, height: 800 };
      const across = size.width / W;
      const down = size.height / H;
      const low = Math.min(across, down);
      const high = Math.max(across, down);
      const base = high / low <= 1.1 ? high : low;
      expect(fitScale(size)).toBeCloseTo(Math.min(base, (size.height - WALL_BAR) / (H - 44)));
    }
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
    expect(small.width).toBeLessThanOrEqual(visible.width);
    for (const s of [0.5, 0.8, 1]) {
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

describe('framing a room', () => {
  const floor = floorFor({ taken: [0], working: [0] }, 0, ['meeting']);
  const world = sizeOf(floor);
  const room = { x0: floor.wall! - 16, x1: floor.width + 6, y0: 196, y1: 424 };
  const clear = { top: 156, bottom: 78 };
  const centre = { x: (room.x0 + room.x1) / 2, y: (room.y0 + room.y1) / 2 };

  /** Where the room's middle lands on screen, with the view the frame asks for. */
  function landed(size: Size) {
    const frame = frameView(room, size, world, clear);
    const home = homeView(size, world);
    const view: View = { cx: home.x + frame.pan.x, cy: home.y + frame.pan.y, s: frame.zoom };
    return { frame, matrix: viewMatrix(view, size, world), view };
  }

  it('puts the middle of the room in the middle of what the bars leave clear', () => {
    for (const size of [
      { width: 1124, height: 765 },
      { width: 900, height: 600 },
      { width: 1500, height: 900 },
    ]) {
      const { matrix } = landed(size);
      const at = toScreen(centre, matrix);
      expect(at.x).toBeCloseTo(size.width / 2, 3);
      expect(at.y).toBeCloseTo(clear.top + (size.height - clear.top - clear.bottom) / 2, 3);
    }
  });

  it('zooms in on a big screen, to a zoom the controls know, and never so far that tags swell', () => {
    const { frame } = landed({ width: 1124, height: 765 });
    expect(ZOOMS).toContain(frame.zoom);
    expect(frame.zoom).toBeGreaterThan(1);
    expect(frame.zoom).toBeLessThanOrEqual(2);
  });

  it('shows the whole room, with a margin, once clamped with the slack a party allows', () => {
    for (const size of [
      { width: 1124, height: 765 },
      { width: 700, height: 520 },
      { width: 332, height: 523 },
    ]) {
      const { frame, view } = landed(size);
      const clamped = clampView(view, world, visibleWorld(size), FRAME_SLACK);
      const matrix = viewMatrix(clamped, size, world);
      const topLeft = toScreen({ x: room.x0, y: room.y0 }, matrix);
      const bottomRight = toScreen({ x: room.x1, y: room.y1 }, matrix);
      expect(topLeft.x).toBeGreaterThanOrEqual(-0.5);
      expect(bottomRight.x).toBeLessThanOrEqual(size.width + 0.5);
      expect(topLeft.y).toBeGreaterThanOrEqual(clear.top - 0.5);
      expect(bottomRight.y).toBeLessThanOrEqual(size.height - clear.bottom + 0.5);
      expect(frame.zoom).toBeGreaterThan(0);
    }
  });

  it('needs the slack to put a room at the end of the office in the middle', () => {
    const size = { width: 1124, height: 765 };
    const { view } = landed(size);
    const strict = clampView(view, world, visibleWorld(size));
    const slack = clampView(view, world, visibleWorld(size), FRAME_SLACK);
    expect(slack.cx).toBe(view.cx);
    expect(strict.cx).toBeLessThan(view.cx);
  });
});

describe('the view clamp with slack', () => {
  const size = { width: 1000, height: 700 };
  it('adds nothing by default', () => {
    const wide = { width: 3000, height: 704 };
    const view: View = { cx: 99999, cy: 352, s: 1 };
    const visible = visibleWorld(size);
    expect(clampView(view, wide, visible).cx).toBe(wide.width - visible.width / 2);
    expect(clampView(view, wide, visible, 50).cx).toBe(wide.width - visible.width / 2 + 50);
  });
});
