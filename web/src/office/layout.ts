// SPDX-License-Identifier: Apache-2.0
import { BaseGrid, DeskX, type AgentDef, type AgentState, type LiveAgent } from '../gen/models.ts';

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
  return { x: DeskX + column * 5, y: 4 + row * 4 };
}

/** How many columns of desks the grid needs to hold this many. Mirrors GridColumns. */
export function gridColumns(desks: number): number {
  return Math.max(BaseGrid, Math.ceil(desks / BaseGrid));
}

/** How far apart lounge seats are. */
export const LOUNGE_PITCH = { x: 144, y: 108 };
/** The strip at the lounge's right end with the lamp, the bookshelf and a big plant. */
export const LOUNGE_NOOK = 72;
/** The lounge is drawn at least this many rows deep, so its furniture fits. */
const LOUNGE_MIN_ROWS = 2;
/** The lounge's rows of armchairs. It grows a column at a time, to the right. */
export const LOUNGE_ROWS = 5;
/** Where an area's floor label sits, and where its first row starts. */
export const LABEL_Y = 84;
/** The glass wall in front of the rooms, in the prototype's office. Rooms are drawn from there. */
const WALL_X = 928;
/** The rooms, as wide as the prototype's: the glass wall to the right wall. */
const ROOMS_W = BASE_W - WALL_X;
/** The space between areas on the floor. */
const GAP = 48;

/** The rooms along the right wall. Each is on the floor only while someone is in it. */
export type Room = 'server' | 'meeting' | 'pantry';
const ROOMS: Room[] = ['server', 'meeting', 'pantry'];

/**
 * The office floor's shape. The office keeps the prototype's height, so its agents never shrink,
 * and grows only to the right. Left to right: the desk grid, where everyone at work sits and
 * which gains a column of four desks at a time; the lounge, when anyone rests; then, while anyone
 * is in one, the glass wall and the rooms. No area is on the floor while it is empty, except the
 * desk grid.
 */
export interface Floor {
  width: number;
  height: number;
  /** Columns of desks in the grid. */
  columns: number;
  /** How far right the rooms are from where the prototype has them. Can be negative. */
  shift: number;
  /** The glass wall in front of the rooms, or null when no room is in use. */
  wall: number | null;
  /** The rooms in use, which are the only ones drawn. */
  rooms: Room[];
  /** The door and Mabari's reception desk, below the middle of the desk grid. */
  door: number;
  /**
   * The desks drawn: those someone works at now, and one free desk. An empty desk isn't on the
   * floor, except the one free desk, which the next agent takes; then another appears.
   */
  desks: number[];
  /** The one free desk: the lowest no agent holds, which is the one the server gives next. */
  free: number;
  /** The lounge: its left edge, where the first seat is, its columns and rows, and its seats. */
  lounge: { x: number; first: Point; columns: number; rows: number; seats: number } | null;
  /** Changes whenever the background must be drawn again. */
  key: string;
}

/**
 * Which desks agents hold. `taken` are every desk held by an agent on the floor, including one
 * resting in the lounge, which keeps its desk; `working` are the desks someone sits at now.
 */
export interface DeskUse {
  taken: number[];
  working: number[];
}

/** The first `count` desks, all taken and worked at. */
export const desksUpTo = (count: number): DeskUse => {
  const desks = Array.from({ length: count }, (_, index) => index);
  return { taken: desks, working: desks };
};

/** The grid column a desk is in, from 0. */
const columnOf = (desk: number) => (deskTile(desk).x - DeskX) / 5;

/** The floor for the desks in use, this many lounge residents, and the rooms in use. */
export function floorFor(
  use: DeskUse = { taken: [], working: [] },
  residents = 0,
  inUse: Room[] = [],
): Floor {
  const taken = new Set(use.taken);
  let free = 0;
  while (taken.has(free)) free++;
  const desks = [...new Set([...use.working, free])].sort((a, b) => a - b);
  // The grid is as wide as the desks agents hold and the free one, so it doesn't shrink and
  // grow as agents step out to the lounge and back.
  const columns = Math.max(...[...taken, free].map(columnOf)) + 1;
  const gridStart = DeskX * TILE;
  const gridEnd = (DeskX + (columns - 1) * 5) * TILE + 68;
  // From the end of the grid's last desk, each area takes its own stretch of floor.
  let cursor = gridEnd + 56;
  let lounge: Floor['lounge'] = null;
  if (residents > 0) {
    // Only as many armchairs as there are residents.
    const loungeColumns = Math.ceil(residents / LOUNGE_ROWS);
    const rows = Math.min(residents, LOUNGE_ROWS);
    lounge = {
      x: cursor,
      first: { x: cursor + 44, y: 148 },
      columns: loungeColumns,
      rows,
      seats: residents,
    };
    cursor += loungeColumns * LOUNGE_PITCH.x + LOUNGE_NOOK + GAP;
  }
  const rooms = ROOMS.filter((room) => inUse.includes(room));
  // The rooms move along whole tiles, as the floor's tiles are drawn on that grid.
  const shift = Math.ceil((cursor + 24 - WALL_X) / TILE) * TILE;
  const wall = rooms.length ? WALL_X + shift : null;
  const width = wall === null ? Math.ceil((cursor + 8) / TILE) * TILE : wall + ROOMS_W;
  return {
    width,
    height: BASE_H,
    columns,
    shift,
    wall,
    rooms,
    door: Math.round((gridStart + gridEnd) / 2),
    desks,
    free,
    lounge,
    key: [columns, desks.join('.'), lounge?.seats ?? 0, ...rooms].join(':'),
  };
}

/** The floor with nothing on it: the prototype's office. */
export const BASE_FLOOR = floorFor();

/**
 * The lounge's open floor, where resting agents wander with their coffee: the box their feet
 * stay in. Null when nobody rests.
 */
export function loungeArea(
  floor: Floor,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const box = loungeBox(floor);
  if (!box) return null;
  return { x0: box.x0 + 22, y0: box.y0 + 52, x1: box.x1 - LOUNGE_NOOK - 16, y1: box.y1 - 14 };
}

/**
 * The lounge's rug, in world pixels: as wide as its seats plus the nook, and at least two rows
 * deep. Null when nobody rests.
 */
export function loungeBox(floor: Floor): { x0: number; y0: number; x1: number; y1: number } | null {
  const lounge = floor.lounge;
  if (!lounge) return null;
  const rows = Math.max(lounge.rows, LOUNGE_MIN_ROWS);
  return {
    x0: lounge.x,
    y0: LABEL_Y + 12,
    x1: lounge.x + lounge.columns * LOUNGE_PITCH.x + LOUNGE_NOOK,
    y1: lounge.first.y + (rows - 1) * LOUNGE_PITCH.y + 34,
  };
}

/** Where lounge seat `index` is: a resting agent's own spot, where it first stands. */
export function loungeSeat(floor: Floor, index: number): Point {
  const lounge = floor.lounge;
  if (!lounge) return receptionOf(floor);
  return {
    x: lounge.first.x + Math.floor(index / LOUNGE_ROWS) * LOUNGE_PITCH.x,
    y: lounge.first.y + (index % LOUNGE_ROWS) * LOUNGE_PITCH.y,
  };
}

/** The corner of an agent's desk in the grid, in pixels. */
export function deskCorner(agent: Pick<LiveAgent, 'desk'>): Point {
  const tile = deskTile(agent.desk);
  return { x: tile.x * TILE, y: tile.y * TILE };
}

/** Where an agent sits at its desk, in front of the monitor. */
export function deskSeat(agent: Pick<LiveAgent, 'desk'>): Point {
  const corner = deskCorner(agent);
  return { x: corner.x + TILE, y: corner.y + 54 };
}

export type Location = 'desk' | Room | 'lounge';

/** Where people stand in each room, as the prototype has them before the rooms move along. */
const ROOM_SPOTS: Record<Room, Point[]> = {
  server: [
    { x: 986, y: 136 },
    { x: 1042, y: 136 },
    { x: 1092, y: 136 },
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

export function roomSpots(room: Room, floor: Floor): Point[] {
  return ROOM_SPOTS[room].map((point) => ({ x: point.x + floor.shift, y: point.y }));
}

const isRoom = (location: Location): location is Room => location in ROOM_SPOTS;

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
 * Seats everyone. Resting definitions take the first lounge spots, as they change least, then
 * idle agents in the order they arrived, so nobody shares a spot. `keep` are rooms to keep open
 * though nobody's state is in them, while someone is still walking out.
 */
export function seatingFor(agents: LiveAgent[], defs: AgentDef[], keep: Room[] = []): Seating {
  const use: DeskUse = { taken: [], working: [] };
  for (const agent of agents) {
    if (agent.desk < 0) continue;
    use.taken.push(agent.desk);
    if (!agent.leaving && (STATE_LOCATIONS[agent.state] ?? 'desk') === 'desk') {
      use.working.push(agent.desk);
    }
  }
  const resting = restingDefs(defs, agents);
  // Only permanent agents rest in the lounge. Workflow sub-agents are contractors: off duty,
  // they leave the office altogether.
  const idle = agents
    .filter(
      (agent) =>
        STATE_LOCATIONS[agent.state] === 'lounge' &&
        !agent.leaving &&
        agent.desk >= 0 &&
        !agent.workflow,
    )
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const lounge = new Map<string, number>();
  resting.forEach((def, index) => lounge.set(restKey(def), index));
  idle.forEach((agent, index) => lounge.set(agent.id, resting.length + index));
  const rooms = new Set<Room>(keep);
  for (const agent of agents) {
    const location = STATE_LOCATIONS[agent.state];
    if (agent.desk >= 0 && !agent.leaving && location && isRoom(location)) rooms.add(location);
  }
  return { floor: floorFor(use, lounge.size, [...rooms]), lounge, resting };
}

type Seated = Pick<LiveAgent, 'id' | 'state' | 'desk'>;

/** Where an agent stands in its state. `number` keeps agents in one room from sharing a spot. */
export function spotFor(agent: Seated, number: number, seating: Seating): Point {
  const location = STATE_LOCATIONS[agent.state] ?? 'desk';
  if (location === 'desk') return deskSeat(agent);
  if (location === 'lounge') return loungeSeat(seating.floor, seating.lounge.get(agent.id) ?? 0);
  if (!seating.floor.rooms.includes(location)) return deskSeat(agent);
  const spots = roomSpots(location, seating.floor);
  return spots[number % spots.length]!;
}

/** The route to a spot: along a corridor, and through the gap in the wall for the rooms. */
export function pathTo(from: Point, to: Point, floor: Floor = BASE_FLOOR): Point[] {
  if (Math.abs(from.x - to.x) < 1 && Math.abs(from.y - to.y) < 1) return [];
  const wall = floor.wall ?? Infinity;
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
