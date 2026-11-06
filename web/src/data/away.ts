// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';

/** How long without a sign of the person before coming back counts as an absence. */
export const AWAY_MS = 15 * 60_000;
/** An absence nobody dismissed is forgotten after this long. */
export const ABSENCE_KEPT_MS = 12 * 60 * 60_000;
/** "What did I miss?" counts from the absence only while it is this recent, else the last hour. */
export const RECENT_ABSENCE_MS = 60 * 60_000;
/** The last time the person did something here is saved no more often than this. */
const SAVE_EVERY_MS = 10_000;

const LAST_ACTIVE_KEY = 'mabari.lastActive';
const ABSENCE_KEY = 'mabari.absence';

/** The time the person was away: from their last sign of life to when they came back, in ms. */
export interface Absence {
  from: number;
  to: number;
  /** Dismissed for this absence, so it stays dismissed after a reload. */
  dismissed: boolean;
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

/** The absence a long enough quiet stretch makes, or null. A first visit has no last time. */
export function absenceBetween(lastActive: number | null, now: number): Absence | null {
  if (lastActive === null || !Number.isFinite(lastActive) || lastActive <= 0) return null;
  return now - lastActive >= AWAY_MS ? { from: lastActive, to: now, dismissed: false } : null;
}

/** The absence saved before a reload, if it is well formed and still worth showing. */
export function restoreAbsence(raw: string | null, now: number): Absence | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Absence> | null;
    if (!value || typeof value.from !== 'number' || typeof value.to !== 'number') return null;
    if (!(value.from > 0) || value.to < value.from || now - value.to > ABSENCE_KEPT_MS) return null;
    return { from: value.from, to: value.to, dismissed: value.dismissed === true };
  } catch {
    return null;
  }
}

/** When "what did I miss?" counts from: the recent absence's start, or zero for the last hour. */
export function recapSince(absence: Absence | null, now: number): number {
  return absence && now - absence.to < RECENT_ABSENCE_MS ? absence.from : 0;
}

/** Whether Home shows the card for this absence: it hasn't been dismissed, and something happened. */
export function cardShown(absence: Absence | null, happened: boolean | undefined): boolean {
  return Boolean(absence && !absence.dismissed && happened);
}

function readNumber(storage: Storage, key: string): number | null {
  try {
    const value = Number(storage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function write(storage: Storage, key: string, value: string) {
  try {
    storage.setItem(key, value);
  } catch {
    // Without storage an absence is noticed only while the page stays open.
  }
}

export interface Tracker {
  /** The page just opened: notices an absence that ended now, or one saved before a reload. */
  start: () => Absence | null;
  /** The person did something, or came back to the page. */
  touch: () => void;
  /** The page is going away or hidden: save the last sign of life. */
  save: () => void;
}

/**
 * Tracks when the person was last here, with a clock and storage it is given. A gap of at least
 * AWAY_MS between two signs of life, or between the one saved and this page opening, is an
 * absence, and `found` hears about it once. Other tabs share the saved time, so activity in one
 * stops another from calling a quiet stretch an absence. Nothing is sent anywhere.
 */
export function tracker(
  storage: Storage,
  now: () => number,
  found: (absence: Absence) => void,
): Tracker {
  let last = 0;
  let saved = 0;
  const remember = (at: number) => {
    last = at;
    saved = at;
    write(storage, LAST_ACTIVE_KEY, String(at));
  };
  const begin = (absence: Absence) => {
    write(storage, ABSENCE_KEY, JSON.stringify(absence));
    found(absence);
  };
  return {
    start() {
      const at = now();
      const fresh = absenceBetween(readNumber(storage, LAST_ACTIVE_KEY), at);
      remember(at);
      if (fresh) {
        begin(fresh);
        return fresh;
      }
      const earlier = restoreAbsence(readStorage(storage, ABSENCE_KEY), at);
      if (earlier) found(earlier);
      return earlier;
    },
    touch() {
      const at = now();
      if (at - last >= AWAY_MS) {
        // Another tab may have been used in the meantime.
        const elsewhere = readNumber(storage, LAST_ACTIVE_KEY) ?? 0;
        const since = Math.max(last, elsewhere);
        const absence = absenceBetween(since, at);
        remember(at);
        if (absence) begin(absence);
        return;
      }
      last = at;
      if (at - saved >= SAVE_EVERY_MS) remember(at);
    },
    save() {
      if (last > 0) write(storage, LAST_ACTIVE_KEY, String(last));
    },
  };
}

function readStorage(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** The browser's storage, or one that keeps nothing where the browser won't give it out. */
export function browserStorage(): Storage {
  try {
    return window.localStorage;
  } catch {
    return { getItem: () => null, setItem: () => undefined };
  }
}

interface AwayState {
  /** The latest absence, or null when there has been none, or it is forgotten. */
  absence: Absence | null;
  set: (absence: Absence | null) => void;
  /** Dismisses the card for this absence, and remembers it across a reload. */
  dismiss: () => void;
}

export const useAway = create<AwayState>((set, get) => ({
  absence: null,
  set: (absence) => set({ absence }),
  dismiss: () => {
    const { absence } = get();
    if (!absence) return;
    const dismissed = { ...absence, dismissed: true };
    write(browserStorage(), ABSENCE_KEY, JSON.stringify(dismissed));
    set({ absence: dismissed });
  },
}));

const EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

/** Starts watching for the person coming back. Returns a function that stops it. */
export function startAbsenceWatch(): () => void {
  const watch = tracker(browserStorage(), Date.now, (absence) => useAway.getState().set(absence));
  watch.start();
  const onVisible = () => {
    if (document.visibilityState === 'visible') watch.touch();
    else watch.save();
  };
  const touch = () => watch.touch();
  const save = () => watch.save();
  for (const name of EVENTS) window.addEventListener(name, touch, { passive: true });
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pagehide', save);
  return () => {
    for (const name of EVENTS) window.removeEventListener(name, touch);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pagehide', save);
  };
}
