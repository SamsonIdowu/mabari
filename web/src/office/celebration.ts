// SPDX-License-Identifier: Apache-2.0
import { R } from './background.ts';
import { roomSpots, type Floor, type Point } from './layout.ts';
import { shade } from './trophies.ts';
import type { Rect } from './camera.ts';

/**
 * How many agents walk to the meeting room: a row of four, as far apart as the room allows. A
 * bigger team sends four, and the rest cheer at their desks.
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

/**
 * The meeting room as the camera frames it: its glass wall to the office's end, from its top wall
 * down to the row where the team stands, with room above for the confetti to go up into and below
 * for the name tags.
 */
export function meetingFrame(floor: Floor): Rect {
  const x0 = (floor.wall ?? floor.width - 256) - 16;
  return { x0, x1: floor.width + 6, y0: 196, y1: 424 };
}

// ---------------------------------------------------------------------------------------------
// The confetti. Flat square pixels like everything on the floor, a lot of them, in three volleys
// and a slow rain, for most of the party, and gone before it ends.
// ---------------------------------------------------------------------------------------------

/** One piece of confetti. */
export interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Its colour, as an index into the party's colours, so a frame draws a colour at a time. */
  colour: number;
  /** Its size in pixels: a square, or a streamer when `long`. */
  size: number;
  long: boolean;
  /** Where in its flutter and its turn it is, and how fast it turns. */
  phase: number;
  spin: number;
  /** The line it comes to rest on, and whether it has. */
  rest: number;
  landed: boolean;
}

/** How long the confetti lasts, and how long of that it fades out for. After this none is left. */
export const CONFETTI_MS = 6000;
const FADE_MS = 900;
/** Gravity, in pixels per millisecond squared; the slowest a falling piece goes; the air's drag. */
const GRAVITY = 0.00034;
const FALL = 0.06;
const DRAG = 0.0016;

/** A volley: when it goes off, and the cannons it goes off from, as shares of the room's width. */
const VOLLEYS: { at: number; from: number[]; each: number }[] = [
  { at: 0, from: [0.12, 0.5, 0.88], each: 58 },
  { at: 1100, from: [0.06, 0.94], each: 40 },
  { at: 2300, from: [0.25, 0.5, 0.75], each: 36 },
];
/** The rain: pieces let go along the room's top wall between these two moments. */
const RAIN = { from: 300, to: 3600, count: 120 };

/** The room the confetti is in: where its walls are and the floor it comes to rest on. */
export interface Room {
  x0: number;
  x1: number;
  /** The top wall, which the rain comes from, and the carpet's front edge, which it lands on. */
  top: number;
  floor: number;
}

export function roomOf(floor: Floor): Room {
  const x0 = floor.wall ?? floor.width - 256;
  return { x0: x0 + 16, x1: floor.width - 8, top: 240, floor: 366 };
}

/** Everything about one party's confetti. The pieces are made as the party goes on. */
export interface Confetti {
  pieces: Piece[];
  /** The colours pieces are drawn in. */
  colours: string[];
  room: Room;
  /** When it began, and how much of it has gone off. */
  started: number;
  volleys: number;
  rained: number;
  random: () => number;
}

/**
 * The colours of a project's confetti: the project's own, two lighter shades of it, white, two
 * greys and a green. No darker shade, which turns a pink project's confetti crimson. Never red or
 * amber of its own, which the floor keeps for what needs you.
 */
export function confettiColours(project: string): string[] {
  return [
    project,
    shade(project, 0.45),
    shade(project, 0.7),
    '#FFFFFF',
    '#C4C4C7',
    project,
    '#8E8E93',
    '#3FB97A',
  ];
}

/** Starts a party's confetti at `now`. `random` is passed in so a test can pin it. */
export function startConfetti(
  room: Room,
  colours: string[],
  now: number,
  random: () => number = Math.random,
): Confetti {
  return { pieces: [], colours, room, started: now, volleys: 0, rained: 0, random };
}

function piece(state: Confetti, x: number, y: number, vx: number, vy: number): Piece {
  const { random } = state;
  const long = random() < 0.18;
  return {
    x,
    y,
    vx,
    vy,
    colour: Math.floor(random() * state.colours.length),
    size: long ? 2 : random() < 0.35 ? 5 : 4,
    long,
    phase: random() * Math.PI * 2,
    spin: 0.006 + random() * 0.008,
    rest: state.room.floor - 6 + random() * 20,
    landed: false,
  };
}

/** A volley from one cannon: up and out in a fan, fast enough to reach most of the room's height. */
function fire(state: Confetti, x: number, count: number): void {
  const { random, room } = state;
  const lean = (x - (room.x0 + room.x1) / 2) / (room.x1 - room.x0);
  for (let index = 0; index < count; index++) {
    const angle = -Math.PI / 2 + (random() - 0.5) * 1.15 - lean * 0.5;
    const speed = 0.14 + random() * 0.14;
    state.pieces.push(
      piece(
        state,
        x + (random() - 0.5) * 12,
        room.floor - 46,
        Math.cos(angle) * speed,
        Math.sin(angle) * speed,
      ),
    );
  }
}

/**
 * Moves the confetti on to `now`: sets off any volley that is due, lets go of the rain that is
 * due, and moves every piece up and out, slowing, then floating down and turning, to lie where it
 * lands. `dt` is the milliseconds since the last frame.
 */
export function stepConfetti(state: Confetti, now: number, dt: number): void {
  const age = now - state.started;
  const { room } = state;
  const across = room.x1 - room.x0;
  while (state.volleys < VOLLEYS.length && age >= VOLLEYS[state.volleys]!.at) {
    const volley = VOLLEYS[state.volleys]!;
    for (const share of volley.from) fire(state, room.x0 + across * share, volley.each);
    state.volleys++;
  }
  const rainDue = Math.min(
    RAIN.count,
    Math.max(0, Math.floor(((age - RAIN.from) / (RAIN.to - RAIN.from)) * RAIN.count)),
  );
  for (; state.rained < rainDue; state.rained++) {
    state.pieces.push(
      piece(state, room.x0 + state.random() * across, room.top + state.random() * 10, 0, 0.02),
    );
  }
  const air = Math.max(0, 1 - DRAG * dt);
  for (const one of state.pieces) {
    if (one.landed) continue;
    one.vy += GRAVITY * dt;
    // The air slows a piece going up, and a falling one settles to a slow float, swaying as it goes.
    one.vx *= air;
    if (one.vy > FALL) one.vy += (FALL - one.vy) * Math.min(1, 0.006 * dt);
    one.x += (one.vx + Math.sin(age * 0.005 + one.phase) * 0.028) * dt;
    one.y += one.vy * dt;
    if (one.y >= one.rest && one.vy > 0) {
      one.y = one.rest;
      one.landed = true;
      one.vx = 0;
      one.vy = 0;
    }
    one.x = Math.min(room.x1, Math.max(room.x0, one.x));
  }
}

/** Whether the confetti is over: the party has run its course, and none is left to show. */
export function confettiOver(state: Confetti, now: number): boolean {
  return now - state.started >= CONFETTI_MS;
}

/**
 * Draws the confetti, a colour at a time, turning as it falls, and fading out for the last of it.
 * Pieces are drawn as whole pixels. A streamer is a thin stick and a square turns edge on.
 */
export function drawConfetti(c: CanvasRenderingContext2D, state: Confetti, now: number): void {
  const age = now - state.started;
  const alpha = Math.max(0, Math.min(1, (CONFETTI_MS - age) / FADE_MS));
  if (alpha <= 0) return;
  c.globalAlpha = alpha;
  state.colours.forEach((colour, index) => {
    c.fillStyle = colour;
    for (const one of state.pieces) {
      if (one.colour !== index) continue;
      const turn = one.landed ? 1 : Math.abs(Math.cos(one.phase + age * one.spin));
      const wide = one.long ? one.size : Math.max(1, Math.round(one.size * (0.45 + 0.55 * turn)));
      const tall = one.long ? 7 : one.size;
      c.fillRect(Math.round(one.x), Math.round(one.y), wide, tall);
    }
  });
  c.globalAlpha = 1;
}

/**
 * With reduced motion the party is a still picture: confetti already lying where it fell, round
 * each of the cheering team, and nothing that moves. The same pieces every frame.
 */
export function stillConfetti(
  c: CanvasRenderingContext2D,
  around: Point,
  colours: string[],
  seed: number,
): void {
  let state = (seed * 2654435761) >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let index = 0; index < 16; index++) {
    const x = around.x + (next() - 0.5) * 70;
    const y = around.y - 54 + next() * 62;
    R(c, Math.round(x), Math.round(y), next() < 0.4 ? 5 : 4, 4, colours[index % colours.length]!);
  }
}
