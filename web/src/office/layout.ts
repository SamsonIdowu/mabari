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
/** The narrowest the work area gets: three columns of desks, so its furniture fits. */
const WORK_MIN_END = (DeskX + 2 * 5) * TILE + 68;
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
  /** The door and Mabari's reception desk, below the middle of the work area. */
  door: number;
  /** Where the work area ends on the right: its desks, or its smallest size for its furniture. */
  workEnd: number;
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
  minWidth = 0,
): Floor {
  const taken = new Set(use.taken);
  let free = 0;
  while (taken.has(free)) free++;
  const desks = [...new Set([...use.working, free])].sort((a, b) => a - b);
  // The grid is as wide as the desks agents hold and the free one, so it doesn't shrink and
  // grow as agents step out to the lounge and back.
  const columns = Math.max(...[...taken, free].map(columnOf)) + 1;
  const gridStart = DeskX * TILE;
  // The work area keeps room for its shelves and servers, however few desks it has.
  const gridEnd = Math.max((DeskX + (columns - 1) * 5) * TILE + 68, WORK_MIN_END);
  const rooms = ROOMS.filter((room) => inUse.includes(room));
  const loungeColumns = Math.ceil(residents / LOUNGE_ROWS);
  // The office is the work area on the left and the open lounge on the right, each half the view
  // at 100%, so they share the screen evenly whatever its size. Either grows past its half only
  // when it needs more room, and then the office scrolls sideways; the other stays as it is.
  const workNeeds = gridEnd + 56;
  // The rooms' space is kept whether or not one is open, so opening one moves nothing else.
  const loungeNeeds =
    48 + (residents > 0 ? loungeColumns * LOUNGE_PITCH.x + LOUNGE_NOOK + GAP : 0) + ROOMS_W + 24;
  // A half the view sets is rounded down, so the floor never scrolls by a sliver.
  const viewHalf = Math.floor(minWidth / 2 / TILE) * TILE;
  const half = Math.max(viewHalf, Math.ceil(workNeeds / TILE) * TILE);
  const width = half + Math.max(viewHalf, Math.ceil(loungeNeeds / TILE) * TILE);
  let lounge: Floor['lounge'] = null;
  if (residents > 0) {
    // Only as many armchairs as there are residents.
    const x = half + 48;
    lounge = {
      x,
      first: { x: x + 44, y: 148 },
      columns: loungeColumns,
      rows: Math.min(residents, LOUNGE_ROWS),
      seats: residents,
    };
  }
  // The rooms stand at the lounge half's right end, moved along whole tiles.
  const wall = rooms.length ? width - ROOMS_W : null;
  const shift = (wall ?? width - ROOMS_W) - WALL_X;
  const workEnd = half - 40;
  return {
    width,
    height: BASE_H,
    columns,
    shift,
    wall,
    rooms,
    door: Math.round((gridStart + workEnd) / 2),
    workEnd,
    desks,
    free,
    lounge,
    key: [width, columns, desks.join('.'), lounge?.seats ?? 0, ...rooms].join(':'),
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
  if (!floor.lounge) return null;
  // The lounge is open: resting agents roam the floor outside the work area's walls, from
  // its wall to the rooms or the office's end, and the lobby by the door.
  return {
    x0: workWalls(floor).right + 30,
    y0: LABEL_Y + 64,
    // It stops short of where the rooms open, open or not.
    x1: floor.width - ROOMS_W - 30,
    y1: floor.height - 70,
  };
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
export function seatingFor(
  agents: LiveAgent[],
  defs: AgentDef[],
  keep: Room[] = [],
  minWidth = 0,
): Seating {
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
  return { floor: floorFor(use, lounge.size, [...rooms], minWidth), lounge, resting };
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

/**
 * The route to a spot. The work area is enclosed, so going in or out means its doorway: inside,
 * agents walk up and down the aisles beside the desks, never through them; outside, they go
 * along the lobby and round the end of the work area's wall, round Mabari's desk on the way to
 * the door, and through the gap in the glass for the rooms.
 */
export function pathTo(from: Point, to: Point, floor: Floor = BASE_FLOOR): Point[] {
  if (Math.abs(from.x - to.x) < 1 && Math.abs(from.y - to.y) < 1) return [];
  const inside = inWorkArea(floor);
  const way = workDoorway(floor);
  let route: Point[];
  if (inside(from) && inside(to)) {
    route = insidePath(from, to);
  } else if (inside(from)) {
    route = [...insidePath(from, way.in), way.out, ...outsidePath(way.out, to, floor)];
  } else if (inside(to)) {
    route = [...outsidePath(from, way.out, floor), way.in, ...insidePath(way.in, to)];
  } else {
    route = outsidePath(from, to, floor);
  }
  // Leave out steps that go nowhere.
  return route.filter((point, index) => {
    const before = index ? route[index - 1]! : from;
    return Math.abs(point.x - before.x) + Math.abs(point.y - before.y) > 0.5;
  });
}

/** The aisle beside a desk column, between its desks and the next column's. */
function aisleOf(x: number): number {
  const first = DeskX * TILE;
  const column = Math.max(0, Math.floor((x - first) / (5 * TILE)));
  return first + column * 5 * TILE + 114;
}

/** A route inside the work area: up or down the aisle, never through a desk. */
function insidePath(from: Point, to: Point): Point[] {
  if (Math.abs(to.y - from.y) <= 40) {
    return [
      { x: from.x, y: from.y },
      { x: to.x, y: to.y },
    ];
  }
  const aisle = aisleOf(from.x);
  return [
    { x: aisle, y: from.y },
    { x: aisle, y: to.y },
    { x: to.x, y: to.y },
  ];
}

/**
 * A route outside the work area. From the lobby below it, agents go along the lobby to the end
 * of its wall before turning up, and the other way round; going to the door, they step round
 * Mabari's desk.
 */
function outsidePath(from: Point, to: Point, floor: Floor): Point[] {
  const walls = workWalls(floor);
  const lobby = (point: Point) => point.y > walls.front && point.x < walls.right + 16;
  const corner = walls.right + 16;
  const door = doorOf(floor);
  // Across the lobby, agents keep to the walkway between the wall and Mabari's desk, and step
  // round the desk to and from anywhere behind it, such as the door.
  const walkway = 626;
  const behindDesk = (point: Point) => point.y > 640 && Math.abs(point.x - door.x) < 56;
  const aside = (point: Point) => ({ x: door.x + (point.x < door.x ? -64 : 64), y: point.y });
  if (behindDesk(from)) {
    const step = aside(from);
    return [step, ...outsidePath(step, to, floor)];
  }
  if (behindDesk(to)) {
    const step = aside(to);
    return [...outsidePath(from, step, floor), to];
  }
  if (lobby(from) && !lobby(to)) {
    return [
      { x: from.x, y: walkway },
      { x: corner, y: walkway },
      ...openPath({ x: corner, y: walkway }, to, floor),
    ];
  }
  if (!lobby(from) && lobby(to)) {
    return [
      ...openPath(from, { x: corner, y: walkway }, floor),
      { x: to.x, y: walkway },
      { x: to.x, y: to.y },
    ];
  }
  if (lobby(from) && lobby(to)) {
    return [
      { x: from.x, y: walkway },
      { x: to.x, y: walkway },
      { x: to.x, y: to.y },
    ];
  }
  return openPath(from, to, floor);
}

/** The work area's walls: a partition on its right and along its front, under the back wall. */
export function workWalls(floor: Floor): { right: number; front: number } {
  return { right: floor.workEnd + 32, front: 600 };
}

/** The doorway in the work area's front wall, facing Mabari's desk: a step inside and outside. */
export function workDoorway(floor: Floor): { in: Point; out: Point } {
  const x = floor.door;
  return { in: { x, y: 580 }, out: { x, y: 626 } };
}

/** Whether a point is inside the work area's walls. */
export const inWorkArea =
  (floor: Floor) =>
  (point: Point): boolean => {
    const walls = workWalls(floor);
    return point.x < walls.right && point.y < walls.front;
  };

/** The route between two points on the same side of the work area's walls. */
function openPath(from: Point, to: Point, floor: Floor): Point[] {
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
