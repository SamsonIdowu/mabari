// SPDX-License-Identifier: Apache-2.0
// The floor's small moments: what an agent does for a second or two when something happens to it.
// They are pure, so they cost nothing to run for every agent on every frame, and are tested apart
// from the canvas.

/** How long a finished task's tick floats beside the agent. */
export const TICK_MS = 1800;
/** How long the hop and the confetti last after a task finishes. */
export const CHEER_MS = 2600;
/** The hop itself: two small ones, each smaller than the last. */
const HOP_MS = 800;
const HOP_PX = 5;
/**
 * How long a shipped project's party lasts, and so how long its team cheers: long enough for the
 * confetti to go up and come down and settle, and to be seen, without outstaying it.
 */
export const PARTY_MS = 7000;
/** One cheer is a jump: up and down in this long, again and again. */
export const JUMP_MS = 560;
/** How high the jump is, in pixels. */
export const JUMP_PX = 10;

/** How far off the floor a cheering agent is, `elapsed` ms into its jump: a clean arc, then down. */
export function jump(elapsed: number): number {
  return Math.round(JUMP_PX * Math.abs(Math.sin((elapsed / JUMP_MS) * Math.PI)));
}

/**
 * Whether an agent that began cheering at `cheerAt` is cheering `now`, and how high it is. It jumps
 * with its arms up and a smile. With `calm` (reduced motion) it holds the same pose, still, on the
 * floor: the party becomes a picture, not a shorter animation.
 */
export function cheering(
  cheerAt: number | undefined,
  now: number,
  calm: boolean,
): { lift: number } | null {
  if (cheerAt === undefined || now < cheerAt || now - cheerAt >= PARTY_MS) return null;
  return { lift: calm ? 0 : jump((now - cheerAt) % JUMP_MS) };
}

/** How long a new agent waves as it walks in. */
export const WAVE_MS = 1800;
/** An agent that needs you glances at the camera for this long, once in every `GLANCE_EVERY_MS`. */
export const GLANCE_MS = 900;
export const GLANCE_EVERY_MS = 6500;

/** How far a finished agent is off the floor, in pixels, `elapsed` ms after it finished. */
export function hop(elapsed: number): number {
  if (elapsed < 0 || elapsed >= HOP_MS) return 0;
  const left = 1 - elapsed / HOP_MS;
  return Math.round(HOP_PX * Math.abs(Math.sin((elapsed / HOP_MS) * Math.PI * 2)) * left);
}

/** The state of a finished task's moment: where each part of it is, or null once it is over. */
export interface Finishing {
  /** How far the agent is off the floor. */
  lift: number;
  /** Whether the confetti still falls. */
  confetti: boolean;
  /** Whether the tick still shows, and how far it has risen, from 0 to 1, and how clear it is. */
  tick: { rise: number; alpha: number } | null;
}

/**
 * What a task finishing looks like `now`, for an agent that reached Done at `doneAt`. An agent
 * found already Done, as when the page opens, has no `doneAt` and shows nothing: that task
 * finished some time ago. With `calm` (reduced motion) the tick still shows, as a still mark,
 * but nothing hops or falls.
 */
export function finishing(
  doneAt: number | undefined,
  now: number,
  calm: boolean,
): Finishing | null {
  if (!doneAt) return null;
  const elapsed = now - doneAt;
  if (elapsed < 0 || elapsed >= Math.max(TICK_MS, CHEER_MS)) return null;
  return {
    lift: calm ? 0 : hop(elapsed),
    confetti: !calm && elapsed < CHEER_MS,
    tick:
      elapsed < TICK_MS
        ? {
            rise: calm ? 1 : Math.min(1, elapsed / 500),
            alpha: Math.min(1, (TICK_MS - elapsed) / 400),
          }
        : null,
  };
}

/** Whether a new agent is still waving as it walks in. */
export function waving(waveUntil: number | undefined, now: number, calm: boolean): boolean {
  return !calm && waveUntil !== undefined && waveUntil > now;
}

/**
 * Whether an agent that needs you is looking at the camera. It turns its head now and then, each
 * on its own beat (`n`), so a floor of waiting agents doesn't all look round together.
 */
export function glancing(n: number, t: number, needsYou: boolean, calm: boolean): boolean {
  if (!needsYou || calm) return false;
  return (t + n * 1300) % GLANCE_EVERY_MS < GLANCE_MS;
}

export type Idle = 'coffee' | 'look' | 'book' | 'phone' | 'stretch';

/** What an agent resting in the lounge can be doing. */
const IDLES: Idle[] = ['coffee', 'look', 'book', 'phone', 'stretch'];
/** With reduced motion nothing changes, so only things that look right held still. */
const STILL_IDLES: Idle[] = ['coffee', 'look', 'book', 'phone'];
/** How long a lounging agent keeps to one thing before it changes. */
export const IDLE_SPELL_MS = 11000;
/** How long the stretch lasts, at the start of its spell. */
export const STRETCH_MS = 1600;

/**
 * What a resting agent is doing at time `t`. Each agent (by `n`) starts on its own thing and
 * changes every `IDLE_SPELL_MS`, so the lounge is never everyone drinking coffee in step.
 */
export function idleDoing(n: number, t: number, calm: boolean): Idle {
  const list = calm ? STILL_IDLES : IDLES;
  const spell = Math.floor(t / IDLE_SPELL_MS);
  return list[(n + spell * (1 + (n % 3))) % list.length]!;
}

/** Whether a resting agent doing `idle` has its arms up in a stretch right now. */
export function stretching(idle: Idle, t: number): boolean {
  return idle === 'stretch' && t % IDLE_SPELL_MS < STRETCH_MS;
}
