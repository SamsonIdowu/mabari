// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { AgentDef, LiveAgent } from '../gen/models.ts';
import {
  BASE_FLOOR,
  BENCH_WIDTH,
  benchSeat,
  deskSeat,
  deskTile,
  floorFor,
  gridSide,
  LOUNGE_PITCH,
  loungeSeat,
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
    [20, 28, 20],
    [21, 8, 20],
    [24, 23, 20],
    [25, 33, 4],
    [30, 33, 24],
    [35, 28, 24],
    [95, 28, 40],
  ])('puts desk %i at tile %i, %i, as the server does', (index, x, y) => {
    expect(deskTile(index)).toEqual({ x, y });
  });

  it('grows the grid a side at a time', () => {
    expect([0, 1, 16, 17, 25, 26, 96].map(gridSide)).toEqual([4, 4, 4, 5, 5, 6, 10]);
  });

  it('puts bench seats where the server does', () => {
    expect([0, 3, 4, 9].map(benchSeat)).toEqual([
      { x: 0, y: 0 },
      { x: 480, y: 0 },
      { x: 0, y: 112 },
      { x: 160, y: 224 },
    ]);
  });

  it('seats an agent in front of its desk', () => {
    expect(deskSeat(agent({ desk: 0 }), BASE_FLOOR)).toEqual({ x: 288, y: 182 });
  });

  it('seats a workflow sub-agent at the benches', () => {
    const floor = floorFor(0, 5, 0);
    const first = deskSeat(agent({ desk: 0, bench: true }), floor);
    const fifth = deskSeat(agent({ desk: 4, bench: true }), floor);
    expect(first.y).toBeGreaterThan(floor.lower!);
    expect(fifth).toEqual({ x: first.x, y: first.y + 112 });
  });
});

describe('floorFor', () => {
  it('is the prototype office when nothing makes it grow', () => {
    expect(BASE_FLOOR).toMatchObject({ width: 1216, height: 704, side: 4, shift: 0, lower: null });
    expect(floorFor(16, 0, 0)).toEqual(BASE_FLOOR);
  });

  it('widens and deepens for a seventeenth desk, moving the rooms along', () => {
    const floor = floorFor(17, 0, 0);
    expect(floor.side).toBe(5);
    expect(floor.shift).toBe(160);
    expect(floor.width).toBe(1216 + 160);
    // The last row of desks still has room below it for the reception desk.
    expect(floor.height).toBeGreaterThan(deskTile(24).y * 32 + 66 + 100);
  });

  it('opens a lower floor below the desks for benches and the lounge', () => {
    const floor = floorFor(30, 9, 12);
    const gridBottom = deskTile(35).y * 32 + 66;
    expect(floor.lower).toBeGreaterThan(gridBottom);
    expect(floor.bench!.rows).toBe(3);
    // The lounge sits beside the benches, not over them.
    expect(floor.lounge!.x).toBeGreaterThan(floor.bench!.x + BENCH_WIDTH);
    expect(floor.lounge!.columns * floor.lounge!.rows).toBeGreaterThanOrEqual(12);
    expect(floor.height).toBeGreaterThan(floor.bench!.y + 2 * 112 + 70);
  });

  it('gives the lounge the whole lower floor when nobody is at the benches', () => {
    expect(floorFor(0, 0, 3).lounge!.x).toBe(64);
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
        expect(seat.x).toBeLessThan(floor.width - 24);
        expect(seat.y).toBeLessThan(floor.height - 100);
        expect(seat.y).toBeGreaterThan(floor.lower!);
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
    expect(seating.floor.side).toBe(5);
    expect(seating.floor.bench!.rows).toBe(2);
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

  it('crosses the lower floor first when coming back up to a desk', () => {
    const floor = floorFor(16, 0, 20);
    const seat = loungeSeat(floor, 8);
    expect(seat.x).toBeGreaterThan(928);
    expect(pathTo(seat, { x: 288, y: 182 }, floor)[0]).toEqual({ x: 288, y: seat.y });
  });
});
