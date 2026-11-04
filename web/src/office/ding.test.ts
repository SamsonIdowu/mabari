// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOfficeStore } from '../data/officeStore.ts';
import type { LiveAgent, Snapshot } from '../gen/models.ts';
import { approvalArrived, listenForApprovals, playDing } from './ding.ts';

const agent = (id: string, state: string) => ({ id, state }) as unknown as LiveAgent;

function office(agents: LiveAgent[], approvalSound = true) {
  return { agents, settings: { approvalSound } } as unknown as Snapshot;
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
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
  }
}

const waiting = (id: string, approvalId: string) =>
  ({ id, state: 'approval', approval: { id: approvalId } }) as unknown as LiveAgent;

describe('approvalArrived', () => {
  it('sees an agent start waiting for an approval', () => {
    expect(approvalArrived([agent('a', 'editing')], [waiting('a', 'p1')])).toBe(true);
  });

  it('sees a second approval from the same agent', () => {
    expect(approvalArrived([waiting('a', 'p1')], [waiting('a', 'p2')])).toBe(true);
  });

  it('ignores the same approval, finished tasks, and agents that only just arrived', () => {
    expect(approvalArrived([waiting('a', 'p1')], [waiting('a', 'p1')])).toBe(false);
    expect(approvalArrived([agent('a', 'editing')], [agent('a', 'done')])).toBe(false);
    expect(approvalArrived([], [waiting('a', 'p1')])).toBe(false);
  });
});

describe('the approval sound', () => {
  let stop: () => void;
  const set = (snapshot: Snapshot) => useOfficeStore.setState({ office: snapshot });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(60_000);
    notes = 0;
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('document', new EventTarget());
    stop = listenForApprovals();
    document.dispatchEvent(new Event('pointerdown'));
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('plays once when an approval needs you, and not when a task finishes', () => {
    set(office([agent('a', 'editing')]));
    set(office([agent('a', 'done')]));
    expect(notes).toBe(0);
    set(office([agent('a', 'editing')]));
    set(office([waiting('a', 'p1')]));
    expect(notes).toBe(4);
    set(office([waiting('a', 'p1')]));
    expect(notes).toBe(4);
  });

  it('stays quiet when the setting is off', () => {
    set(office([agent('a', 'editing')], false));
    set(office([waiting('a', 'p1')], false));
    expect(notes).toBe(0);
  });

  it('does not ring for a first snapshot full of waiting agents', () => {
    useOfficeStore.setState({ office: null });
    set(office([waiting('a', 'p1'), waiting('b', 'p2')]));
    expect(notes).toBe(0);
  });

  it('plays at most once every 0.9 seconds', () => {
    vi.advanceTimersByTime(2000); // past the last test's ding
    playDing();
    playDing();
    expect(notes).toBe(4);
    vi.advanceTimersByTime(901);
    playDing();
    expect(notes).toBe(8);
  });
});
