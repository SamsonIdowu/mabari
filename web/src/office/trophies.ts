// SPDX-License-Identifier: Apache-2.0
import type { Project } from '../gen/models.ts';
import { backRow, backRowWidth, PAL, R } from './background.ts';
import { stableHash } from './resting.ts';
import type { Floor } from './layout.ts';

/**
 * The trophy display: every completed project puts a trophy in its own colour in a glass display
 * along the office's back row, in the order they were finished, so the office fills up with what
 * has been shipped. The display stands where the bookshelves, cabinets and printer do, and takes
 * their places from the left as it needs the room, so a first project makes a small case and a
 * long run of them a long one. When the whole row is full, the newest are shown and a "+N" tile
 * says how many are not. All drawn here from small bitmaps, with no image files.
 */

/** A trophy is 7 cells wide and 8 tall, each cell 4 pixels: as tall as an agent. */
const CELL = 4;
export const TROPHY = { width: 28, height: 32 } as const;
/** How far apart trophies stand, and the glass left clear before the first. */
export const PITCH = 34;
const PAD = 5;
/** The display, from the back wall's foot: its top, where the front begins, and its bottom. */
const CASE = { top: 53, front: 60, bottom: 102 } as const;
/** Where a trophy's top edge is, standing on the display's shelf. */
export const TROPHY_Y = 64;

/**
 * Bitmaps. `c` is the project's colour, `d` a darker shade of it, `l` a lighter one, `b` the
 * plinth. A different shape for each project, picked from its id so it never changes.
 */
const SHAPES: string[][] = [
  // a cup
  ['ddddddd', 'dcclccd', 'dcclccd', '.dcccd.', '..dcd..', '...c...', '..ddd..', '.bbbbb.'],
  // a star
  ['...c...', '..clc..', 'cccclcc', '.cclcc.', '..ccc..', '.ccdcc.', '..bbb..', '.bbbbb.'],
  // a rocket
  ['...c...', '..clc..', '..clc..', '.cclcc.', '.cdcdc.', 'dc.c.cd', '..ddd..', '.bbbbb.'],
  // a flag
  ['.cccccc', '.cllccc', '.clcccc', '.cccccc', '.d.....', '.d.....', '.d.....', 'bbbbbbb'],
  // a gem
  ['.ccccc.', 'cllcccc', 'ccclccc', '.ccccd.', '..cccd.', '...cd..', '....d..', '.bbbbb.'],
  // a medal
  ['d.....d', '.d...d.', '..dcd..', '.ccccc.', 'cclllcc', 'ccclccc', '.ccccc.', '..bbb..'],
];

export const trophyShape = (id: string): number => stableHash(id) % SHAPES.length;

/** Mixes a #RRGGBB colour with black (negative) or white (positive), as a share of the way. */
export function shade(hex: string, amount: number): string {
  const value = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#8E8E93';
  const channels = [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16));
  const target = amount < 0 ? 0 : 255;
  const mix = channels.map((channel) =>
    Math.round(channel + (target - channel) * Math.abs(amount))
      .toString(16)
      .padStart(2, '0'),
  );
  return `#${mix.join('')}`;
}

/** One trophy on the display: whose it is and where it stands, in world pixels. */
export interface Spot {
  id: string;
  name: string;
  color: string;
  /** When the project was completed. */
  at: number;
  x: number;
  y: number;
}

/** The completed projects, in the order they were finished, oldest first. */
export function trophiesOf(projects: Project[]): Project[] {
  return projects
    .filter(
      (project): project is Project & { done: NonNullable<Project['done']> } => !!project.done,
    )
    .sort((a, b) => a.done!.at - b.done!.at || a.id.localeCompare(b.id));
}

/** The furniture the display stands in the place of: the back row, from the left. */
function furniture(floor: Floor) {
  return backRow(floor.workEnd + 24).map((place) => ({
    from: place.x,
    to: place.x + backRowWidth(place.kind),
  }));
}

/** How many trophies a display `length` pixels long holds. */
export function capacityOf(length: number): number {
  return Math.max(0, Math.floor((length - 2 * PAD + (PITCH - TROPHY.width)) / PITCH));
}

/** The display's extent along the wall, in world pixels, and how many pieces of furniture it covers. */
export interface Run {
  x0: number;
  x1: number;
  pieces: number;
  /** How many trophies it holds, filled or not. */
  capacity: number;
}

/** Where the "+N" tile stands, when there are more trophies than the display holds. */
export interface More {
  x: number;
  y: number;
  hidden: number;
}

/**
 * How many trophies the whole back row can hold, which is as many as the display will ever show
 * on this floor. A wider office, with more columns of desks, holds more.
 */
export function roomFor(floor: Floor): number {
  const row = furniture(floor);
  return row.length ? capacityOf(row.at(-1)!.to - row[0]!.from) : 0;
}

/**
 * Where each trophy stands. They fill from the left. The display grows a piece of furniture at a
 * time as it fills, so it is always the smallest that holds them. When there are more trophies
 * than the whole row holds, the newest are shown, the last place is a "+N" tile, and `more` says
 * where it is and how many the display has no room for.
 */
export function layout(
  floor: Floor,
  projects: Project[],
): { spots: Spot[]; hidden: number; run: Run | null; more: More | null } {
  const all = trophiesOf(projects);
  const row = furniture(floor);
  if (!all.length || !row.length) return { spots: [], hidden: all.length, run: null, more: null };
  const x0 = row[0]!.from;
  const capacityAt = (pieces: number) => capacityOf(row[pieces - 1]!.to - x0);
  const most = capacityAt(row.length);
  const overflow = all.length > most;
  // With no room for them all, the last place is the "+N" tile.
  const shown = overflow ? all.slice(all.length - Math.max(0, most - 1)) : all;
  const needed = shown.length + (overflow ? 1 : 0);
  let pieces = 1;
  while (pieces < row.length && capacityAt(pieces) < needed) pieces++;
  const spots = shown.map((project, index): Spot => ({
    id: project.id,
    name: project.name,
    color: project.color,
    at: project.done!.at,
    x: x0 + PAD + index * PITCH,
    y: TROPHY_Y,
  }));
  const hidden = all.length - shown.length;
  return {
    spots,
    hidden,
    run: { x0, x1: row[pieces - 1]!.to, pieces, capacity: capacityAt(pieces) },
    more: hidden ? { x: x0 + PAD + shown.length * PITCH, y: TROPHY_Y, hidden } : null,
  };
}

/** Draws a trophy with its top left corner at x, y. */
export function drawTrophy(
  c: CanvasRenderingContext2D,
  id: string,
  colour: string,
  x: number,
  y: number,
  theme: 'dark' | 'light',
): void {
  const palette: Record<string, string> = {
    c: colour,
    d: shade(colour, -0.35),
    l: shade(colour, 0.45),
    b: theme === 'dark' ? '#6B6B72' : '#9A9A9E',
  };
  SHAPES[trophyShape(id)]!.forEach((row, cy) => {
    for (let cx = 0; cx < row.length; cx++) {
      const cell = palette[row[cx]!];
      if (cell) R(c, x + cx * CELL, y + cy * CELL, CELL, CELL, cell);
    }
  });
}

/**
 * Draws the glass display over the furniture it replaces, empty: a wood frame, a dark back, one
 * shelf, and a faint plinth in each place still to be filled, so you can see room for more.
 */
export function drawDisplay(
  c: CanvasRenderingContext2D,
  run: Run,
  filled: number,
  theme: 'dark' | 'light',
): void {
  const P = PAL[theme];
  const width = run.x1 - run.x0;
  // A shadow on the floor and down the right side, and a top that matches the furniture beside it.
  c.fillStyle = P.shadow;
  c.fillRect(run.x0 + 3, CASE.bottom, width, 4);
  c.fillRect(run.x1, CASE.top + 4, 3, CASE.bottom - CASE.top);
  R(c, run.x0, CASE.top, width, CASE.bottom - CASE.top, P.woodD);
  R(c, run.x0, CASE.top, width, CASE.front - CASE.top, P.wood);
  R(c, run.x0, CASE.top, width, 1, P.deskEdge);
  const back = theme === 'dark' ? '#0E0E10' : '#E4E4E1';
  R(c, run.x0 + 3, 62, width - 6, CASE.bottom - 2 - 62, back);
  R(c, run.x0 + 3, CASE.bottom - 4, width - 6, 2, P.wood);
  // Places still to fill, each with a quiet plinth.
  for (let slot = filled; slot < run.capacity; slot++) {
    const x = run.x0 + PAD + slot * PITCH;
    R(c, x + 6, TROPHY_Y + TROPHY.height - 3, 16, 3, theme === 'dark' ? '#25252A' : '#D2D2CE');
  }
  c.fillStyle = P.glass;
  c.fillRect(run.x0 + 3, 62, width - 6, CASE.bottom - 2 - 62);
  R(c, run.x0 + 3, 62, width - 6, 1, 'rgba(255,255,255,.3)');
}

/** A glint on the newest trophy for a few seconds after its project shipped. */
export function drawGlint(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  t: number,
  calm: boolean,
): void {
  const on = calm || Math.floor(t / 300) % 2 === 0;
  if (!on) return;
  R(c, x + 21, y - 1, 3, 3, '#FFFFFF');
  R(c, x + 19, y, 7, 1, '#FFFFFF');
  R(c, x + 22, y - 3, 1, 7, '#FFFFFF');
}

/** The display as one picture, drawn again only when a project is completed or the floor changes. */
export interface Shelf {
  canvas: HTMLCanvasElement;
  spots: Spot[];
  hidden: number;
  more: More | null;
}

/**
 * Paints the display and every trophy on a canvas the size of the floor's back wall, to be drawn
 * each frame in one go. The trophies are small and many, and painting each cell of each one every
 * frame would cost the floor more than it should.
 */
export function buildShelf(floor: Floor, projects: Project[], theme: 'dark' | 'light'): Shelf {
  const { spots, hidden, run, more } = layout(floor, projects);
  const canvas = document.createElement('canvas');
  canvas.width = floor.width;
  canvas.height = CASE.bottom + 6;
  const c = canvas.getContext('2d')!;
  if (run) {
    drawDisplay(c, run, spots.length + (more ? 1 : 0), theme);
    for (const spot of spots) drawTrophy(c, spot.id, spot.color, spot.x, spot.y, theme);
  }
  return { canvas, spots, hidden, more };
}
