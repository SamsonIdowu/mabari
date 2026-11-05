// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { mascotBox, MouseGestures, type Point, type PointerGesture } from './mouseGestures.ts';

// A 340 by 450 stage: Mabari is 249.6 by 327.6, from (45.2, 61.2) to (294.8, 388.8), centred on
// (170, 225).
const box = mascotBox({ left: 0, top: 0, width: 340, height: 450 });

/** Feeds points in order and returns every gesture that fired. */
function feed(detector: MouseGestures, points: Point[], busy = false): PointerGesture[] {
  return points.map((point) => detector.move(point, box, busy)).filter((g) => g !== null);
}

/** Points every 25 ms from start, at the given positions. */
function path(start: number, positions: [number, number][]): Point[] {
  return positions.map(([x, y], index) => ({ x, y, t: start + index * 25 }));
}

/** A detector that has already waved, so the next gestures aren't the hover wave. */
function settled(): MouseGestures {
  const detector = new MouseGestures(0);
  detector.move({ x: 170, y: 225, t: 0 }, box, false);
  return detector;
}

const across = (y: number, from = 140, to = 200) =>
  Array.from({ length: 8 }, (_, i) => [i % 2 ? to : from, y] as [number, number]);
const upDown = (x: number) =>
  Array.from({ length: 8 }, (_, i) => [x, i % 2 ? 260 : 200] as [number, number]);

describe('mascotBox', () => {
  it('matches where Home paints Mabari', () => {
    expect(box.w).toBeCloseTo(249.6);
    expect(box.h).toBeCloseTo(327.6);
    expect(box.x).toBeCloseTo(45.2);
    expect(box.y).toBeCloseTo(61.2);
    expect([box.cx, box.cy]).toEqual([170, 225]);
  });
});

describe('MouseGestures', () => {
  it('waves when the pointer moves onto Mabari, at most every 8 s', () => {
    const detector = new MouseGestures(0);
    expect(
      feed(detector, [
        { x: 5, y: 5, t: 0 },
        { x: 170, y: 225, t: 100 },
      ]),
    ).toEqual(['wave']);
    expect(
      feed(detector, [
        { x: 5, y: 5, t: 3000 },
        { x: 170, y: 225, t: 3100 },
      ]),
    ).toEqual([]);
    expect(
      feed(detector, [
        { x: 5, y: 5, t: 9000 },
        { x: 170, y: 225, t: 9100 },
      ]),
    ).toEqual(['wave']);
  });

  it('shakes its head at a wiggle on Mabari and dances at one near it', () => {
    expect(feed(settled(), path(2000, across(225)))).toEqual(['shake']);
    expect(feed(settled(), path(2000, across(420)))).toEqual(['dance']);
  });

  it('nods at up and down on Mabari and jumps at it near Mabari', () => {
    expect(feed(settled(), path(2000, upDown(170)))).toEqual(['nod']);
    expect(feed(settled(), path(2000, upDown(320)))).toEqual(['jump']);
  });

  it('spins when the pointer circles round it', () => {
    const circle = Array.from({ length: 30 }, (_, i) => {
      const angle = (i * Math.PI) / 9;
      return [170 + 200 * Math.cos(angle), 225 + 200 * Math.sin(angle)] as [number, number];
    });
    expect(feed(settled(), path(2000, circle))).toEqual(['spin']);
  });

  it('shrugs at a fast flick away from it', () => {
    const flick: Point[] = [
      { x: 170, y: 225, t: 2000 },
      { x: 175, y: 225, t: 2010 },
      { x: 400, y: 225, t: 2020 },
      { x: 700, y: 225, t: 2030 },
    ];
    expect(feed(settled(), flick)).toEqual(['shrug']);
    // The same distance slowly is no flick.
    const slow = flick.map((point, index) => ({ ...point, t: 2000 + index * 400 }));
    expect(feed(settled(), slow)).toEqual([]);
  });

  it('ignores a wiggle far from Mabari', () => {
    expect(feed(settled(), path(2000, across(225, 900, 960)))).toEqual([]);
  });

  it('keeps gestures 1.8 s apart', () => {
    const detector = settled();
    expect(feed(detector, path(2000, across(225)))).toEqual(['shake']);
    expect(feed(detector, path(2300, across(225)))).toEqual([]);
    expect(feed(detector, path(4000, across(225)))).toEqual(['shake']);
  });

  it('never interrupts a running gesture or listening', () => {
    const detector = new MouseGestures(0);
    const onto = [
      { x: 5, y: 5, t: 0 },
      { x: 170, y: 225, t: 100 },
    ];
    expect(feed(detector, onto, true)).toEqual([]);
    expect(feed(settled(), path(2000, across(225)), true)).toEqual([]);
  });

  it('says the pointer is moving for 6 s after it last moved', () => {
    const detector = new MouseGestures(0);
    expect(detector.moving(5000)).toBe(true);
    expect(detector.moving(6500)).toBe(false);
    detector.move({ x: 1, y: 1, t: 7000 }, box, false);
    expect(detector.moving(12000)).toBe(true);
    expect(detector.moving(13001)).toBe(false);
  });
});
