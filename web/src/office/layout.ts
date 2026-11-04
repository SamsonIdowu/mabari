// SPDX-License-Identifier: Apache-2.0
import type { AgentState } from '../gen/models.ts';

export const TILE = 32;
export const W = 960;
export const H = 576;

export interface Point {
  x: number;
  y: number;
}

export const DESKS: Point[] = [4, 7, 10, 13].flatMap((y) => [8, 11, 14, 17].map((x) => ({ x, y })));

export type Location = 'desk' | 'cabinets' | 'server' | 'library' | 'meeting' | 'pantry';

export const SPOTS: Record<Exclude<Location, 'desk'> | 'door', Point[]> = {
  cabinets: [
    { x: 84, y: 118 },
    { x: 120, y: 118 },
    { x: 156, y: 118 },
  ],
  server: [
    { x: 730, y: 136 },
    { x: 786, y: 136 },
    { x: 836, y: 136 },
  ],
  library: [
    { x: 44, y: 446 },
    { x: 84, y: 440 },
    { x: 124, y: 446 },
  ],
  meeting: [
    { x: 760, y: 362 },
    { x: 822, y: 362 },
    { x: 884, y: 362 },
  ],
  pantry: [
    { x: 740, y: 508 },
    { x: 790, y: 520 },
    { x: 850, y: 508 },
    { x: 900, y: 520 },
  ],
  door: [{ x: 480, y: 570 }],
};

export const STATE_LOCATIONS: Record<AgentState, Location> = {
  thinking: 'desk',
  reading: 'cabinets',
  editing: 'desk',
  running: 'server',
  browsing: 'library',
  approval: 'desk',
  spawning: 'meeting',
  idle: 'pantry',
  done: 'desk',
  error: 'desk',
  paused: 'desk',
};

export function deskSeat(desk: number): Point {
  const position = DESKS[desk] ?? DESKS[0]!;
  return { x: (position.x + 1) * TILE, y: (position.y + 1) * TILE + 22 };
}

/** Where an agent stands in a state. `number` keeps agents in one room from sharing a spot. */
export function spotFor(state: AgentState, desk: number, number: number): Point {
  const location = STATE_LOCATIONS[state] ?? 'desk';
  if (location === 'desk') return deskSeat(desk);
  const spots = SPOTS[location];
  return spots[number % spots.length]!;
}

/** The route to a spot: along a corridor, and through the gap in the wall for the right rooms. */
export function pathTo(from: Point, to: Point): Point[] {
  if (Math.abs(from.x - to.x) < 1 && Math.abs(from.y - to.y) < 1) return [];
  if (Math.abs(to.y - from.y) > 40) {
    if (from.x > 672 && to.x > 672) {
      return [
        { x: from.x, y: to.y },
        { x: to.x, y: to.y },
      ];
    }
    const middle = to.x > 672 || from.x > 672 ? 660 : from.x;
    return [
      { x: middle, y: from.y },
      { x: middle, y: to.y },
      { x: to.x, y: to.y },
    ];
  }
  const corridor = Math.min(Math.max(from.y, 90), 540);
  return [
    { x: from.x, y: corridor },
    { x: to.x, y: corridor },
    { x: to.x, y: to.y },
  ];
}
