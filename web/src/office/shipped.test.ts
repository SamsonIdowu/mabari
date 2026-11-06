// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { Project } from '../gen/models.ts';
import {
  completed,
  EXPIRES_MS,
  GATHER_MAX_MS,
  initialShipped,
  loadSeen,
  newlyCompleted,
  PARTY_MS,
  saveSeen,
  shipmentKey,
  step,
  watching,
  type Frame,
  type Shipment,
  type ShippedState,
} from './shipped.ts';

const ship = (id: string, heardAt = 0): Shipment => ({
  key: `${id}:1`,
  id,
  name: id,
  color: '#FF6B9A',
  heardAt,
});

const frame = (over: Partial<Frame> = {}): Frame => ({
  arrived: false,
  approval: false,
  calm: false,
  ...over,
});

const none = new Set<string>();
/** A state with the office on screen and one completion waiting. */
const waiting = (): ShippedState => watching(completed(initialShipped, ship('a'), none), true);

describe('a completion', () => {
  it('waits in the queue, once, until it is played', () => {
    const once = completed(initialShipped, ship('a'), none);
    expect(completed(once, ship('a'), none).queue).toHaveLength(1);
    expect(completed(once, ship('b'), none).queue).toHaveLength(2);
  });

  it('is not queued again once it has been celebrated, which is what a reload relies on', () => {
    expect(completed(initialShipped, ship('a'), new Set(['a:1'])).queue).toEqual([]);
  });

  it('is a new one when the project is reopened and completed again', () => {
    expect(shipmentKey({ id: 'a', done: { at: 10 } })).not.toBe(
      shipmentKey({ id: 'a', done: { at: 99 } }),
    );
  });
});

describe('the celebration', () => {
  it('walks, then holds the party, then ends, in that order and once', () => {
    let state = waiting();
    state = step(state, 1000, frame());
    expect(state.phase).toBe('gather');
    expect(state.current?.id).toBe('a');
    expect(state.queue).toEqual([]);
    // Still walking.
    expect(step(state, 3000, frame()).phase).toBe('gather');
    state = step(state, 5000, frame({ arrived: true }));
    expect(state.phase).toBe('party');
    expect(state.last).toEqual({ id: 'a', at: 5000 });
    expect(step(state, 5000 + PARTY_MS - 1, frame()).phase).toBe('party');
    state = step(state, 5000 + PARTY_MS + 1, frame());
    expect(state.phase).toBe('idle');
    expect(state.current).toBeNull();
    // Nothing is left to play, so it stays over.
    expect(step(state, 99_000, frame())).toBe(state);
  });

  it('does not let one agent stuck on the way hold up the party for ever', () => {
    let state = step(waiting(), 0, frame());
    expect(step(state, GATHER_MAX_MS - 1, frame()).phase).toBe('gather');
    state = step(state, GATHER_MAX_MS + 1, frame());
    expect(state.phase).toBe('party');
  });

  it('plays the next completion after the first, one at a time', () => {
    let state = waiting();
    state = completed(state, ship('b'), none);
    state = step(state, 0, frame());
    expect(state.current?.id).toBe('a');
    state = step(state, 100, frame({ arrived: true }));
    state = step(state, 100 + PARTY_MS + 1, frame());
    expect(state.phase).toBe('idle');
    state = step(state, 100 + PARTY_MS + 2, frame());
    expect(state.current?.id).toBe('b');
  });

  it('waits for the office to be on screen, and gives up rather than play late', () => {
    const off = completed(initialShipped, ship('a', 0), none);
    expect(step(off, 1000, frame()).phase).toBe('idle');
    expect(step(off, 1000, frame()).queue).toHaveLength(1);
    // Arriving in time starts it.
    expect(step(watching(off, true), 1000, frame()).phase).toBe('gather');
    // Arriving too late finds it gone.
    const late = step(watching(off, true), EXPIRES_MS + 1, frame());
    expect(late.phase).toBe('idle');
    expect(late.queue).toEqual([]);
  });

  it('stops when the office goes off screen', () => {
    const going = step(waiting(), 0, frame());
    expect(watching(going, false).phase).toBe('idle');
    expect(watching(going, false).current).toBeNull();
  });
});

describe('an approval waiting on you', () => {
  it('stops a celebration under way, at once', () => {
    let state = step(waiting(), 0, frame());
    expect(step(state, 100, frame({ approval: true })).phase).toBe('idle');
    state = step(state, 100, frame({ arrived: true }));
    expect(state.phase).toBe('party');
    expect(step(state, 200, frame({ approval: true })).phase).toBe('idle');
  });

  it('keeps a celebration from starting, and lets it start once nothing waits', () => {
    const state = waiting();
    expect(step(state, 0, frame({ approval: true })).phase).toBe('idle');
    expect(step(state, 0, frame({ approval: true })).queue).toHaveLength(1);
    expect(step(state, 50, frame()).phase).toBe('gather');
  });
});

describe('reduced motion', () => {
  it('goes straight to the party, with no walk, and the party is the still banner', () => {
    const state = step(waiting(), 0, frame({ calm: true }));
    expect(state.phase).toBe('party');
    expect(state.last).toEqual({ id: 'a', at: 0 });
    expect(step(state, PARTY_MS + 1, frame({ calm: true })).phase).toBe('idle');
  });
});

describe('which projects were just completed', () => {
  const project = (id: string, at: number | null): Project =>
    ({ id, name: id, color: '#fff', done: at === null ? null : { at } }) as unknown as Project;

  it('hears of a project that was open and is now done', () => {
    const found = newlyCompleted(
      [project('a', null), project('b', null)],
      [project('a', 5), project('b', null)],
    );
    expect(found.map((item) => item.id)).toEqual(['a']);
  });

  it('hears of nothing on the first office a page sees, which is what a reload is', () => {
    expect(newlyCompleted(undefined, [project('a', 5)])).toEqual([]);
  });

  it('does not hear of a project that was already done, or one that is new', () => {
    expect(newlyCompleted([project('a', 5)], [project('a', 5)])).toEqual([]);
    expect(newlyCompleted([], [project('a', 5)])).toEqual([]);
  });
});

describe('what has been celebrated, kept in storage', () => {
  const memory = (initial?: string) => {
    let value = initial;
    return {
      getItem: () => value ?? null,
      setItem: (_: string, next: string) => {
        value = next;
      },
    };
  };

  it('is remembered, so a reload does not play it again', () => {
    const storage = memory();
    saveSeen(storage, new Set(['a:1', 'b:2']));
    expect([...loadSeen(storage)]).toEqual(['a:1', 'b:2']);
  });

  it('survives storage that is missing, broken or holds something else', () => {
    expect(loadSeen(undefined).size).toBe(0);
    expect(loadSeen(memory('not json')).size).toBe(0);
    expect(loadSeen(memory('{"a":1}')).size).toBe(0);
    expect([...loadSeen(memory('["a:1", 5, null]'))]).toEqual(['a:1']);
    expect(() => saveSeen(undefined, new Set(['a']))).not.toThrow();
  });

  it('keeps only the latest few hundred', () => {
    const storage = memory();
    saveSeen(storage, new Set(Array.from({ length: 500 }, (_, index) => `k${index}`)));
    const kept = loadSeen(storage);
    expect(kept.size).toBe(200);
    expect(kept.has('k499')).toBe(true);
    expect(kept.has('k0')).toBe(false);
  });
});
