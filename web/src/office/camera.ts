// SPDX-License-Identifier: Apache-2.0
import { BASE_H, BASE_W, type Point } from './layout.ts';

export interface View {
  cx: number;
  cy: number;
  s: number;
}

export interface Matrix {
  a: number;
  e: number;
  f: number;
}

export interface Size {
  width: number;
  height: number;
}

/** The prototype's office. The floor grows from here, so every function takes its real size. */
export const BASE_WORLD: Size = { width: BASE_W, height: BASE_H };

export const ZOOMS = [0.5, 0.65, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];
const FIT_INDEX = 3;

/**
 * Keeps a view on the office. `visible` is how much of the world shows at 100% (visibleWorld).
 * An office narrower than the view sits at its left edge, where the desks start, so it never
 * moves when it grows or shrinks; a wider one pans along.
 */
export function clampView(view: View, world: Size = BASE_WORLD, visible: Size = world): View {
  const W = world.width;
  const H = world.height;
  const halfW = visible.width / 2 / view.s;
  const halfH = visible.height / 2 / view.s;
  return {
    s: view.s,
    cx: halfW >= W / 2 ? halfW : Math.min(W - halfW, Math.max(halfW, view.cx)),
    cy: halfH >= H / 2 ? H / 2 : Math.min(H - halfH, Math.max(halfH, view.cy)),
  };
}

/** Within this ratio of shapes the prototype's office covers the view instead of fitting in it. */
const COVER_WITHIN = 1.1;

/**
 * The scale that shows the office at 100%: the prototype office's scale, so agents are as easy
 * to see however big or small the office is, never more than fits its floor under the wall bar.
 * It doesn't depend on the office's width, so nothing changes size as the office grows.
 */
export function fitScale(size: Size): number {
  const across = size.width / BASE_W;
  const down = size.height / BASE_H;
  const low = Math.min(across, down);
  const high = Math.max(across, down);
  const base = high / low <= COVER_WITHIN ? high : low;
  // Drawn small, the back wall gets thinner than the wall bar over it, so the floor below the
  // wall is fitted into the space under the bar.
  return Math.min(base, (size.height - WALL_BAR) / (BASE_H - BACK_WALL));
}

/** How much of the world shows at 100%, in world pixels. */
export function visibleWorld(size: Size): Size {
  const fit = fitScale(size);
  return { width: size.width / fit, height: size.height / fit };
}

/**
 * Where the view rests at 100% with no panning: the office's left end, where the desks start,
 * and its middle from top to bottom.
 */
export function homeView(size: Size, world: Size = BASE_WORLD): Point {
  const visible = visibleWorld(size);
  return { x: visible.width / 2, y: Math.min(world.height / 2, visible.height / 2) };
}

/** The wall bar over the top of the floor, in screen pixels (.wallbar in screens.css). */
export const WALL_BAR = 58;
/** The back wall's height in world pixels, which sits under the wall bar. */
const BACK_WALL = 44;

/** Shows the office in the canvas at fitScale times the zoom, centred on the view's point. */
export function viewMatrix(view: View, size: Size, world: Size = BASE_WORLD): Matrix {
  const fit = fitScale(size);
  const offsetX = (size.width - world.width * fit) / 2;
  // The floor starts below the wall bar, so its first row of desks is never hidden.
  const offsetY = Math.max((size.height - world.height * fit) / 2, WALL_BAR - BACK_WALL * fit);
  return {
    a: fit * view.s,
    e: offsetX + fit * (world.width / 2 - view.cx * view.s),
    f: offsetY + fit * (world.height / 2 - view.cy * view.s),
  };
}

export function toScreen(point: Point, matrix: Matrix): Point {
  return { x: point.x * matrix.a + matrix.e, y: point.y * matrix.a + matrix.f };
}

export function fromScreen(point: Point, matrix: Matrix): Point {
  return { x: (point.x - matrix.e) / matrix.a, y: (point.y - matrix.f) / matrix.a };
}

/** The view that frames a lead's office: the corners of its desk and its subagents' desks. */
export function teamView(corners: Point[], world: Size = BASE_WORLD): View {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const corner of corners) {
    x0 = Math.min(x0, corner.x - 70);
    y0 = Math.min(y0, corner.y - 80);
    x1 = Math.max(x1, corner.x + 134);
    y1 = Math.max(y1, corner.y + 100);
  }
  return {
    cx: (x0 + x1) / 2,
    cy: (y0 + y1) / 2,
    s: Math.min(2.1, world.width / (x1 - x0), world.height / (y1 - y0)),
  };
}

export function nextZoom(current: number, direction: number): number {
  const found = ZOOMS.indexOf(current);
  const index = found < 0 ? FIT_INDEX : found;
  return ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, index + direction))]!;
}
