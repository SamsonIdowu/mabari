// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOfficeStore } from '../data/officeStore.ts';
import type { LiveAgent, Snapshot } from '../gen/models.ts';
import { listenForCompletions, playDing, someoneFinished } from './ding.ts';

const agent = (id: string, state: string) => ({ id, state }) as unknown as LiveAgent;

function office(agents: LiveAgent[], completionSound = true) {
  return { agents, settings: { completionSound } } as unknown as Snapshot;
}

let notes = 0;

class FakeAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  resume = vi.fn();
  createOscillator() {
    return {
      type: '',
      frequency: { value: 0 },
      connect: vi.fn(),
      start: () => (notes += 1),
      stop: vi.fn(),
    };
  }
  createGain() {
    return {
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    };
  }
}

describe('someoneFinished', () => {
  it('sees an agent move to done', () => {
    expect(someoneFinished([agent('a', 'editing')], [agent('a', 'done')])).toBe(true);
  });

  it('ignores agents that were already done or have only just arrived', () => {
    expect(someoneFinished([agent('a', 'done')], [agent('a', 'done')])).toBe(false);
    expect(someoneFinished([], [agent('a', 'done')])).toBe(false);
    expect(someoneFinished([agent('a', 'done')], [agent('a', 'idle')])).toBe(false);
  });
});

describe('the completion sound', () => {
  let stop: () => void;
  const set = (snapshot: Snapshot) => useOfficeStore.setState({ office: snapshot });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(60_000);
    notes = 0;
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('document', new EventTarget());
    stop = listenForCompletions();
    document.dispatchEvent(new Event('pointerdown'));
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('plays two notes once when a task finishes', () => {
    set(office([agent('a', 'editing')]));
    set(office([agent('a', 'done')]));
    expect(notes).toBe(2);
    set(office([agent('a', 'done')]));
    expect(notes).toBe(2);
  });

  it('stays quiet when the setting is off', () => {
    vi.advanceTimersByTime(2000);
    set(office([agent('a', 'editing')], false));
    set(office([agent('a', 'done')], false));
    expect(notes).toBe(0);
  });

  it('does not ring for a first snapshot full of finished agents', () => {
    vi.advanceTimersByTime(2000);
    useOfficeStore.setState({ office: null });
    set(office([agent('a', 'done'), agent('b', 'done')]));
    expect(notes).toBe(0);
  });

  it('plays at most once a second', () => {
    vi.advanceTimersByTime(2000);
    playDing();
    playDing();
    expect(notes).toBe(2);
    vi.advanceTimersByTime(1001);
    playDing();
    expect(notes).toBe(4);
  });
});
