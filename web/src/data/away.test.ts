// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ABSENCE_KEPT_MS,
  AWAY_MS,
  RECENT_ABSENCE_MS,
  absenceBetween,
  browserStorage,
  cardShown,
  recapSince,
  restoreAbsence,
  tracker,
  type Absence,
} from './away.ts';

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;

/** A storage that is only a map, and a clock the test moves. */
function setup() {
  const items = new Map<string, string>();
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
  const clock = { now: NOW };
  const found: Absence[] = [];
  const watch = tracker(
    storage,
    () => clock.now,
    (absence) => found.push(absence),
  );
  return { items, storage, clock, found, watch };
}

describe('an absence', () => {
  it('is a quiet stretch of at least fifteen minutes, from the last sign of life to coming back', () => {
    expect(absenceBetween(NOW - 15 * MINUTE, NOW)).toEqual({
      from: NOW - 15 * MINUTE,
      to: NOW,
      dismissed: false,
    });
    expect(absenceBetween(NOW - 15 * MINUTE + 1, NOW)).toBeNull();
    expect(absenceBetween(NOW - 80 * MINUTE, NOW)?.from).toBe(NOW - 80 * MINUTE);
    expect(AWAY_MS).toBe(15 * MINUTE);
  });

  it('is nothing on a first visit, which has no last time, or a time that makes no sense', () => {
    expect(absenceBetween(null, NOW)).toBeNull();
    expect(absenceBetween(0, NOW)).toBeNull();
    expect(absenceBetween(Number.NaN, NOW)).toBeNull();
    expect(absenceBetween(-5, NOW)).toBeNull();
  });
});

describe('an absence kept across a reload', () => {
  const kept: Absence = { from: NOW - 90 * MINUTE, to: NOW - 5 * MINUTE, dismissed: false };

  it('comes back as it was, dismissed or not', () => {
    expect(restoreAbsence(JSON.stringify(kept), NOW)).toEqual(kept);
    expect(restoreAbsence(JSON.stringify({ ...kept, dismissed: true }), NOW)).toEqual({
      ...kept,
      dismissed: true,
    });
  });

  it('is forgotten after twelve hours', () => {
    const ended = (at: number): Absence => ({ from: at - 30 * MINUTE, to: at, dismissed: false });
    expect(restoreAbsence(JSON.stringify(ended(NOW - ABSENCE_KEPT_MS - 1)), NOW)).toBeNull();
    expect(restoreAbsence(JSON.stringify(ended(NOW - ABSENCE_KEPT_MS)), NOW)).not.toBeNull();
  });

  it('is nothing when what was saved is not an absence', () => {
    for (const raw of [
      null,
      '',
      'not json',
      'null',
      '[]',
      '{}',
      JSON.stringify({ from: 'x', to: 2 }),
      JSON.stringify({ from: -1, to: 2 }),
      JSON.stringify({ from: 10, to: 5 }),
    ]) {
      expect(restoreAbsence(raw, NOW)).toBeNull();
    }
  });
});

describe('the time Mabari counts "what did I miss?" from', () => {
  const absence: Absence = { from: NOW - 90 * MINUTE, to: NOW - 5 * MINUTE, dismissed: false };
  it('is the start of the absence while it is recent', () => {
    expect(recapSince(absence, NOW)).toBe(absence.from);
    expect(recapSince({ ...absence, dismissed: true }, NOW)).toBe(absence.from);
  });
  it('is the last hour, which is zero, when there was none or it was a while ago', () => {
    expect(recapSince(null, NOW)).toBe(0);
    expect(recapSince(absence, absence.to + RECENT_ABSENCE_MS)).toBe(0);
    expect(recapSince(absence, absence.to + RECENT_ABSENCE_MS - 1)).toBe(absence.from);
  });
});

describe('the card', () => {
  const absence: Absence = { from: 1, to: 2, dismissed: false };
  it('shows only when something happened and it has not been dismissed', () => {
    expect(cardShown(absence, true)).toBe(true);
    expect(cardShown(absence, false)).toBe(false);
    expect(cardShown(absence, undefined)).toBe(false);
    expect(cardShown({ ...absence, dismissed: true }, true)).toBe(false);
    expect(cardShown(null, true)).toBe(false);
  });
});

describe('the tracker', () => {
  it('finds nothing on a first visit, and starts the clock', () => {
    const { watch, found, items } = setup();
    expect(watch.start()).toBeNull();
    expect(found).toEqual([]);
    expect(items.get('mabari.lastActive')).toBe(String(NOW));
  });

  it('finds an absence when the page opens long after the last visit, and keeps it', () => {
    const { watch, found, items, clock } = setup();
    items.set('mabari.lastActive', String(NOW - 80 * MINUTE));
    const absence = watch.start();
    expect(absence).toEqual({ from: NOW - 80 * MINUTE, to: NOW, dismissed: false });
    expect(found).toEqual([absence]);
    expect(JSON.parse(items.get('mabari.absence') ?? 'null')).toEqual(absence);
    // The last time is now, so the next visit measures from here.
    expect(items.get('mabari.lastActive')).toBe(String(clock.now));
  });

  it('finds nothing for a short break', () => {
    const { watch, found, items } = setup();
    items.set('mabari.lastActive', String(NOW - 14 * MINUTE));
    expect(watch.start()).toBeNull();
    expect(found).toEqual([]);
  });

  it('brings back the absence a reload interrupted, and a dismissed one stays dismissed', () => {
    const first = setup();
    first.items.set('mabari.lastActive', String(NOW - 80 * MINUTE));
    const absence = first.watch.start();
    // A reload a minute later reads the same storage.
    const second = setup();
    for (const [key, value] of first.items) second.items.set(key, value);
    second.clock.now = NOW + MINUTE;
    expect(second.watch.start()).toEqual(absence);
    expect(second.found).toEqual([absence]);
    // Dismissed is written by the page, as the store does.
    second.items.set('mabari.absence', JSON.stringify({ ...absence, dismissed: true }));
    const third = setup();
    for (const [key, value] of second.items) third.items.set(key, value);
    third.clock.now = NOW + 2 * MINUTE;
    expect(third.watch.start()).toMatchObject({ dismissed: true });
  });

  it('forgets an absence nobody dismissed after twelve hours', () => {
    const { watch, found, items, clock } = setup();
    const absence: Absence = { from: NOW - 90 * MINUTE, to: NOW - 60 * MINUTE, dismissed: false };
    items.set('mabari.absence', JSON.stringify(absence));
    clock.now = absence.to + ABSENCE_KEPT_MS + 1;
    items.set('mabari.lastActive', String(clock.now - MINUTE));
    expect(watch.start()).toBeNull();
    expect(found).toEqual([]);
  });

  it('notices someone coming back to a page that stayed open, on their first sign of life', () => {
    const { watch, found, clock, items } = setup();
    watch.start();
    clock.now += 5 * MINUTE;
    watch.touch();
    clock.now += 20 * MINUTE;
    watch.touch();
    expect(found).toEqual([{ from: NOW + 5 * MINUTE, to: NOW + 25 * MINUTE, dismissed: false }]);
    expect(JSON.parse(items.get('mabari.absence') ?? 'null')).toEqual(found[0]);
    // More signs of life are the same visit.
    clock.now += MINUTE;
    watch.touch();
    clock.now += 14 * MINUTE;
    watch.touch();
    expect(found).toHaveLength(1);
  });

  it('does not call a quiet stretch an absence when another tab was in use', () => {
    const { watch, found, clock, items } = setup();
    watch.start();
    clock.now += 30 * MINUTE;
    // Another tab wrote its own sign of life two minutes ago.
    items.set('mabari.lastActive', String(clock.now - 2 * MINUTE));
    watch.touch();
    expect(found).toEqual([]);
  });

  it('saves the last sign of life no more than every ten seconds, and when the page goes', () => {
    const { watch, clock, items } = setup();
    watch.start();
    clock.now += 4_000;
    watch.touch();
    expect(items.get('mabari.lastActive')).toBe(String(NOW));
    clock.now += 7_000;
    watch.touch();
    expect(items.get('mabari.lastActive')).toBe(String(NOW + 11_000));
    clock.now += 3_000;
    watch.touch();
    expect(items.get('mabari.lastActive')).toBe(String(NOW + 11_000));
    // Leaving writes the latest, not the time of leaving.
    clock.now += 60_000;
    watch.save();
    expect(items.get('mabari.lastActive')).toBe(String(NOW + 14_000));
  });

  it('carries on when storage cannot be used', () => {
    const found: Absence[] = [];
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    let now = NOW;
    const watch = tracker(
      broken,
      () => now,
      (absence) => found.push(absence),
    );
    expect(watch.start()).toBeNull();
    now += 30 * MINUTE;
    // Without storage the page still notices a long quiet stretch while it stays open.
    watch.touch();
    watch.save();
    expect(found).toEqual([{ from: NOW, to: NOW + 30 * MINUTE, dismissed: false }]);
  });
});

describe('the browser storage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps nothing, and does not throw, where the browser will not give it out', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    const storage = browserStorage();
    expect(() => storage.setItem('a', 'b')).not.toThrow();
    expect(storage.getItem('a')).toBeNull();
    // The tracker works on it as on any other: a first visit, with nothing found.
    const found: Absence[] = [];
    expect(
      tracker(
        storage,
        () => NOW,
        (absence) => found.push(absence),
      ).start(),
    ).toBeNull();
    expect(found).toEqual([]);
  });

  it('is the browser own when it gives one out', () => {
    const own = { getItem: () => 'x', setItem: () => undefined };
    vi.stubGlobal('window', { localStorage: own });
    expect(browserStorage()).toBe(own);
  });
});
