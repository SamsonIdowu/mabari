// SPDX-License-Identifier: Apache-2.0
// Mabari on Home reacts to how the pointer moves, as in design/mabari-prototype.html (the "mouse
// gestures" block): moving onto it waves, a wiggle shakes its head or makes it dance, up and down
// nods or jumps, circling spins it, and a fast flick away shrugs. This module only reads points
// and says which gesture to play; time is passed in, so tests can feed it point sequences.

export interface Point {
  x: number;
  y: number;
  /** Milliseconds, from Date.now() or a test clock. */
  t: number;
}

/** Where Mabari is drawn, in the same pixels as the points, and the stage's centre. */
export interface MascotBox {
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

export type PointerGesture = 'wave' | 'shake' | 'dance' | 'nod' | 'jump' | 'spin' | 'shrug';

/** Mabari is drawn 32 by 42 units, at this share of the largest size that fits the stage. */
const HOME_SCALE = 0.78;

/** Mabari's box inside the stage's canvas, as Home.tsx paints it. */
export function mascotBox(rect: {
  left: number;
  top: number;
  width: number;
  height: number;
}): MascotBox {
  const scale = Math.min(rect.width / 34, rect.height / 45) * HOME_SCALE;
  const w = 32 * scale;
  const h = 42 * scale;
  return {
    x: rect.left + (rect.width - w) / 2,
    y: rect.top + (rect.height - h) / 2,
    w,
    h,
    cx: rect.left + rect.width / 2,
    cy: rect.top + rect.height / 2,
  };
}

/** The prototype's numbers. */
export const GESTURE_GAP_MS = 1800;
export const WAVE_EVERY_MS = 8000;
/** Random idle gestures wait until the pointer has been still this long. */
export const POINTER_REST_MS = 6000;
const WINDOW_MS = 900;
const RING_INNER = 0.35;
const RING_OUTER = 2.2;
const ANGLE_DECAY = 0.995;
const FLICK_SPEED = 3;
const FLICK_LOOKBACK = 4;
const FLICK_FROM = 0.6;
const FLICK_TO = 1.6;
const WIGGLE_POINTS = 6;
const STEP_PX = 3;
const TURNS = 4;
const RANGE_PX = 40;
const DOMINANCE = 1.5;
const NEAR = 2.5;

export class MouseGestures {
  private points: Point[] = [];
  private last = Number.NEGATIVE_INFINITY;
  private inside = false;
  private waveAt = Number.NEGATIVE_INFINITY;
  private movedAt: number;
  private angle = 0;
  private lastAngle: number | null = null;

  constructor(now: number) {
    this.movedAt = now;
  }

  /** True while the pointer moved in the last few seconds, so idle gestures wait. */
  moving(now: number): boolean {
    return now - this.movedAt < POINTER_REST_MS;
  }

  /** The pointer left the page. */
  leave(): void {
    this.inside = false;
  }

  /**
   * Reads one pointer move and returns the gesture to play, or null. busy is true while Mabari is
   * listening or a gesture is still running: then nothing fires, as nothing may interrupt them.
   */
  move(point: Point, box: MascotBox, busy: boolean): PointerGesture | null {
    if (!box.w) return null;
    const now = point.t;
    this.movedAt = now;
    const inside =
      point.x > box.x && point.x < box.x + box.w && point.y > box.y && point.y < box.y + box.h;
    let fired: PointerGesture | null = null;
    if (inside && !this.inside && now - this.waveAt > WAVE_EVERY_MS) {
      this.waveAt = now;
      fired = this.fire('wave', now, busy);
    }
    this.inside = inside;
    if (fired) return fired;

    this.points.push(point);
    while (this.points.length && now - this.points[0]!.t > WINDOW_MS) this.points.shift();

    // Circling: add up the turn round the centre while inside the ring around Mabari.
    const dx = point.x - box.cx;
    const dy = point.y - box.cy;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    if (dist > box.w * RING_INNER && dist < box.w * RING_OUTER) {
      if (this.lastAngle !== null) {
        let step = angle - this.lastAngle;
        if (step > Math.PI) step -= 2 * Math.PI;
        if (step < -Math.PI) step += 2 * Math.PI;
        this.angle += step;
      }
      this.lastAngle = angle;
    } else {
      this.angle = 0;
      this.lastAngle = null;
    }
    this.angle *= ANGLE_DECAY;
    if (Math.abs(this.angle) > Math.PI * 2) return this.fire('spin', now, busy);

    const points = this.points;
    // A fast flick from on Mabari to well away from it.
    if (points.length >= 3) {
      const newest = points[points.length - 1]!;
      const before = points[Math.max(0, points.length - 1 - FLICK_LOOKBACK)]!;
      const speed =
        Math.hypot(newest.x - before.x, newest.y - before.y) / Math.max(1, newest.t - before.t);
      if (
        speed > FLICK_SPEED &&
        Math.hypot(newest.x - box.cx, newest.y - box.cy) > box.w * FLICK_TO &&
        Math.hypot(before.x - box.cx, before.y - box.cy) < box.w * FLICK_FROM
      ) {
        return this.fire('shrug', now, busy);
      }
    }

    // Wiggles: count the times the pointer turns back, across and up and down.
    if (points.length < WIGGLE_POINTS) return null;
    let across = 0;
    let upDown = 0;
    let signX = 0;
    let signY = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let index = 1; index < points.length; index += 1) {
      const step = points[index]!;
      const previous = points[index - 1]!;
      const stepX = step.x - previous.x;
      const stepY = step.y - previous.y;
      if (Math.abs(stepX) > STEP_PX) {
        const sign = stepX > 0 ? 1 : -1;
        if (signX && sign !== signX) across += 1;
        signX = sign;
      }
      if (Math.abs(stepY) > STEP_PX) {
        const sign = stepY > 0 ? 1 : -1;
        if (signY && sign !== signY) upDown += 1;
        signY = sign;
      }
      minX = Math.min(minX, step.x);
      maxX = Math.max(maxX, step.x);
      minY = Math.min(minY, step.y);
      maxY = Math.max(maxY, step.y);
    }
    const near = Math.hypot((minX + maxX) / 2 - box.cx, (minY + maxY) / 2 - box.cy) < box.w * NEAR;
    if (!near) return null;
    const width = maxX - minX;
    const height = maxY - minY;
    if (across >= TURNS && width > RANGE_PX && width > height * DOMINANCE) {
      return this.fire(inside ? 'shake' : 'dance', now, busy);
    }
    if (upDown >= TURNS && height > RANGE_PX && height > width * DOMINANCE) {
      return this.fire(inside ? 'nod' : 'jump', now, busy);
    }
    return null;
  }

  /** Plays a gesture unless one played under 1.8 s ago or Mabari is busy. */
  private fire(gesture: PointerGesture, now: number, busy: boolean): PointerGesture | null {
    if (now - this.last < GESTURE_GAP_MS || busy) return null;
    this.last = now;
    this.points = [];
    this.angle = 0;
    return gesture;
  }
}
