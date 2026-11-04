// SPDX-License-Identifier: Apache-2.0
import { DESKS, H, W, type Point } from './layout.ts';

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

export const ZOOMS = [0.5, 0.65, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];
const FIT_INDEX = 3;

export function clampView(view: View): View {
  const halfW = W / 2 / view.s;
  const halfH = H / 2 / view.s;
  return {
    s: view.s,
    cx: halfW >= W / 2 ? W / 2 : Math.min(W - halfW, Math.max(halfW, view.cx)),
    cy: halfH >= H / 2 ? H / 2 : Math.min(H - halfH, Math.max(halfH, view.cy)),
  };
}

/** Fits the whole office into the canvas, centred. The floor is extended to fill what's left. */
export function viewMatrix(view: View, size: Size): Matrix {
  const fit = Math.min(size.width / W, size.height / H);
  const offsetX = (size.width - W * fit) / 2;
  const offsetY = (size.height - H * fit) / 2;
  return {
    a: fit * view.s,
    e: offsetX + fit * (W / 2 - view.cx * view.s),
    f: offsetY + fit * (H / 2 - view.cy * view.s),
  };
}

export function toScreen(point: Point, matrix: Matrix): Point {
  return { x: point.x * matrix.a + matrix.e, y: point.y * matrix.a + matrix.f };
}

export function fromScreen(point: Point, matrix: Matrix): Point {
  return { x: (point.x - matrix.e) / matrix.a, y: (point.y - matrix.f) / matrix.a };
}

/** The view that frames a lead's office: its desk and its subagents' desks. */
export function teamView(desks: number[]): View {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const desk of desks) {
    const position = DESKS[desk] ?? DESKS[0]!;
    x0 = Math.min(x0, position.x * 32 - 70);
    y0 = Math.min(y0, position.y * 32 - 80);
    x1 = Math.max(x1, position.x * 32 + 134);
    y1 = Math.max(y1, position.y * 32 + 100);
  }
  return {
    cx: (x0 + x1) / 2,
    cy: (y0 + y1) / 2,
    s: Math.min(2.1, W / (x1 - x0), H / (y1 - y0)),
  };
}

export function nextZoom(current: number, direction: number): number {
  const found = ZOOMS.indexOf(current);
  const index = found < 0 ? FIT_INDEX : found;
  return ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, index + direction))]!;
}
