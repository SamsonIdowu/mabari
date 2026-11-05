// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { AgentDef, LiveAgent } from '../gen/models.ts';
import {
  BASE_FLOOR,
  BASE_H,
  deskSeat,
  deskTile,
  desksUpTo,
  doorOf,
  floorFor,
  inWorkArea,
  loungeArea,
  gridColumns,
  LOUNGE_PITCH,
  LOUNGE_ROWS,
  loungeSeat,
  onFloor,
  pathTo,
  receptionOf,
  restingDefs,
  seatingFor,
  spotFor,
  type Point,
  workDoorway,
  workWalls,
} from './layout.ts';

const agent = (overrides: Partial<LiveAgent> = {}) =>
  ({
    id: 'a',
    state: 'editing',
    desk: 0,
    leaving: false,
    defId: '',
    createdAt: 0,
    ...overrides,
  }) as LiveAgent;

const def = (overrides: Partial<AgentDef> = {}) =>
  ({
    id: 'account:reviewer',
    kind: 'claude',
    name: 'reviewer',
    enabled: true,
    system: false,
    color: '',
    ...overrides,
  }) as AgentDef;

describe('desks', () => {
  // The same positions are pinned in internal/models/desks_test.go, so the two can't drift.
  it.each([
    [0, 2, 4],
    [5, 7, 8],
    [15, 17, 16],
    [16, 22, 4],
    [19, 22, 16],
    [20, 27, 4],
    [23, 27, 16],
    [95, 117, 16],
  ])('puts desk %i at tile %i, %i, as the server does', (index, x, y) => {
    expect(deskTile(index)).toEqual({ x, y });
  });

  it('grows the grid a column of four at a time, never down', () => {
    expect([0, 1, 16, 17, 20, 21, 96].map(gridColumns)).toEqual([4, 4, 4, 5, 5, 6, 24]);
    for (let index = 0; index < 96; index++) expect(deskTile(index).y).toBeLessThanOrEqual(16);
  });

  it('seats an agent in front of its desk', () => {
    expect(deskSeat(agent({ desk: 0 }))).toEqual({ x: 96, y: 182 });
  });
});

describe('onFloor', () => {
  it('leaves out workflow sub-agents that are off duty, and keeps the list when none are', () => {
    const all = [agent({ id: 'a' }), agent({ id: 'b', desk: -1, workflow: true })];
    expect(onFloor(all).map((item) => item.id)).toEqual(['a']);
    expect(onFloor(all)).toBe(onFloor(all));
    const seated = [agent({ id: 'a' })];
    expect(onFloor(seated)).toBe(seated);
  });

  it("gives an off duty agent no part in the floor's size", () => {
    const seating = seatingFor([agent({ desk: -1, workflow: true, state: 'idle' })], []);
    expect(seating.floor).toEqual(BASE_FLOOR);
  });
});

describe('floorFor', () => {
  it('shows one free desk and nothing else when nobody is in: no empty rooms', () => {
    expect(BASE_FLOOR).toMatchObject({
      height: 704,
      columns: 1,
      desks: [0],
      free: 0,
      wall: null,
      rooms: [],
      lounge: null,
    });
    expect(floorFor(desksUpTo(0), 0)).toEqual(BASE_FLOOR);
  });

  it('draws the desks in use and exactly one free desk, the next one taken', () => {
    const three = floorFor(desksUpTo(3));
    expect(three.desks).toEqual([0, 1, 2, 3]);
    expect(three.free).toBe(3);
    // Once the free desk is taken, another appears.
    expect(floorFor(desksUpTo(4)).desks).toEqual([0, 1, 2, 3, 4]);
    // A gap left by an agent that went is the free desk, and no other empty desk shows.
    const gap = floorFor({ taken: [0, 2, 3], working: [0, 2, 3] });
    expect(gap.desks).toEqual([0, 1, 2, 3]);
    expect(gap.free).toBe(1);
  });

  it("doesn't draw the desk of an agent resting in the lounge, but keeps it for them", () => {
    const floor = floorFor({ taken: [0, 1, 2], working: [0, 2] }, 1);
    expect(floor.desks).toEqual([0, 2, 3]);
    expect(floor.free).toBe(3);
  });

  it('is as wide as the desks held and the free one, and keeps its height', () => {
    expect(floorFor(desksUpTo(1)).columns).toBe(2);
    expect(floorFor(desksUpTo(16)).columns).toBe(5);
    const wide = floorFor(desksUpTo(17));
    expect(wide.columns).toBe(5);
    // Each half grows with it, so another column of desks widens the office by two.
    expect(floorFor(desksUpTo(20)).width).toBe(wide.width + 2 * 160);
    expect(wide.height).toBe(BASE_H);
    // The door stays below the middle of the work area.
    expect(wide.door).toBe(Math.round((64 + wide.workEnd) / 2));
  });

  it('is two equal halves, the work area and the open lounge, at least as wide as the view', () => {
    for (const floor of [
      floorFor(desksUpTo(3), 2),
      floorFor(desksUpTo(40), 9, ['meeting']),
      floorFor(desksUpTo(2), 30),
      floorFor(desksUpTo(2), 1, [], 1600),
    ]) {
      expect(workWalls(floor).right + 8).toBe(floor.width / 2);
      expect(floor.lounge!.x).toBeGreaterThan(floor.width / 2);
      expect(floor.width % 64).toBe(0);
    }
    expect(floorFor(desksUpTo(2), 1, [], 1600).width).toBe(1600);
    // A view that isn't a whole number of tiles doesn't leave the floor a sliver too wide.
    expect(floorFor(desksUpTo(2), 1, [], 1650).width).toBeLessThanOrEqual(1650);
  });

  it('opens a room only while someone is in it, at the right end of the office', () => {
    const empty = floorFor(desksUpTo(16), 3);
    const meeting = floorFor(desksUpTo(16), 3, ['meeting']);
    expect(meeting.rooms).toEqual(['meeting']);
    expect(meeting.wall).toBeGreaterThan(meeting.lounge!.x + LOUNGE_PITCH.x);
    expect(meeting.width).toBe(meeting.wall! + 288);
    expect(meeting.wall!).toBeGreaterThan(meeting.width / 2);
    // Opening it moves nothing else.
    expect(meeting.lounge).toEqual(empty.lounge);
    expect(meeting.key).not.toBe(empty.key);
  });

  it('never grows taller, however many sit or rest', () => {
    for (const [desks, residents] of [
      [96, 200],
      [40, 12],
      [0, 7],
    ] as const) {
      expect(floorFor(desksUpTo(desks), residents, ['meeting']).height).toBe(BASE_H);
    }
  });

  it('puts the lounge between the desks and the rooms', () => {
    const floor = floorFor(desksUpTo(30), 12, ['meeting']);
    const gridEnd = deskTile(30).x * 32 + 68;
    expect(floor.lounge!.x).toBeGreaterThan(gridEnd);
    expect(floor.lounge!.columns).toBe(3);
    expect(floor.lounge!.rows).toBe(LOUNGE_ROWS);
    // The glass wall comes after the lounge.
    expect(floor.wall!).toBeGreaterThan(floor.lounge!.x + 3 * LOUNGE_PITCH.x);
    expect(floor.shift % 32).toBe(0);
  });

  it('sizes the lounge to the number resting in it', () => {
    expect(floorFor(desksUpTo(0), 1).lounge).toMatchObject({ columns: 1, rows: 1, seats: 1 });
    expect(floorFor(desksUpTo(0), 3).lounge).toMatchObject({ columns: 1, rows: 3, seats: 3 });
    expect(floorFor(desksUpTo(0), LOUNGE_ROWS + 1).lounge).toMatchObject({
      columns: 2,
      rows: LOUNGE_ROWS,
    });
    expect(floorFor(desksUpTo(0), 40).width).toBeGreaterThan(floorFor(desksUpTo(0), 10).width);
    // Resting agents roam the open floor outside the work area's walls, the lounge included.
    const floor = floorFor(desksUpTo(4), 7);
    const area = loungeArea(floor)!;
    expect(area.x0).toBeGreaterThan(workWalls(floor).right);
    expect(area.x0).toBeLessThanOrEqual(floor.lounge!.x + 22);
    expect(area.x1).toBeGreaterThan(floor.lounge!.x + LOUNGE_PITCH.x);
    expect(area.y1).toBeGreaterThan(area.y0);
    expect(loungeArea(BASE_FLOOR)).toBeNull();
  });
});

describe('the lounge', () => {
  const distinct = (points: Point[]) => {
    for (let a = 0; a < points.length; a++) {
      for (let b = a + 1; b < points.length; b++) {
        const apart =
          Math.abs(points[a]!.x - points[b]!.x) >= LOUNGE_PITCH.x ||
          Math.abs(points[a]!.y - points[b]!.y) >= LOUNGE_PITCH.y;
        if (!apart) return false;
      }
    }
    return true;
  };

  it.each([1, 5, 11, 40, 97])('never seats two of %i residents together', (residents) => {
    for (const rooms of [[], ['meeting']] as const) {
      const floor = floorFor(desksUpTo(16), residents, [...rooms]);
      const seats = Array.from({ length: residents }, (_, index) => loungeSeat(floor, index));
      expect(distinct(seats)).toBe(true);
      for (const seat of seats) {
        expect(seat.x).toBeLessThan((floor.wall ?? floor.width) - 24);
        expect(seat.y).toBeLessThan(floor.height - 80);
        expect(seat.y).toBeGreaterThan(100);
      }
    }
  });

  it('lists every agent file turned on with nothing running from it', () => {
    const defs = [
      def({ id: 'account:zed', name: 'zed' }),
      def({ id: 'account:mabari', name: 'Mabari', system: true }),
      def({ id: 'account:off', name: 'off', enabled: false }),
      def({ id: 'account:busy', name: 'busy' }),
      def({ id: 'codex:account:alpha', name: 'alpha', kind: 'codex' }),
      def({ id: 'project:p1:gone', name: 'gone' }),
    ];
    const agents = [
      agent({ id: 'x', defId: 'account:busy' }),
      agent({ id: 'y', defId: 'project:p1:gone', leaving: true }),
    ];
    expect(restingDefs(defs, agents).map((item) => item.id)).toEqual([
      'codex:account:alpha',
      'project:p1:gone',
      'account:zed',
    ]);
  });

  it('seats agent files first, then idle agents in the order they came', () => {
    const agents = [
      agent({ id: 'late', state: 'idle', createdAt: 20, desk: 1 }),
      agent({ id: 'early', state: 'idle', createdAt: 10, desk: 2 }),
      agent({ id: 'busy', state: 'editing', desk: 3 }),
    ];
    const seating = seatingFor(agents, [def()]);
    expect([...seating.lounge.entries()]).toEqual([
      ['def:account:reviewer', 0],
      ['early', 1],
      ['late', 2],
    ]);
    expect(seating.floor.lounge).not.toBeNull();
    expect(spotFor(agents[0]!, 1, seating)).toEqual(loungeSeat(seating.floor, 2));
    // Five idle agents no longer share four pantry spots.
    const idle = Array.from({ length: 5 }, (_, index) =>
      agent({ id: `i${index}`, state: 'idle', createdAt: index, desk: index }),
    );
    const crowd = seatingFor(idle, []);
    const spots = idle.map((item, index) => spotFor(item, index + 1, crowd));
    expect(new Set(spots.map((spot) => `${spot.x},${spot.y}`)).size).toBe(5);
  });

  it('sizes the desk grid from where agents sit', () => {
    const seating = seatingFor(
      [agent({ desk: 20 }), agent({ id: 'b', desk: 6, workflow: true })],
      [],
    );
    expect(seating.floor.columns).toBe(6);
  });
});

describe('spotFor', () => {
  const seating = seatingFor([], []);
  it('keeps work at the desk', () => {
    for (const state of [
      'thinking',
      'reading',
      'editing',
      'running',
      'browsing',
      'approval',
      'done',
      'error',
      'paused',
    ] as const) {
      expect(spotFor(agent({ state, desk: 3 }), 1, seating)).toEqual(deskSeat(agent({ desk: 3 })));
    }
  });

  it('briefs subagents in the meeting room, which opens for it at the right end', () => {
    const lead = agent({ state: 'spawning', desk: 3 });
    const busy = seatingFor([lead], []);
    expect(busy.floor.rooms).toEqual(['meeting']);
    expect(spotFor(lead, 1, busy)).toEqual({ x: 1078 + busy.floor.shift, y: 362 });
    expect(spotFor(lead, 1, busy).x).toBeGreaterThan(busy.floor.wall!);
    // It stays at the right end of the lounge half as the office grows.
    const wide = seatingFor([lead, agent({ id: 'b', desk: 16 })], []);
    expect(spotFor(lead, 1, wide).x).toBeGreaterThan(wide.floor.wall!);
    expect(spotFor(lead, 1, wide).x).toBeLessThan(wide.floor.width);
  });

  it('closes the meeting room once nobody is in it', () => {
    expect(seatingFor([agent({ state: 'editing' })], []).floor.rooms).toEqual([]);
    expect(seatingFor([agent({ state: 'spawning', leaving: true })], []).floor.rooms).toEqual([]);
  });
});

describe('pathTo', () => {
  it('has nowhere to go when already there', () => {
    expect(pathTo({ x: 10, y: 10 }, { x: 10.5, y: 10.5 })).toEqual([]);
  });

  it('walks straight across for short moves', () => {
    expect(pathTo({ x: 100, y: 200 }, { x: 300, y: 220 })).toEqual([{ x: 300, y: 220 }]);
  });

  /** Every step of a route, as a pair of points. */
  const steps = (from: Point, route: Point[]) =>
    route.map((point, index) => [index ? route[index - 1]! : from, point] as const);

  /** Whether a straight step crosses a box, given as its corners. */
  const crosses = (
    [a, b]: readonly [Point, Point],
    box: { x0: number; y0: number; x1: number; y1: number },
  ) => {
    for (let k = 0; k <= 40; k++) {
      const x = a.x + ((b.x - a.x) * k) / 40;
      const y = a.y + ((b.y - a.y) * k) / 40;
      if (x > box.x0 && x < box.x1 && y > box.y0 && y < box.y1) return true;
    }
    return false;
  };

  it.each([
    ['a big office', floorFor(desksUpTo(16), 6, ['meeting'], 1600)],
    ['a small one', floorFor(desksUpTo(3), 2, ['meeting'])],
    ['a wide one', floorFor(desksUpTo(40), 12, ['meeting'], 1300)],
  ])("never walks through the work area's walls, desks or Mabari's desk in %s", (_, floor) => {
    const walls = workWalls(floor);
    const way = workDoorway(floor);
    const reception = receptionOf(floor);
    const boxes = [
      // The right wall, and the front wall either side of the doorway.
      { x0: walls.right - 4, y0: 44, x1: walls.right + 4, y1: walls.front + 4 },
      { x0: 0, y0: walls.front - 4, x1: way.in.x - 30, y1: walls.front + 4 },
      { x0: way.in.x + 30, y0: walls.front - 4, x1: walls.right + 4, y1: walls.front + 4 },
      // Mabari's desk by the door.
      { x0: reception.x - 46, y0: reception.y - 6, x1: reception.x + 46, y1: reception.y + 22 },
      // Every desk top on the floor.
      ...floor.desks.map((desk) => {
        const corner = deskTile(desk);
        return {
          x0: corner.x * 32 + 4,
          y0: corner.y * 32,
          x1: corner.x * 32 + 64,
          y1: corner.y * 32 + 34,
        };
      }),
    ];
    const places = [
      ...floor.desks.filter((desk) => desk % 5 === 0).map((desk) => deskSeat({ desk })),
      loungeSeat(floor, 0),
      loungeSeat(floor, 5),
      doorOf(floor),
      { x: 1078 + floor.shift, y: 362 },
      { x: 60, y: 660 },
    ];
    for (const from of places) {
      for (const to of places) {
        for (const step of steps(from, pathTo(from, to, floor))) {
          for (const box of boxes) {
            expect(crosses(step, box), `${JSON.stringify(from)} to ${JSON.stringify(to)}`).toBe(
              false,
            );
          }
        }
      }
    }
  });

  it('leaves and enters the work area through its doorway', () => {
    const floor = floorFor(desksUpTo(16), 3, ['meeting']);
    const way = workDoorway(floor);
    const desk = deskSeat({ desk: 5 });
    const lounge = loungeSeat(floor, 0);
    expect(inWorkArea(floor)(desk)).toBe(true);
    expect(inWorkArea(floor)(lounge)).toBe(false);
    const out = pathTo(desk, lounge, floor);
    expect(out).toContainEqual(way.in);
    expect(out).toContainEqual(way.out);
    expect(out.at(-1)).toEqual(lounge);
    const back = pathTo(lounge, desk, floor);
    expect(back).toContainEqual(way.out);
    expect(back).toContainEqual(way.in);
    expect(back.at(-1)).toEqual(desk);
  });

  it('uses the gap in the glass wall to reach a room', () => {
    const floor = floorFor(desksUpTo(16), 0, ['meeting']);
    const wall = floor.wall!;
    const from = { x: workWalls(floor).right + 40, y: 200 };
    expect(pathTo(from, { x: wall + 120, y: 362 }, floor)[0]).toEqual({ x: wall - 16, y: 200 });
    // Between rooms it stays on their side of the wall.
    expect(pathTo({ x: wall + 70, y: 136 }, { x: wall + 120, y: 520 }, floor)).toEqual([
      { x: wall + 70, y: 520 },
      { x: wall + 120, y: 520 },
    ]);
  });
});
