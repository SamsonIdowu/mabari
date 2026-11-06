// SPDX-License-Identifier: Apache-2.0
import type { Project } from '../gen/models.ts';
import { backRow, PAL, R } from './background.ts';
import { stableHash } from './resting.ts';
import type { Floor } from './layout.ts';

/**
 * The trophy shelf: every completed project puts a small pixel trophy in its own colour in a
 * glass case in the office's back row, in the order they were finished, so the office fills up with
 * what has been shipped. A case holds six, on two shelves, and replaces one of the bookshelves
 * along the back wall; a long office gets another case when the first is full. All drawn here
 * from small bitmaps, with no image files.
 */

/** A trophy is 7 cells wide and 8 tall, each cell 2 pixels. */
export const TROPHY = { width: 14, height: 16 } as const;
/** How many a case holds: three across, on two shelves. */
export const PER_CASE = 6;
/** A case stands where a bookshelf does: this wide, from the back wall down. */
const CASE = { width: 52, top: 54, front: 60, bottom: 100 } as const;

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

/** One trophy on the shelf: whose it is and where it stands, in world pixels. */
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

/** Where each case stands: the back row's bookshelves, from the left. */
export function caseSlots(floor: Floor): number[] {
  return backRow(floor.workEnd + 24)
    .filter((item) => item.kind === 'shelf')
    .map((item) => item.x);
}

/**
 * Where each trophy stands. Cases fill from the left, six to a case; when there are more
 * trophies than the back row has room for, the newest are shown and `hidden` says how many are
 * not.
 */
export function layout(
  floor: Floor,
  projects: Project[],
): { spots: Spot[]; hidden: number; cases: number } {
  const slots = caseSlots(floor);
  const all = trophiesOf(projects);
  const room = slots.length * PER_CASE;
  const shown = all.slice(Math.max(0, all.length - room));
  const spots = shown.map((project, index): Spot => {
    const at = index % PER_CASE;
    return {
      id: project.id,
      name: project.name,
      color: project.color,
      at: project.done!.at,
      x: slots[Math.floor(index / PER_CASE)]! + 4 + (at % 3) * 15,
      y: at < 3 ? 62 : 80,
    };
  });
  return { spots, hidden: all.length - shown.length, cases: Math.ceil(shown.length / PER_CASE) };
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
      if (cell) R(c, x + cx * 2, y + cy * 2, 2, 2, cell);
    }
  });
}

/** Draws the cases the trophies stand in, empty, over the bookshelves they replace. */
export function drawCases(
  c: CanvasRenderingContext2D,
  floor: Floor,
  cases: number,
  theme: 'dark' | 'light',
): void {
  const P = PAL[theme];
  const slots = caseSlots(floor).slice(0, cases);
  for (const x of slots) {
    // A shadow and a top that match the furniture round it, then a glass front with two shelves.
    c.fillStyle = P.shadow;
    c.fillRect(x + 3, CASE.bottom, CASE.width, 4);
    c.fillRect(x + CASE.width, CASE.top + 4, 3, CASE.bottom - CASE.top);
    R(c, x, CASE.top, CASE.width, CASE.bottom - CASE.top, P.woodD);
    R(c, x, CASE.top, CASE.width, CASE.front - CASE.top, P.wood);
    R(c, x, CASE.top, CASE.width, 1, P.deskEdge);
    R(c, x + 3, 62, CASE.width - 6, 36, theme === 'dark' ? '#0E0E10' : '#E4E4E1');
    R(c, x + 3, 78, CASE.width - 6, 2, P.wood);
    R(c, x + 3, 96, CASE.width - 6, 2, P.wood);
    c.fillStyle = P.glass;
    c.fillRect(x + 3, 62, CASE.width - 6, 36);
    R(c, x + 3, 62, CASE.width - 6, 1, 'rgba(255,255,255,.3)');
  }
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
  R(c, x + 10, y + 1, 2, 2, '#FFFFFF');
  R(c, x + 9, y + 2, 4, 0.5, '#FFFFFF');
  R(c, x + 11, y, 0.5, 4, '#FFFFFF');
}

/** The shelf as one picture, drawn again only when a project is completed or the floor changes. */
export interface Shelf {
  canvas: HTMLCanvasElement;
  spots: Spot[];
  hidden: number;
}

/**
 * Paints every case and trophy on a canvas the size of the floor's back wall, to be drawn each
 * frame in one go. The trophies are small and many, and painting each cell of each one every frame
 * would cost the floor more than it should.
 */
export function buildShelf(floor: Floor, projects: Project[], theme: 'dark' | 'light'): Shelf {
  const { spots, hidden, cases } = layout(floor, projects);
  const canvas = document.createElement('canvas');
  canvas.width = floor.width;
  canvas.height = CASE.bottom + 6;
  const c = canvas.getContext('2d')!;
  drawCases(c, floor, cases, theme);
  for (const spot of spots) drawTrophy(c, spot.id, spot.color, spot.x, spot.y, theme);
  return { canvas, spots, hidden };
}
