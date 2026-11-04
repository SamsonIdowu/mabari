// SPDX-License-Identifier: Apache-2.0
import type { AgentState } from '../gen/models.ts';

export const TILE = 32;
export const W = 1216;
export const H = 704;

export interface Point {
  x: number;
  y: number;
}

export const DESKS: Point[] = [4, 8, 12, 16].flatMap((y) => [8, 13, 18, 23].map((x) => ({ x, y })));

export type Location = 'desk' | 'cabinets' | 'server' | 'library' | 'meeting' | 'pantry';

export const SPOTS: Record<Exclude<Location, 'desk'> | 'door', Point[]> = {
  cabinets: [
    { x: 84, y: 118 },
    { x: 120, y: 118 },
    { x: 156, y: 118 },
  ],
  server: [
    { x: 986, y: 136 },
    { x: 1042, y: 136 },
    { x: 1092, y: 136 },
  ],
  library: [
    { x: 44, y: 574 },
    { x: 90, y: 568 },
    { x: 136, y: 574 },
  ],
  meeting: [
    { x: 1016, y: 362 },
    { x: 1078, y: 362 },
    { x: 1140, y: 362 },
  ],
  pantry: [
    { x: 996, y: 508 },
    { x: 1046, y: 520 },
    { x: 1106, y: 508 },
    { x: 1156, y: 520 },
  ],
  door: [{ x: 608, y: 698 }],
};

/**
 * Where each state works, as in the prototype. Work happens at the desk, where the monitor shows
 * it. Agents walk only when it means something: arriving, briefing a new subagent in the meeting
 * room, and the pantry when idle (decision 37, replacing decision 29).
 */
export const STATE_LOCATIONS: Record<AgentState, Location> = {
  thinking: 'desk',
  reading: 'desk',
  editing: 'desk',
  running: 'desk',
  browsing: 'desk',
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
    if (from.x > 928 && to.x > 928) {
      return [
        { x: from.x, y: to.y },
        { x: to.x, y: to.y },
      ];
    }
    const middle = to.x > 928 || from.x > 928 ? 912 : from.x;
    return [
      { x: middle, y: from.y },
      { x: middle, y: to.y },
      { x: to.x, y: to.y },
    ];
  }
  const corridor = Math.min(Math.max(from.y, 90), H - 40);
  return [
    { x: from.x, y: corridor },
    { x: to.x, y: corridor },
    { x: to.x, y: to.y },
  ];
}
