// SPDX-License-Identifier: Apache-2.0
import type { LiveAgent } from '../gen/models.ts';
import { identityHues, type ProviderName } from '../shared/tokens.ts';
import { drawChar } from './character.ts';
import { HAIRS, SKINS } from './resting.ts';
import type { Walker } from './scene.ts';
import { drawTrophy } from './trophies.ts';

/**
 * The cast: the floor's own characters, standing in an empty state to say what is missing and
 * what to do about it, instead of a bare line of text. Each is drawn with the same code as the
 * agents on the floor, so they are the same people, in the pose that fits the page.
 */

/** What a cast member is doing. */
export type Act =
  /** Waving hello: nothing is connected yet. */
  | 'wave'
  /** Thinking, with the dots: a conversation to come. */
  | 'think'
  /** Resting with a coffee: nothing has happened. */
  | 'rest'
  /** Reading a book: something to learn or build. */
  | 'read'
  /** New beginnings, in sparkles: a first project, a first agent. */
  | 'sparkle'
  /** A trophy at its side: nothing shipped yet. */
  | 'trophy';

const STATE: Record<Act, LiveAgent['state']> = {
  wave: 'approval',
  think: 'thinking',
  rest: 'idle',
  read: 'reading',
  sparkle: 'spawning',
  trophy: 'idle',
};

/** The three AIs' colours, in the order the cast is given them. */
const PROVIDERS: ProviderName[] = ['claude', 'openai', 'custom'];

/**
 * How big a cast picture is, in canvas pixels (the page shows it twice as big, keeping its
 * pixels square), and where the feet stand. Thinking needs room above for its bubble and
 * sparkles a little; the rest are cropped close, so a small empty state stays small.
 */
export function sizeOf(act: Act): {
  width: number;
  height: number;
  feet: { x: number; y: number };
} {
  const height = { think: 84, sparkle: 64, wave: 60, rest: 58, read: 58, trophy: 58 }[act];
  return { width: 60, height, feet: { x: 24, y: height - 6 } };
}

/** A cast member: the same person for the same number, whichever page it stands on. */
export function lookOf(who: number) {
  return {
    skin: SKINS[who % SKINS.length]!,
    hair: HAIRS[(who * 3 + 1) % HAIRS.length]!,
    hue: identityHues[(who * 5 + 2) % identityHues.length]!,
    provider: PROVIDERS[who % PROVIDERS.length]!,
  };
}

/**
 * Draws cast member `who` doing `act` at time `t`. `calm` is reduced motion: held still, and only
 * doing what looks right held still.
 */
export function paintCast(
  c: CanvasRenderingContext2D,
  who: number,
  act: Act,
  t: number,
  theme: 'dark' | 'light',
  calm: boolean,
): void {
  const { width, height, feet } = sizeOf(act);
  c.clearRect(0, 0, width, height);
  const look = lookOf(who);
  const walker = {
    id: `cast-${who}`,
    name: 'Cast',
    state: STATE[act],
    provider: look.provider,
    hue: look.hue,
    skin: look.skin,
    hair: look.hair,
    n: who + 1,
    x: feet.x,
    y: feet.y,
    path: [],
    dir: 0,
    walk: 0,
    spd: 0,
    popUntil: 0,
    front: true,
    question: null,
    working: false,
  } as unknown as Walker;
  drawChar(c, walker, calm ? 0 : t, false, false, calm);
  if (act === 'trophy') drawTrophy(c, `cast-${who}`, look.hue, feet.x + 18, feet.y - 18, theme);
}
