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
 * Keeps a view on the office. `visible` is how much of the world shows at 100%: the whole office,
 * unless it is wider than the view (see visibleWorld), and then the view can pan along it.
 */
export function clampView(view: View, world: Size = BASE_WORLD, visible: Size = world): View {
  const W = world.width;
  const H = world.height;
  const halfW = visible.width / 2 / view.s;
  const halfH = visible.height / 2 / view.s;
  return {
    s: view.s,
    cx: halfW >= W / 2 ? W / 2 : Math.min(W - halfW, Math.max(halfW, view.cx)),
    cy: halfH >= H / 2 ? H / 2 : Math.min(H - halfH, Math.max(halfH, view.cy)),
  };
}

/** Within this ratio of shapes the office covers the view instead of fitting inside it. */
const COVER_WITHIN = 1.1;

/**
 * The scale that shows the office at 100%. When the view and the office are nearly the same shape
 * (10% or less apart) it covers the view, trimming a little of the outer walls, so no empty bands
 * show. Otherwise it fits inside and the floor is extended to fill what's left. A bigger office
 * fits the same way, so 100% always shows the whole floor.
 */
export function fitScale(size: Size, world: Size = BASE_WORLD): number {
  const across = size.width / BASE_W;
  const down = size.height / BASE_H;
  const low = Math.min(across, down);
  const high = Math.max(across, down);
  const base = high / low <= COVER_WITHIN ? high : low;
  if (!grown(world)) return base;
  // A wider office is drawn at the prototype office's scale, so its agents stay as easy to see,
  // and the view pans along it. Its floor fits under the wall bar, as the back wall would get
  // thinner than the bar over it otherwise.
  return Math.min(base, (size.height - WALL_BAR) / (world.height - BACK_WALL));
}

/** How much of the world shows at 100%, in world pixels. */
export function visibleWorld(size: Size, world: Size = BASE_WORLD): Size {
  if (!grown(world)) return world;
  const fit = fitScale(size, world);
  return { width: size.width / fit, height: size.height / fit };
}

/**
 * Where the view rests at 100% with no panning: the middle of the office when it all shows, or
 * its left end, where the desks start, when it is wider than the view.
 */
export function homeView(size: Size, world: Size = BASE_WORLD): Point {
  const visible = visibleWorld(size, world);
  return {
    x: Math.min(world.width / 2, visible.width / 2),
    y: Math.min(world.height / 2, visible.height / 2),
  };
}

/** The wall bar over the top of the floor, in screen pixels (.wallbar in screens.css). */
export const WALL_BAR = 58;
/** The back wall's height in world pixels, which sits under the wall bar. */
const BACK_WALL = 44;

/** Whether the floor grew past the prototype's office. */
const grown = (world: Size) => world.width > BASE_W || world.height > BASE_H;

/** Shows the office in the canvas, centred, at fitScale times the zoom. */
export function viewMatrix(view: View, size: Size, world: Size = BASE_WORLD): Matrix {
  const fit = fitScale(size, world);
  const offsetX = (size.width - world.width * fit) / 2;
  let offsetY = (size.height - world.height * fit) / 2;
  // A grown floor starts below the wall bar, so its first row of desks is never hidden.
  if (grown(world)) offsetY = Math.max(offsetY, WALL_BAR - BACK_WALL * fit);
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
