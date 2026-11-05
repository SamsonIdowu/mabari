// SPDX-License-Identifier: Apache-2.0
import {
  BaseGrid,
  BenchRows,
  BenchPitchX,
  BenchPitchY,
  type AgentDef,
  type AgentState,
  type LiveAgent,
} from '../gen/models.ts';

export const TILE = 32;

const floorLists = new WeakMap<LiveAgent[], LiveAgent[]>();

/**
 * The agents the office shows. A workflow sub-agent that isn't on duty has no seat (desk -1, the
 * server's OffFloor), so it isn't on the floor. The same list comes back for the same agents, so
 * callers can tell when it changed.
 */
export function onFloor(agents: LiveAgent[]): LiveAgent[] {
  let shown = floorLists.get(agents);
  if (!shown) {
    shown = agents.some((agent) => agent.desk < 0)
      ? agents.filter((agent) => agent.desk >= 0)
      : agents;
    floorLists.set(agents, shown);
  }
  return shown;
}
/** The prototype's office. The floor keeps this size until the desks or the lounge outgrow it. */
export const BASE_W = 1216;
export const BASE_H = 704;

export interface Point {
  x: number;
  y: number;
}

/**
 * Where a desk stands, in tiles. Mirrors DeskTile in internal/models/desks.go: the prototype's
 * four by four, row by row, then a column of four at a time on the right, top to bottom. The grid
 * never grows down. Tests on both sides pin the same positions.
 */
export function deskTile(index: number): Point {
  let column = index % BaseGrid;
  let row = Math.floor(index / BaseGrid);
  if (index >= BaseGrid * BaseGrid) {
    column = Math.floor(index / BaseGrid);
    row = index % BaseGrid;
  }
  return { x: 8 + column * 5, y: 4 + row * 4 };
}

/** How many columns of desks the grid needs to hold this many. Mirrors GridColumns. */
export function gridColumns(desks: number): number {
  return Math.max(BaseGrid, Math.ceil(desks / BaseGrid));
}

/** Where a bench seat's desk is, in pixels from the first seat's. Mirrors BenchSeat. */
export function benchSeat(index: number): Point {
  return {
    x: Math.floor(index / BenchRows) * BenchPitchX,
    y: (index % BenchRows) * BenchPitchY,
  };
}

/** How far apart lounge seats are. */
export const LOUNGE_PITCH = { x: 144, y: 108 };
/** The lounge's rows of armchairs. It grows a column at a time, to the right. */
export const LOUNGE_ROWS = 5;
/** Where an area's floor label sits, and where its first row starts. */
export const LABEL_Y = 84;
const FIRST_ROW = 128;
/** The glass wall in front of the rooms, in the prototype's office. */
const WALL_X = 928;
/** The narrowest an area gets, so its floor label fits. */
const AREA_MIN = 200;
/** The space between areas on the floor. */
const GAP = 48;

/** The width of `columns` columns of bench seats, from the first desk's corner to the last's end. */
export const benchWidth = (columns: number) => (columns - 1) * BenchPitchX + 68;

/**
 * The office floor's shape. The office keeps the prototype's height, so its agents never shrink,
 * and grows only to the right. Left to right: the desk grid, which gains a column of four desks
 * at a time; the workflow sub-agents' benches, when any are at work; the lounge, when anyone
 * rests; then the glass wall and the rooms, which move along to make space.
 */
export interface Floor {
  width: number;
  height: number;
  /** Columns of desks in the grid. */
  columns: number;
  /** How far right the glass wall and the rooms moved. */
  shift: number;
  /** The door and Mabari's reception desk, below the middle of the desk grid. */
  door: number;
  /** The workflow benches: the first seat's desk corner, the area's left edge, and its columns. */
  bench: { x: number; y: number; left: number; columns: number } | null;
  /** The lounge: its left edge, where the first seat is, and its columns and rows. */
  lounge: { x: number; first: Point; columns: number; rows: number } | null;
  /** Changes whenever the background must be drawn again. */
  key: string;
}

/** The floor for this many desks and bench seats (highest index + 1) and lounge residents. */
export function floorFor(desks: number, benches: number, residents: number): Floor {
  const columns = gridColumns(desks);
  const gridShift = (columns - BaseGrid) * 5 * TILE;
  // From the end of the grid's last desk, each area takes its own stretch of floor.
  let cursor = (8 + (columns - 1) * 5) * TILE + 68 + 56;
  let bench: Floor['bench'] = null;
  if (benches > 0) {
    const benchColumns = Math.ceil(benches / BenchRows);
    bench = { x: cursor + 24, y: FIRST_ROW, left: cursor, columns: benchColumns };
    cursor += Math.max(AREA_MIN, benchWidth(benchColumns) + 48) + GAP;
  }
  let lounge: Floor['lounge'] = null;
  if (residents > 0) {
    const loungeColumns = Math.ceil(residents / LOUNGE_ROWS);
    const rows = Math.min(residents, LOUNGE_ROWS);
    lounge = { x: cursor, first: { x: cursor + 44, y: 148 }, columns: loungeColumns, rows };
    cursor += Math.max(AREA_MIN, loungeColumns * LOUNGE_PITCH.x) + GAP;
  }
  // The rooms move along whole tiles, as the floor's tiles are drawn on that grid.
  const shift = Math.ceil(Math.max(gridShift, cursor + 24 - WALL_X) / TILE) * TILE;
  const key = `${columns}:${bench?.columns ?? 0}:${lounge ? `${lounge.columns}:${lounge.rows}` : 0}`;
  return {
    width: BASE_W + shift,
    height: BASE_H,
    columns,
    shift,
    door: BASE_W / 2 + gridShift / 2,
    bench,
    lounge,
    key,
  };
}

/** The floor with nothing on it: the prototype's office. */
export const BASE_FLOOR = floorFor(0, 0, 0);

/** Where lounge seat `index` is: the point a resting character stands on. */
export function loungeSeat(floor: Floor, index: number): Point {
  const lounge = floor.lounge;
  if (!lounge) return receptionOf(floor);
  return {
    x: lounge.first.x + Math.floor(index / LOUNGE_ROWS) * LOUNGE_PITCH.x,
    y: lounge.first.y + (index % LOUNGE_ROWS) * LOUNGE_PITCH.y,
  };
}

/** The corner of an agent's desk, in pixels: on the grid, or at the workflow benches. */
export function deskCorner(agent: Pick<LiveAgent, 'desk' | 'bench'>, floor: Floor): Point {
  if (agent.bench) {
    const offset = benchSeat(agent.desk);
    const origin = floor.bench ?? { x: floor.width - 160, y: FIRST_ROW };
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

/** The door, in the bottom wall below the desk grid. */
export function doorOf(floor: Floor): Point {
  return { x: floor.door, y: floor.height - 6 };
}

/** Mabari's reception desk, just inside the door. */
export function receptionOf(floor: Floor): Point {
  return { x: floor.door, y: floor.height - 52 };
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
    if (agent.desk < 0) continue;
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

/** The route to a spot: along a corridor, and through the gap in the wall for the rooms. */
export function pathTo(from: Point, to: Point, floor: Floor = BASE_FLOOR): Point[] {
  if (Math.abs(from.x - to.x) < 1 && Math.abs(from.y - to.y) < 1) return [];
  const wall = WALL_X + floor.shift;
  const roomSide = (point: Point) => point.x > wall;
  if (Math.abs(to.y - from.y) > 40) {
    if (roomSide(from) && roomSide(to)) {
      return [
        { x: from.x, y: to.y },
        { x: to.x, y: to.y },
      ];
    }
    const middle = roomSide(to) || roomSide(from) ? wall - 16 : from.x;
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
