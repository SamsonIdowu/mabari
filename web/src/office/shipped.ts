// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';
import { useOfficeStore } from '../data/officeStore.ts';
import type { Project } from '../gen/models.ts';
import { PARTY_MS } from './moments.ts';
import { playChime } from './officeSound.ts';

/**
 * Shipping a project: when one is marked complete, its agents walk to the meeting room, a burst of
 * confetti and "Shipped" show once, and then everyone goes back to work. This is the plan for it,
 * with no canvas and no DOM, so it can be tested, and the store the floor and the banner read.
 *
 * Rules, each pinned by a test: it plays once for a completion and never again on a reload; it
 * waits for the office to be on screen, and gives up after EXPIRES_MS rather than play late; it
 * never plays while an approval waits on you, and stops if one arrives; with reduced motion
 * nobody walks and nothing falls, and the banner shows still.
 */

/** A project that was just completed. `key` is the project and the moment it was completed. */
export interface Shipment {
  key: string;
  id: string;
  name: string;
  color: string;
  /** When this page heard of it, in milliseconds. */
  heardAt: number;
}

export type ShippedPhase = 'idle' | 'gather' | 'party';

export interface ShippedState {
  phase: ShippedPhase;
  /** The project being celebrated, or null when idle. */
  current: Shipment | null;
  /** When the phase began. */
  since: number;
  /** Completions waiting for the office to show. */
  queue: Shipment[];
  /** Whether the office floor is on screen, which is where it is celebrated. */
  watching: boolean;
  /** The one celebrated last, and when its party began, so its trophy can glint. */
  last: { id: string; at: number } | null;
}

/** A completion waits this long for the office to show, and is dropped after, not played late. */
export const EXPIRES_MS = 3 * 60 * 1000;
/** The walk to the meeting room is given this long, so one agent stuck can't hold the party. */
export const GATHER_MAX_MS = 14_000;
export { PARTY_MS };

export const initialShipped: ShippedState = {
  phase: 'idle',
  current: null,
  since: 0,
  queue: [],
  watching: false,
  last: null,
};

/** The key that says which completion this was: reopened and completed again, it is a new one. */
export const shipmentKey = (project: Pick<Project, 'id'> & { done: { at: number } }) =>
  `${project.id}:${project.done.at}`;

/** A project was marked complete. It joins the queue, unless it is already there or played. */
export function completed(
  state: ShippedState,
  shipment: Shipment,
  seen: ReadonlySet<string>,
): ShippedState {
  if (seen.has(shipment.key) || state.current?.key === shipment.key) return state;
  if (state.queue.some((item) => item.key === shipment.key)) return state;
  return { ...state, queue: [...state.queue, shipment] };
}

/** The office came on screen or went off it. Going off stops a celebration under way. */
export function watching(state: ShippedState, on: boolean): ShippedState {
  if (state.watching === on) return state;
  const next = { ...state, watching: on };
  return on ? next : stopped(next);
}

function stopped(state: ShippedState): ShippedState {
  return { ...state, phase: 'idle', current: null };
}

/** What the floor knows each frame, which decides how the celebration goes on. */
export interface Frame {
  /** Every agent sent to the meeting room has got there. */
  arrived: boolean;
  /** An approval waits on you somewhere, so nothing plays. */
  approval: boolean;
  /** Reduced motion: nobody walks and nothing falls. */
  calm: boolean;
}

/**
 * Moves the celebration on by one frame: starts the next in the queue when the office shows and
 * nothing waits on you, goes from the walk to the party once everyone is there, and ends the
 * party. An approval stops it at once. Returns the same state when nothing changed.
 */
export function step(state: ShippedState, now: number, frame: Frame): ShippedState {
  // Most frames have nothing to celebrate, and cost nothing.
  if (state.phase === 'idle' && state.queue.length === 0) return state;
  const fresh = state.queue.filter((item) => now - item.heardAt <= EXPIRES_MS);
  let next = fresh.length === state.queue.length ? state : { ...state, queue: fresh };
  if (frame.approval && next.phase !== 'idle') return stopped(next);
  switch (next.phase) {
    case 'idle': {
      const [first, ...rest] = next.queue;
      if (!first || !next.watching || frame.approval) return next;
      // With reduced motion there is no walk: it goes straight to the party.
      next = {
        ...next,
        phase: frame.calm ? 'party' : 'gather',
        current: first,
        queue: rest,
        since: now,
      };
      return frame.calm ? { ...next, last: { id: first.id, at: now } } : next;
    }
    case 'gather':
      if (frame.arrived || now - next.since > GATHER_MAX_MS) {
        return {
          ...next,
          phase: 'party',
          since: now,
          last: next.current ? { id: next.current.id, at: now } : next.last,
        };
      }
      return next;
    case 'party':
      return now - next.since > PARTY_MS ? stopped(next) : next;
  }
}

// ---- what has been celebrated, kept across reloads ----

const SEEN_KEY = 'mabari.shipped';
const SEEN_KEPT = 200;

/** The completions already celebrated, from storage that may be missing or full of junk. */
export function loadSeen(storage: Pick<Storage, 'getItem'> | undefined): Set<string> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(SEEN_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Remembers that a completion has been celebrated, keeping the latest few hundred. */
export function saveSeen(storage: Pick<Storage, 'setItem'> | undefined, seen: Set<string>): void {
  try {
    storage?.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-SEEN_KEPT)));
  } catch {
    // Storage can be blocked or full; the celebration still plays once this session.
  }
}

const storage = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

interface ShippedStore extends ShippedState {
  /** A completion was heard of. */
  heard: (shipment: Shipment) => void;
  /** The office floor came on or off the screen. */
  watch: (on: boolean) => void;
  /** Called every frame by the floor. */
  tick: (now: number, frame: Frame) => void;
}

export const useShipped = create<ShippedStore>((set, get) => ({
  ...initialShipped,
  heard: (shipment) => set((state) => completed(state, shipment, loadSeen(storage()))),
  watch: (on) => set((state) => watching(state, on)),
  tick: (now, frame) => {
    const before = get();
    const after = step(before, now, frame);
    if (after === before) return;
    // Remember it as soon as it starts, so a reload in the middle doesn't play it again.
    if (after.current && after.current.key !== before.current?.key) {
      const seen = loadSeen(storage());
      seen.add(after.current.key);
      saveSeen(storage(), seen);
    }
    set(after);
    // A soft chime as the party begins, if the office's sound is on.
    if (after.phase === 'party' && before.phase !== 'party') playChime();
  },
}));

/** A project this page never saw open still counts as just completed if it was this recently. */
export const RECENT_MS = 15_000;

/**
 * Which projects were completed between two offices: open before, done after. A project the page
 * had not seen at all counts too when it was completed moments ago, because the messages that
 * made it and finished it can arrive in the same frame. The first office a page sees has nothing
 * before it, so a reload hears of nothing, and neither does a project that was done long ago.
 */
export function newlyCompleted(
  before: Project[] | undefined,
  after: Project[],
  now: number = Date.now(),
): Project[] {
  if (!before) return [];
  return after.filter((project) => {
    if (!project.done) return false;
    const was = before.find((item) => item.id === project.id);
    if (was) return !was.done;
    return now - project.done.at >= 0 && now - project.done.at < RECENT_MS;
  });
}

/** Starts listening to the office for completed projects, and returns how to stop. */
export function listenForCompletions(): () => void {
  return useOfficeStore.subscribe((state, previous) => {
    if (!state.office || state.office === previous.office) return;
    for (const project of newlyCompleted(previous.office?.projects, state.office.projects)) {
      if (!project.done) continue;
      useShipped.getState().heard({
        key: shipmentKey({ id: project.id, done: project.done }),
        id: project.id,
        name: project.name,
        color: project.color,
        heardAt: Date.now(),
      });
    }
  });
}
