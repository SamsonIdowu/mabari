// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { Project } from '../gen/models.ts';
import { backRow } from './background.ts';
import { burst, LANDING, meetingSpots, MEETING_SEATS, stepPieces } from './celebration.ts';
import { floorFor } from './layout.ts';
import { caseSlots, layout, PER_CASE, shade, trophiesOf, trophyShape } from './trophies.ts';

const done = (id: string, at: number): Project =>
  ({ id, name: `Project ${id}`, color: '#48DBFB', done: { at } }) as unknown as Project;
const open = (id: string): Project =>
  ({ id, name: id, color: '#48DBFB', done: null }) as unknown as Project;

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
  it('lays out exactly as it did before the trophy shelf shared it', () => {
    for (const end of [300, 480, 600, 800, 1000, 1400, 2000]) {
      const kinds = { 56: 'shelf', 64: 'cabinets', 52: 'printer' } as const;
      expect(backRow(end)).toEqual(
        oldBackRow(end).map((place) => ({ x: place.x, kind: kinds[place.w as 56 | 64 | 52] })),
      );
    }
  });
});

describe('the trophy shelf', () => {
  const floor = floorFor();

  it('has a trophy only for each completed project, oldest first', () => {
    const shelf = trophiesOf([done('b', 20), open('x'), done('a', 10), done('c', 30)]);
    expect(shelf.map((project) => project.id)).toEqual(['a', 'b', 'c']);
  });

  it('puts six in a case, filling from the left, on two shelves of three', () => {
    const projects = Array.from({ length: 8 }, (_, index) => done(`p${index}`, index));
    const { spots, cases } = layout(floor, projects);
    expect(spots).toHaveLength(8);
    expect(cases).toBe(2);
    const slots = caseSlots(floor);
    expect(slots.length).toBeGreaterThanOrEqual(2);
    // The first six are in the first case: three across, two shelves.
    expect(
      spots.slice(0, PER_CASE).every((spot) => spot.x >= slots[0]! && spot.x < slots[0]! + 52),
    ).toBe(true);
    expect(new Set(spots.slice(0, 3).map((spot) => spot.y)).size).toBe(1);
    expect(spots[3]!.y).toBeGreaterThan(spots[0]!.y);
    expect(spots[0]!.x).toBeLessThan(spots[1]!.x);
    // The seventh starts the second case.
    expect(spots[6]!.x).toBeGreaterThanOrEqual(slots[1]!);
  });

  it('has no cases at all until a project is completed', () => {
    expect(layout(floor, [open('a')])).toEqual({ spots: [], hidden: 0, cases: 0 });
  });

  it('shows the newest and says how many it has no room for, when the row is full', () => {
    const room = caseSlots(floor).length * PER_CASE;
    const projects = Array.from({ length: room + 3 }, (_, index) => done(`p${index}`, index));
    const { spots, hidden } = layout(floor, projects);
    expect(spots).toHaveLength(room);
    expect(hidden).toBe(3);
    expect(spots.at(-1)!.id).toBe(`p${room + 2}`);
    expect(spots.some((spot) => spot.id === 'p0')).toBe(false);
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
});

describe('the confetti', () => {
  it('goes up and out in the colours given, and comes to rest in the room', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const origin = { x: 500, y: 300 };
    const pieces = burst(origin, ['#111111', '#222222'], random);
    expect(pieces).toHaveLength(64);
    expect(new Set(pieces.map((piece) => piece.colour))).toEqual(new Set(['#111111', '#222222']));
    expect(pieces.every((piece) => piece.vy < 0)).toBe(true);
    const landing = origin.y + LANDING;
    let highest = origin.y;
    for (let ms = 0; ms < 6000; ms += 16) {
      stepPieces(pieces, 16, landing);
      highest = Math.min(highest, ...pieces.map((piece) => piece.y));
    }
    expect(highest).toBeLessThan(origin.y - 20);
    // Everything has landed, below where it went up and not past the floor of the room.
    for (const piece of pieces) {
      expect(piece.vx === 0 && piece.vy === 0).toBe(true);
      expect(piece.y).toBeGreaterThanOrEqual(landing);
      expect(piece.y).toBeLessThan(landing + 7);
    }
    // Nothing flew out of the room sideways.
    expect(Math.max(...pieces.map((piece) => Math.abs(piece.x - origin.x)))).toBeLessThan(130);
  });
});
