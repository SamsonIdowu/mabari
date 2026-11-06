// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { Project } from '../gen/models.ts';
import { backRow } from './background.ts';
import {
  CONFETTI_MS,
  confettiColours,
  confettiOver,
  drawConfetti,
  meetingFrame,
  meetingSpots,
  MEETING_SEATS,
  roomOf,
  startConfetti,
  stepConfetti,
  stillConfetti,
} from './celebration.ts';
import { desksUpTo, floorFor } from './layout.ts';
import {
  capacityOf,
  layout,
  PITCH,
  roomFor,
  shade,
  TROPHY,
  TROPHY_Y,
  trophiesOf,
  trophyShape,
} from './trophies.ts';

const done = (id: string, at: number): Project =>
  ({ id, name: `Project ${id}`, color: '#48DBFB', done: { at } }) as unknown as Project;
const open = (id: string): Project =>
  ({ id, name: id, color: '#48DBFB', done: null }) as unknown as Project;
const shipped = (count: number): Project[] =>
  Array.from({ length: count }, (_, index) => done(`p${index}`, index));

/** The back row as it was laid out before it was shared, so the refactor can't have moved it. */
function oldBackRow(end: number): { x: number; w: number }[] {
  const widths = [56, 64, 52];
  const places: { x: number; w: number }[] = [];
  let x = 74;
  for (let index = 0; x + widths[index % 3]! <= end - 20; index++) {
    if (index >= 3 && widths[index % 3] === 52) continue;
    places.push({ x, w: widths[index % 3]! });
    x += widths[index % 3]! + 8;
  }
  return places;
}

describe('the back row', () => {
  it('lays out exactly as it did before the trophy display shared it', () => {
    for (const end of [300, 480, 600, 800, 1000, 1400, 2000]) {
      const kinds = { 56: 'shelf', 64: 'cabinets', 52: 'printer' } as const;
      expect(backRow(end)).toEqual(
        oldBackRow(end).map((place) => ({ x: place.x, kind: kinds[place.w as 56 | 64 | 52] })),
      );
    }
  });
});

describe('the trophy display', () => {
  const floor = floorFor();

  it('has a trophy only for each completed project, oldest first', () => {
    const shelf = trophiesOf([done('b', 20), open('x'), done('a', 10), done('c', 30)]);
    expect(shelf.map((project) => project.id)).toEqual(['a', 'b', 'c']);
  });

  it('is as tall as an agent: a trophy is 28 by 32 pixels, twice what it was', () => {
    expect(TROPHY).toEqual({ width: 28, height: 32 });
  });

  it('puts them in a row from the left, one slot apart, standing on the shelf', () => {
    const { spots, run } = layout(floor, shipped(5));
    expect(spots).toHaveLength(5);
    expect(spots.every((spot) => spot.y === TROPHY_Y)).toBe(true);
    for (let index = 1; index < spots.length; index++) {
      expect(spots[index]!.x - spots[index - 1]!.x).toBe(PITCH);
    }
    // The oldest is first, at the display's left end.
    expect(spots[0]!.id).toBe('p0');
    expect(spots[0]!.x).toBeGreaterThanOrEqual(run!.x0);
    // They never overlap and all stand inside the glass.
    for (const spot of spots) {
      expect(spot.x + TROPHY.width).toBeLessThanOrEqual(run!.x1);
    }
    expect(PITCH).toBeGreaterThan(TROPHY.width);
  });

  it('has no display at all until a project is completed', () => {
    expect(layout(floor, [open('a')])).toEqual({ spots: [], hidden: 0, run: null, more: null });
  });

  it('grows with the trophies, a piece of furniture at a time, never smaller than it needs', () => {
    const runs = [1, 2, 4, 6, 9].map((count) => layout(floor, shipped(count)).run!);
    for (const [index, count] of [1, 2, 4, 6, 9].entries()) {
      expect(runs[index]!.capacity).toBeGreaterThanOrEqual(count);
    }
    for (let index = 1; index < runs.length; index++) {
      expect(runs[index]!.x1).toBeGreaterThanOrEqual(runs[index - 1]!.x1);
    }
    // One trophy takes one piece: it doesn't swallow the row.
    expect(runs[0]!.pieces).toBe(1);
    expect(runs[4]!.pieces).toBeGreaterThan(runs[0]!.pieces);
    // It ends where a piece of furniture does, so it never cuts one in half.
    const ends = backRow(floor.workEnd + 24).map((place) => place.x);
    expect(ends).toContain(runs[0]!.x0);
  });

  it('shows the newest, reserves the last place for "+N", and says how many it has no room for', () => {
    const room = roomFor(floor);
    expect(room).toBeGreaterThanOrEqual(10);
    const { spots, hidden, more, run } = layout(floor, shipped(room + 6));
    // The last place is the tile, so one fewer trophy than places.
    expect(spots).toHaveLength(room - 1);
    expect(hidden).toBe(7);
    expect(more).toEqual({ x: spots.at(-1)!.x + PITCH, y: TROPHY_Y, hidden: 7 });
    expect(spots.at(-1)!.id).toBe(`p${room + 5}`);
    expect(spots.some((spot) => spot.id === 'p0')).toBe(false);
    // The tile is inside the glass, beside the last trophy.
    expect(more!.x + TROPHY.width).toBeLessThanOrEqual(run!.x1);
  });

  it('copes with a great many: forty shipped projects, one tile, nothing off the display', () => {
    const { spots, hidden, more, run } = layout(floor, shipped(40));
    expect(spots.length + hidden).toBe(40);
    expect(more!.hidden).toBe(hidden);
    expect(hidden).toBeGreaterThan(20);
    for (const spot of spots) {
      expect(spot.x).toBeGreaterThanOrEqual(run!.x0);
      expect(spot.x + TROPHY.width).toBeLessThanOrEqual(run!.x1);
    }
    expect(new Set(spots.map((spot) => spot.x)).size).toBe(spots.length);
  });

  it('shows no tile while everything fits, even exactly full', () => {
    const room = roomFor(floor);
    expect(layout(floor, shipped(room)).more).toBeNull();
    expect(layout(floor, shipped(room)).spots).toHaveLength(room);
    expect(layout(floor, shipped(room + 1)).more).not.toBeNull();
  });

  it('holds more on a bigger office, which has more of the back row', () => {
    const big = floorFor(desksUpTo(24));
    expect(roomFor(big)).toBeGreaterThan(roomFor(floor));
    expect(layout(big, shipped(roomFor(floor) + 5)).more).toBeNull();
  });

  it('works out how many a length holds', () => {
    expect(capacityOf(0)).toBe(0);
    expect(capacityOf(PITCH * 3 + 4)).toBe(3);
    expect(capacityOf(PITCH * 3 + 3)).toBe(2);
  });

  it('gives a project the same trophy every time, and not all the same', () => {
    expect(trophyShape('project-a')).toBe(trophyShape('project-a'));
    const shapes = new Set(Array.from({ length: 30 }, (_, index) => trophyShape(`p${index}`)));
    expect(shapes.size).toBeGreaterThan(3);
  });

  it('shades a colour darker and lighter, and copes with one it cannot read', () => {
    expect(shade('#808080', -0.5)).toBe('#404040');
    expect(shade('#808080', 0.5)).toBe('#c0c0c0');
    expect(shade('red', -0.5)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('the meeting room for a party', () => {
  const floor = floorFor({ taken: [0], working: [0] }, 0, ['meeting']);

  it('seats as many as the room has places for, apart, in a row inside the room', () => {
    const spots = meetingSpots(floor, 9);
    expect(spots).toHaveLength(MEETING_SEATS);
    for (let index = 1; index < spots.length; index++) {
      expect(spots[index]!.x - spots[index - 1]!.x).toBeGreaterThanOrEqual(56);
    }
    expect(Math.min(...spots.map((spot) => spot.x))).toBeGreaterThan(floor.wall!);
    expect(meetingSpots(floor, 2)).toHaveLength(2);
    expect(meetingSpots(floor, 0)).toEqual([]);
  });

  it('is framed whole: the team, the table and the room round them are all inside the frame', () => {
    const frame = meetingFrame(floor);
    const room = roomOf(floor);
    for (const spot of meetingSpots(floor, MEETING_SEATS)) {
      expect(spot.x).toBeGreaterThan(frame.x0);
      expect(spot.x).toBeLessThan(frame.x1);
      expect(spot.y).toBeLessThan(frame.y1);
    }
    expect(frame.x0).toBeLessThanOrEqual(room.x0);
    expect(frame.x1).toBeGreaterThanOrEqual(room.x1);
    expect(frame.y0).toBeLessThanOrEqual(room.top);
    expect(frame.y1).toBeGreaterThan(room.floor);
  });
});

/** A seeded generator, so a run can be repeated. */
function seeded(seed = 7) {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

/** What a canvas was asked to draw: enough of the context to read it back. */
function recorder() {
  const rects: { colour: string; alpha: number; x: number; y: number; w: number; h: number }[] = [];
  const context = {
    fillStyle: '#000',
    globalAlpha: 1,
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ colour: String(this.fillStyle), alpha: this.globalAlpha, x, y, w, h });
    },
  };
  return { rects, c: context as unknown as CanvasRenderingContext2D };
}

describe('the confetti', () => {
  const floor = floorFor({ taken: [0], working: [0] }, 0, ['meeting']);
  const room = roomOf(floor);

  /** Runs a party to the given time in frames of 16 ms and reads off what is in the air. */
  function party(until: number, seed = 7) {
    const state = startConfetti(room, confettiColours('#FF6B9A'), 0, seeded(seed));
    const counts: { at: number; pieces: number; landed: number }[] = [];
    for (let now = 0; now <= until; now += 16) {
      stepConfetti(state, now, 16);
      counts.push({
        at: now,
        pieces: state.pieces.length,
        landed: state.pieces.filter((piece) => piece.landed).length,
      });
    }
    return { state, counts };
  }

  it('is a lot: three volleys and a rain, several hundred pieces over the party', () => {
    const { state, counts } = party(CONFETTI_MS);
    expect(counts[0]!.pieces).toBeGreaterThanOrEqual(150);
    expect(state.pieces.length).toBeGreaterThanOrEqual(430);
    // It builds: more goes up after the first volley, not all at once.
    const at = (ms: number) => counts.find((count) => count.at >= ms)!.pieces;
    expect(at(1200)).toBeGreaterThan(at(100));
    expect(at(2500)).toBeGreaterThan(at(1200));
    expect(at(4000)).toBeGreaterThan(at(2500));
  });

  it('lasts for seconds, with something moving in the air through most of them', () => {
    const { counts } = party(CONFETTI_MS);
    // Most pieces are still falling at two seconds and some at four.
    const airborne = (ms: number) => {
      const count = counts.find((one) => one.at >= ms)!;
      return count.pieces - count.landed;
    };
    expect(airborne(2000)).toBeGreaterThan(150);
    expect(airborne(4000)).toBeGreaterThan(20);
    expect(CONFETTI_MS).toBeGreaterThanOrEqual(5000);
  });

  it('goes up over the table and comes down inside the room, landing on its floor', () => {
    const state = startConfetti(room, confettiColours('#48DBFB'), 0, seeded(3));
    let highest = Infinity;
    for (let now = 0; now <= CONFETTI_MS; now += 16) {
      stepConfetti(state, now, 16);
      highest = Math.min(highest, ...state.pieces.map((piece) => piece.y));
    }
    expect(highest).toBeLessThan(room.floor - 90);
    for (const piece of state.pieces) {
      expect(piece.x).toBeGreaterThanOrEqual(room.x0);
      expect(piece.x).toBeLessThanOrEqual(room.x1);
      expect(piece.y).toBeLessThanOrEqual(room.floor + 14);
    }
    expect(state.pieces.every((piece) => piece.landed)).toBe(true);
  });

  it('is made of whole pixels: small squares and thin streamers, never a speck', () => {
    const { state } = party(CONFETTI_MS);
    for (const piece of state.pieces) {
      expect(Number.isInteger(piece.size)).toBe(true);
      expect(piece.size).toBeGreaterThanOrEqual(2);
      expect(piece.size).toBeLessThanOrEqual(5);
    }
    const squares = state.pieces.filter((piece) => !piece.long);
    expect(squares.every((piece) => piece.size >= 4)).toBe(true);
    const { rects, c } = recorder();
    drawConfetti(c, state, 1000);
    expect(rects.length).toBe(state.pieces.length);
    for (const rect of rects) {
      expect(Number.isInteger(rect.x) && Number.isInteger(rect.y)).toBe(true);
      expect(Number.isInteger(rect.w) && Number.isInteger(rect.h)).toBe(true);
    }
    // The biggest are as big as a character's pixel is wide, twice and a half.
    expect(Math.max(...rects.map((rect) => Math.max(rect.w, rect.h)))).toBeGreaterThanOrEqual(5);
  });

  it('uses the project colour and neutral ones, and never red or amber', () => {
    const colours = confettiColours('#7BED9F');
    expect(colours).toContain('#7BED9F');
    expect(colours).toContain('#FFFFFF');
    const alerts = ['#ff4d4f', '#c33437', '#f2b33d', '#e04e50', '#ffb020', '#d97706'];
    for (const colour of colours) expect(alerts).not.toContain(colour.toLowerCase());
    const { state } = party(CONFETTI_MS);
    expect(new Set(state.pieces.map((piece) => piece.colour)).size).toBeGreaterThanOrEqual(6);
  });

  it('ends cleanly: it fades over the last of it, and nothing is drawn after', () => {
    const { state } = party(CONFETTI_MS);
    const alphaAt = (ms: number) => {
      const { rects, c } = recorder();
      drawConfetti(c, state, ms);
      return rects.length ? rects[0]!.alpha : 0;
    };
    expect(alphaAt(CONFETTI_MS - 4000)).toBe(1);
    expect(alphaAt(CONFETTI_MS - 400)).toBeGreaterThan(0);
    expect(alphaAt(CONFETTI_MS - 400)).toBeLessThan(1);
    expect(alphaAt(CONFETTI_MS)).toBe(0);
    expect(alphaAt(CONFETTI_MS + 5000)).toBe(0);
    expect(confettiOver(state, CONFETTI_MS - 1)).toBe(false);
    expect(confettiOver(state, CONFETTI_MS)).toBe(true);
  });

  it('is the same party for the same dice, and a different one for others', () => {
    const one = party(1500, 11).state.pieces.map((piece) => [piece.x, piece.y]);
    const two = party(1500, 11).state.pieces.map((piece) => [piece.x, piece.y]);
    const other = party(1500, 12).state.pieces.map((piece) => [piece.x, piece.y]);
    expect(one).toEqual(two);
    expect(one).not.toEqual(other);
  });

  it('is a still with reduced motion: the same pieces every frame, none moving', () => {
    const colours = confettiColours('#FF6B9A');
    const first = recorder();
    const second = recorder();
    stillConfetti(first.c, { x: 100, y: 200 }, colours, 3);
    stillConfetti(second.c, { x: 100, y: 200 }, colours, 3);
    expect(first.rects.length).toBeGreaterThanOrEqual(24);
    expect(first.rects).toEqual(second.rects);
    // Round the team, near where they stand, and not for a different agent in the same place.
    for (const rect of first.rects) {
      expect(Math.abs(rect.x - 100)).toBeLessThan(64);
      expect(rect.y).toBeGreaterThan(130);
      expect(rect.y).toBeLessThan(215);
    }
    const other = recorder();
    stillConfetti(other.c, { x: 100, y: 200 }, colours, 4);
    expect(other.rects).not.toEqual(first.rects);
  });
});
