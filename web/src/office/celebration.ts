// SPDX-License-Identifier: Apache-2.0
import { R } from './background.ts';
import { roomSpots, type Floor, type Point } from './layout.ts';

/**
 * How many agents walk to the meeting room: a row of four, as far apart as the room allows, so
 * their name tags don't run together. A bigger team sends four and the rest cheer at their desks.
 */
export const MEETING_SEATS = 4;
const PITCH = 58;

/**
 * Where each of `count` agents stands in the meeting room for the celebration: in a row in front
 * of the table, from the room's own spots. The room is open for as long as this is wanted.
 */
export function meetingSpots(floor: Floor, count: number): Point[] {
  const [left] = roomSpots('meeting', floor) as [Point, Point, Point];
  return Array.from({ length: Math.min(count, MEETING_SEATS) }, (_, index) => ({
    x: Math.round(left.x - 16 + index * PITCH),
    y: left.y,
  }));
}

/** The middle of the meeting room's table, where the confetti goes up from. */
export function meetingCentre(floor: Floor): Point {
  const [, middle] = roomSpots('meeting', floor) as [Point, Point, Point];
  return { x: middle.x, y: 318 };
}

/** One piece of confetti. */
export interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  colour: string;
  size: number;
}

/** Gravity on a piece, in pixels per millisecond squared, and how long a burst lasts. */
const GRAVITY = 0.0004;
/** How far below where it went up a piece lands, so the confetti stays in the room. */
export const LANDING = 66;
export const BURST_MS = 2600;

/**
 * A burst of confetti going up and out from `origin`, in the given colours. `random` is passed in
 * so a test can pin it. Flat square pixels, like everything else on the floor.
 */
export function burst(
  origin: Point,
  colours: string[],
  random: () => number = Math.random,
  count = 64,
): Piece[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + (random() - 0.5) * Math.PI * 0.5;
    const speed = 0.12 + random() * 0.15;
    return {
      x: origin.x + (random() - 0.5) * 20,
      y: origin.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      colour: colours[index % colours.length]!,
      size: random() < 0.3 ? 4 : 3,
    };
  });
}

/**
 * Moves the confetti on by `dt` milliseconds: up and out, slowing, then falling, and lying where
 * it lands, `landing` pixels below where it went up.
 */
export function stepPieces(pieces: Piece[], dt: number, landing: number): void {
  for (const piece of pieces) {
    if (piece.vy === 0 && piece.vx === 0) continue;
    piece.vy += GRAVITY * dt;
    piece.vx *= 1 - Math.min(1, 0.002 * dt);
    piece.x += piece.vx * dt;
    piece.y += piece.vy * dt;
    if (piece.y >= landing && piece.vy > 0) {
      piece.y = landing + ((piece.x * 7) % 6);
      piece.vx = 0;
      piece.vy = 0;
    }
  }
}

/** Draws the confetti, fading out over the last of the burst. */
export function drawPieces(c: CanvasRenderingContext2D, pieces: Piece[], age: number): void {
  c.globalAlpha = Math.max(0, Math.min(1, (BURST_MS - age) / 700));
  for (const piece of pieces) R(c, piece.x, piece.y, piece.size, piece.size, piece.colour);
  c.globalAlpha = 1;
}

/**
 * The colours of a project's confetti: the project's own, white, and two greys and a green. Never
 * red or amber, which the floor keeps for what needs you.
 */
export function confettiColours(project: string): string[] {
  return [project, '#FFFFFF', '#C4C4C7', project, '#8E8E93', '#3FB97A'];
}
