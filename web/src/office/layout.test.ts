// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { AgentDef, LiveAgent } from '../gen/models.ts';
import {
  BASE_FLOOR,
  BASE_H,
  benchSeat,
  benchWidth,
  deskSeat,
  deskTile,
  floorFor,
  gridColumns,
  LOUNGE_PITCH,
  LOUNGE_ROWS,
  loungeSeat,
  onFloor,
  pathTo,
  restingDefs,
  seatingFor,
  spotFor,
  type Point,
} from './layout.ts';

const agent = (overrides: Partial<LiveAgent> = {}) =>
  ({
    id: 'a',
    state: 'editing',
    desk: 0,
    bench: false,
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
    [0, 8, 4],
    [5, 13, 8],
    [15, 23, 16],
    [16, 28, 4],
    [19, 28, 16],
    [20, 33, 4],
    [23, 33, 16],
    [95, 123, 16],
  ])('puts desk %i at tile %i, %i, as the server does', (index, x, y) => {
    expect(deskTile(index)).toEqual({ x, y });
  });

  it('grows the grid a column of four at a time, never down', () => {
    expect([0, 1, 16, 17, 20, 21, 96].map(gridColumns)).toEqual([4, 4, 4, 5, 5, 6, 24]);
    for (let index = 0; index < 96; index++) expect(deskTile(index).y).toBeLessThanOrEqual(16);
  });

  it('puts bench seats where the server does', () => {
    expect([0, 3, 4, 9].map(benchSeat)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 384 },
      { x: 160, y: 0 },
      { x: 320, y: 128 },
    ]);
  });

  it('seats an agent in front of its desk', () => {
    expect(deskSeat(agent({ desk: 0 }), BASE_FLOOR)).toEqual({ x: 288, y: 182 });
  });

  it('seats a workflow sub-agent at the benches, in line with the desk rows', () => {
    const floor = floorFor(0, 5, 0);
    const first = deskSeat(agent({ desk: 0, bench: true }), floor);
    const fifth = deskSeat(agent({ desk: 4, bench: true }), floor);
    expect(first.y).toBe(deskSeat(agent({ desk: 0 }), floor).y);
    expect(first.x).toBeGreaterThan(deskSeat(agent({ desk: 3 }), floor).x);
    expect(fifth).toEqual({ x: first.x + 160, y: first.y });
  });
});

describe('onFloor', () => {
  it('leaves out workflow sub-agents that are off duty, and keeps the list when none are', () => {
    const all = [agent({ id: 'a' }), agent({ id: 'b', desk: -1, bench: true })];
    expect(onFloor(all).map((item) => item.id)).toEqual(['a']);
    expect(onFloor(all)).toBe(onFloor(all));
    const seated = [agent({ id: 'a' })];
    expect(onFloor(seated)).toBe(seated);
  });

  it("gives an off duty agent no part in the floor's size", () => {
    const seating = seatingFor([agent({ desk: -1, bench: true, state: 'idle' })], []);
    expect(seating.floor.bench).toBeNull();
  });
});

describe('floorFor', () => {
  it('is the prototype office when nothing makes it grow', () => {
    expect(BASE_FLOOR).toMatchObject({ width: 1216, height: 704, columns: 4, shift: 0 });
    expect(BASE_FLOOR.door).toBe(608);
    expect(floorFor(16, 0, 0)).toEqual(BASE_FLOOR);
  });

  it('widens for a seventeenth desk, moving the rooms along, and keeps its height', () => {
    const floor = floorFor(17, 0, 0);
    expect(floor.columns).toBe(5);
    expect(floor.shift).toBe(160);
    expect(floor.width).toBe(1216 + 160);
    expect(floor.height).toBe(BASE_H);
    // The door stays below the middle of the desks.
    expect(floor.door).toBe(608 + 80);
  });

  it('never grows taller, however many sit or rest', () => {
    for (const [desks, benches, residents] of [
      [96, 96, 200],
      [40, 9, 12],
      [0, 0, 7],
    ] as const) {
      expect(floorFor(desks, benches, residents).height).toBe(BASE_H);
    }
  });

  it('puts the benches, then the lounge, between the desks and the rooms', () => {
    const floor = floorFor(30, 9, 12);
    const gridEnd = deskTile(28).x * 32 + 68;
    expect(floor.bench!.columns).toBe(3);
    expect(floor.bench!.left).toBeGreaterThan(gridEnd);
    // The lounge sits beside the benches, not over them.
    expect(floor.lounge!.x).toBeGreaterThan(floor.bench!.x + benchWidth(3));
    expect(floor.lounge!.columns).toBe(3);
    expect(floor.lounge!.rows).toBe(LOUNGE_ROWS);
    // The glass wall comes after the lounge.
    expect(928 + floor.shift).toBeGreaterThan(floor.lounge!.x + 3 * LOUNGE_PITCH.x);
    expect(floor.shift % 32).toBe(0);
  });

  it('grows the lounge a column at a time', () => {
    expect(floorFor(0, 0, 3).lounge).toMatchObject({ columns: 1, rows: 3 });
    expect(floorFor(0, 0, LOUNGE_ROWS + 1).lounge).toMatchObject({ columns: 2, rows: LOUNGE_ROWS });
    expect(floorFor(0, 0, 40).width).toBeGreaterThan(floorFor(0, 0, 10).width);
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
    for (const benches of [0, 6]) {
      const floor = floorFor(16, benches, residents);
      const seats = Array.from({ length: residents }, (_, index) => loungeSeat(floor, index));
      expect(distinct(seats)).toBe(true);
      for (const seat of seats) {
        expect(seat.x).toBeLessThan(928 + floor.shift - 24);
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

  it('sizes the desk grid and benches from where agents sit', () => {
    const seating = seatingFor([agent({ desk: 20 }), agent({ id: 'b', desk: 6, bench: true })], []);
    expect(seating.floor.columns).toBe(6);
    expect(seating.floor.bench!.columns).toBe(2);
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
      expect(spotFor(agent({ state, desk: 3 }), 1, seating)).toEqual(
        deskSeat(agent({ desk: 3 }), seating.floor),
      );
    }
  });

  it('briefs subagents in the meeting room, which moves with the rooms', () => {
    expect(spotFor(agent({ state: 'spawning' }), 1, seating)).toEqual({ x: 1078, y: 362 });
    const wide = seatingFor([agent({ desk: 16 })], []);
    expect(spotFor(agent({ state: 'spawning' }), 1, wide)).toEqual({ x: 1078 + 160, y: 362 });
  });
});

describe('pathTo', () => {
  it('has nowhere to go when already there', () => {
    expect(pathTo({ x: 10, y: 10 }, { x: 10.5, y: 10.5 })).toEqual([]);
  });

  it('walks along a corridor for short moves', () => {
    expect(pathTo({ x: 100, y: 200 }, { x: 300, y: 220 })).toEqual([
      { x: 100, y: 200 },
      { x: 300, y: 200 },
      { x: 300, y: 220 },
    ]);
  });

  it('uses the gap in the wall to reach the rooms on the right', () => {
    expect(pathTo({ x: 300, y: 200 }, { x: 1046, y: 520 })[0]).toEqual({ x: 912, y: 200 });
  });

  it('stays on the right side when moving between right hand rooms', () => {
    expect(pathTo({ x: 1000, y: 136 }, { x: 1046, y: 520 })).toEqual([
      { x: 1000, y: 520 },
      { x: 1046, y: 520 },
    ]);
  });

  it('reaches the rooms through the gap in the glass wall, however far it moved', () => {
    const floor = floorFor(16, 0, 20);
    const wall = 928 + floor.shift;
    const pantry = { x: 1046 + floor.shift, y: 520 };
    expect(pathTo(loungeSeat(floor, 0), pantry, floor)[0]).toEqual({
      x: wall - 16,
      y: loungeSeat(floor, 0).y,
    });
  });
});
