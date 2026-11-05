// SPDX-License-Identifier: Apache-2.0
import {
  BaseGrid,
  BenchColumns,
  BenchPitchX,
  BenchPitchY,
  type AgentDef,
  type AgentState,
  type LiveAgent,
} from '../gen/models.ts';

export const TILE = 32;
/** The prototype's office. The floor keeps this size until the desks or the lounge outgrow it. */
export const BASE_W = 1216;
export const BASE_H = 704;

export interface Point {
  x: number;
  y: number;
}

/**
 * Where a desk stands, in tiles. Mirrors DeskTile in internal/models/desks.go: the prototype's
 * four by four, row by row, then a ring at a time, a column on the right and then a row below.
 * Tests on both sides pin the same positions.
 */
export function deskTile(index: number): Point {
  let column = index % BaseGrid;
  let row = Math.floor(index / BaseGrid);
  if (index >= BaseGrid * BaseGrid) {
    let side = BaseGrid;
    while ((side + 1) * (side + 1) <= index) side++;
    const step = index - side * side;
    if (step <= side) {
      column = side;
      row = step;
    } else {
      column = step - side - 1;
      row = side;
    }
  }
  return { x: 8 + column * 5, y: 4 + row * 4 };
}

/** How many desks a side the grid needs to hold this many. Mirrors GridSide. */
export function gridSide(desks: number): number {
  let side = BaseGrid;
  while (side * side < desks) side++;
  return side;
}

/** Where a bench seat's desk is, in pixels from the first seat's. Mirrors BenchSeat. */
export function benchSeat(index: number): Point {
  return {
    x: (index % BenchColumns) * BenchPitchX,
    y: Math.floor(index / BenchColumns) * BenchPitchY,
  };
}

/** How far apart lounge seats are. */
export const LOUNGE_PITCH = { x: 116, y: 92 };
/** The height of the strip that holds an area's floor label, above its seats. */
const LABEL_BAND = 40;
/** The space below the lower floor for Mabari's reception desk and the door. */
const FOOTER = 120;
/** A bench row's desks, from the first seat's corner to the end of the last desk. */
export const BENCH_WIDTH = (BenchColumns - 1) * BenchPitchX + 68;

/**
 * The office floor's shape. The desk grid widens to the right, pushing the rooms along, and grows
 * down. When there are workflow sub-agents or anyone resting, a lower floor opens below the grid:
 * the workflow benches on the left and the lounge on the right, each growing down on its own.
 */
export interface Floor {
  width: number;
  height: number;
  /** Desks a side in the grid. */
  side: number;
  /** How far right the glass wall and the rooms moved for the grid's extra columns. */
  shift: number;
  /** Where the lower floor starts, or null when there is none. */
  lower: number | null;
  /** The workflow benches: the first seat's desk corner, and how many rows. */
  bench: { x: number; y: number; rows: number } | null;
  /** The lounge: its corner, where the first seat is, and its columns and rows. */
  lounge: { x: number; y: number; first: Point; columns: number; rows: number } | null;
  /** Changes whenever the background must be drawn again. */
  key: string;
}

/** The floor for this many desks and bench seats (highest index + 1) and lounge residents. */
export function floorFor(desks: number, benches: number, residents: number): Floor {
  const side = gridSide(desks);
  const shift = (side - BaseGrid) * 5 * TILE;
  const width = BASE_W + shift;
  const gridBottom = (4 + (side - 1) * 4) * TILE + 66;
  if (benches <= 0 && residents <= 0) {
    const height = Math.max(BASE_H, gridBottom + 126);
    return { width, height, side, shift, lower: null, bench: null, lounge: null, key: `${side}` };
  }
  const lower = Math.ceil(Math.max(672, gridBottom + 30) / TILE) * TILE;
  let bottom = lower;
  let bench: Floor['bench'] = null;
  if (benches > 0) {
    const rows = Math.ceil(benches / BenchColumns);
    bench = { x: 64, y: lower + LABEL_BAND + 16, rows };
    bottom = Math.max(bottom, bench.y + (rows - 1) * BenchPitchY + 70);
  }
  let lounge: Floor['lounge'] = null;
  if (residents > 0) {
    const x = bench ? bench.x + BENCH_WIDTH + 72 : 64;
    const columns = Math.max(1, Math.floor((width - 48 - x) / LOUNGE_PITCH.x));
    const rows = Math.ceil(residents / columns);
    const y = lower + LABEL_BAND;
    lounge = { x, y, first: { x: x + 44, y: y + 52 }, columns, rows };
    bottom = Math.max(bottom, y + rows * LOUNGE_PITCH.y + 16);
  }
  const height = bottom + FOOTER;
  const key = `${side}:${bench?.rows ?? 0}:${lounge ? `${lounge.x}:${lounge.rows}` : 0}`;
  return { width, height, side, shift, lower, bench, lounge, key };
}

/** The floor with nothing on it: the prototype's office. */
export const BASE_FLOOR = floorFor(0, 0, 0);

/** Where lounge seat `index` is: the point a resting character stands on. */
export function loungeSeat(floor: Floor, index: number): Point {
  const lounge = floor.lounge;
  if (!lounge) return { x: floor.width / 2, y: floor.height - 100 };
  return {
    x: lounge.first.x + (index % lounge.columns) * LOUNGE_PITCH.x,
    y: lounge.first.y + Math.floor(index / lounge.columns) * LOUNGE_PITCH.y,
  };
}

/** The corner of an agent's desk, in pixels: on the grid, or at the workflow benches. */
export function deskCorner(agent: Pick<LiveAgent, 'desk' | 'bench'>, floor: Floor): Point {
  if (agent.bench) {
    const offset = benchSeat(agent.desk);
    const origin = floor.bench ?? { x: 64, y: floor.height };
    return { x: origin.x + offset.x, y: origin.y + offset.y };
  }
  const tile = deskTile(agent.desk);
  return { x: tile.x * TILE, y: tile.y * TILE };
}

/** Where an agent sits at its desk, in front of the monitor. */
export function deskSeat(agent: Pick<LiveAgent, 'desk' | 'bench'>, floor: Floor): Point {
  const corner = deskCorner(agent, floor);
  return { x: corner.x + TILE, y: corner.y + 54 };
}

export type Location = 'desk' | 'cabinets' | 'server' | 'library' | 'meeting' | 'pantry' | 'lounge';

const ROOM_SPOTS: Record<'cabinets' | 'server' | 'library' | 'meeting' | 'pantry', Point[]> = {
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
};

/** The rooms on the right move along with the grid's extra columns. */
const RIGHT_ROOMS = new Set(['server', 'meeting', 'pantry']);

export function roomSpots(room: keyof typeof ROOM_SPOTS, floor: Floor): Point[] {
  const shift = RIGHT_ROOMS.has(room) ? floor.shift : 0;
  return ROOM_SPOTS[room].map((point) => ({ x: point.x + shift, y: point.y }));
}

/** The door, at the middle of the bottom wall. */
export function doorOf(floor: Floor): Point {
  return { x: floor.width / 2, y: floor.height - 6 };
}

/** Mabari's reception desk, just inside the door. */
export function receptionOf(floor: Floor): Point {
  return { x: floor.width / 2, y: floor.height - 52 };
}

/**
 * Where each state works. Work happens at the desk, where the monitor shows it. Agents walk only
 * when it means something: arriving, briefing a new subagent in the meeting room, and resting in
 * the lounge when idle (decision 37, as changed for the lounge).
 */
export const STATE_LOCATIONS: Record<AgentState, Location> = {
  thinking: 'desk',
  reading: 'desk',
  editing: 'desk',
  running: 'desk',
  browsing: 'desk',
  approval: 'desk',
  spawning: 'meeting',
  idle: 'lounge',
  done: 'desk',
  error: 'desk',
  paused: 'desk',
};

/** Agent definitions resting in the lounge: every one turned on with nothing running from it. */
export function restingDefs(defs: AgentDef[], agents: LiveAgent[]): AgentDef[] {
  const running = new Set(agents.filter((agent) => !agent.leaving).map((agent) => agent.defId));
  return defs
    .filter((def) => !def.system && def.enabled && !running.has(def.id))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** Where everyone sits: the floor's shape, and each lounge resident's seat. */
export interface Seating {
  floor: Floor;
  /** Lounge seats by agent id, or by "def:" and the definition's id. */
  lounge: Map<string, number>;
  /** The definitions resting in the lounge, in seat order. */
  resting: AgentDef[];
}

export const restKey = (def: AgentDef) => `def:${def.id}`;

/**
 * Seats everyone. Resting definitions take the first lounge seats, as they change least, then
 * idle agents in the order they arrived, so nobody shares a seat.
 */
export function seatingFor(agents: LiveAgent[], defs: AgentDef[]): Seating {
  let desks = 0;
  let benches = 0;
  for (const agent of agents) {
    if (agent.bench) benches = Math.max(benches, agent.desk + 1);
    else desks = Math.max(desks, agent.desk + 1);
  }
  const resting = restingDefs(defs, agents);
  const idle = agents
    .filter((agent) => STATE_LOCATIONS[agent.state] === 'lounge' && !agent.leaving)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const lounge = new Map<string, number>();
  resting.forEach((def, index) => lounge.set(restKey(def), index));
  idle.forEach((agent, index) => lounge.set(agent.id, resting.length + index));
  return { floor: floorFor(desks, benches, lounge.size), lounge, resting };
}

type Seated = Pick<LiveAgent, 'id' | 'state' | 'desk' | 'bench'>;

/** Where an agent stands in its state. `number` keeps agents in one room from sharing a spot. */
export function spotFor(agent: Seated, number: number, seating: Seating): Point {
  const location = STATE_LOCATIONS[agent.state] ?? 'desk';
  if (location === 'desk') return deskSeat(agent, seating.floor);
  if (location === 'lounge') return loungeSeat(seating.floor, seating.lounge.get(agent.id) ?? 0);
  const spots = roomSpots(location, seating.floor);
  return spots[number % spots.length]!;
}

/** The route to a spot: along a corridor, and through the gap in the wall for the right rooms. */
export function pathTo(from: Point, to: Point, floor: Floor = BASE_FLOOR): Point[] {
  if (Math.abs(from.x - to.x) < 1 && Math.abs(from.y - to.y) < 1) return [];
  const wall = 928 + floor.shift;
  // Below the glass wall the lower floor is open, so only the rooms above need the gap.
  const below = (point: Point) => floor.lower !== null && point.y >= floor.lower;
  const roomSide = (point: Point) => point.x > wall && !below(point);
  if (Math.abs(to.y - from.y) > 40) {
    if (roomSide(from) && roomSide(to)) {
      return [
        { x: from.x, y: to.y },
        { x: to.x, y: to.y },
      ];
    }
    let middle = from.x;
    if (roomSide(to) || roomSide(from)) middle = wall - 16;
    // Coming up from the lower floor, cross it first, then walk up to the desk.
    else if (below(from) && !below(to)) middle = to.x;
    return [
      { x: middle, y: from.y },
      { x: middle, y: to.y },
      { x: to.x, y: to.y },
    ];
  }
  const corridor = Math.min(Math.max(from.y, 90), floor.height - 40);
  return [
    { x: from.x, y: corridor },
    { x: to.x, y: corridor },
    { x: to.x, y: to.y },
  ];
}
