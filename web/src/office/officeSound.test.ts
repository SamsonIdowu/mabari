// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOfficeStore } from '../data/officeStore.ts';
import type { Snapshot } from '../gen/models.ts';
import {
  DEFAULT_SOUND,
  masterGain,
  playChime,
  readSound,
  roomLevel,
  startOfficeSound,
  tapRate,
  useOfficeSound,
  workingCount,
} from './officeSound.ts';

describe('how the office sounds', () => {
  it('is silent with nobody working, and gets fuller with more at work', () => {
    expect(roomLevel(0)).toBe(0);
    expect(tapRate(0)).toBe(0);
    let level = 0;
    let rate = 0;
    for (let working = 1; working <= 6; working++) {
      expect(roomLevel(working)).toBeGreaterThan(level);
      expect(tapRate(working)).toBeGreaterThan(rate);
      level = roomLevel(working);
      rate = tapRate(working);
    }
  });

  it('levels off on a busy floor, so 16 agents are not deafening', () => {
    expect(roomLevel(16)).toBe(1);
    expect(roomLevel(40)).toBe(1);
    expect(tapRate(16)).toBeLessThanOrEqual(9);
    expect(tapRate(40)).toBeLessThanOrEqual(9);
  });

  it('keeps the loudest of it quiet, and the low end of the slider quieter still', () => {
    expect(masterGain(0)).toBe(0);
    expect(masterGain(1)).toBeLessThanOrEqual(0.35);
    expect(masterGain(0.5)).toBeLessThan(masterGain(1) / 2);
  });

  it('counts the agents the server says are working, not those waiting on you', () => {
    expect(workingCount([{ working: true }, { working: false }, { working: true }])).toBe(2);
    expect(workingCount([])).toBe(0);
  });
});

describe('the saved choice', () => {
  it('is off, at half volume, when nothing is saved or what is saved is wrong', () => {
    expect(DEFAULT_SOUND).toEqual({ on: false, volume: 0.5 });
    expect(readSound(null)).toEqual(DEFAULT_SOUND);
    expect(readSound('nonsense')).toEqual(DEFAULT_SOUND);
    expect(readSound('{"on":"yes"}').on).toBe(false);
    expect(readSound('{"on":true,"volume":9}')).toEqual({ on: true, volume: 1 });
    expect(readSound('{"on":true,"volume":-3}').volume).toBe(0);
    expect(readSound('{"on":true,"volume":"loud"}').volume).toBe(0.5);
  });
});

/** A stand in for Web Audio that counts what is made and started. */
const made = { sources: 0, oscillators: 0, stopped: 0, resumed: 0, suspended: 0 };

class FakeParam {
  value = 0;
  targets: number[] = [];
  setTargetAtTime = vi.fn((target: number) => this.targets.push(target));
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
}

class FakeNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  Q = new FakeParam();
  type = '';
  buffer: unknown = null;
  loop = false;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn(() => {
    made.sources += 1;
  });
  stop = vi.fn(() => {
    made.stopped += 1;
  });
}

class FakeAudio {
  state = 'running';
  currentTime = 0;
  sampleRate = 1000;
  destination = {};
  resume = vi.fn(async () => {
    made.resumed += 1;
  });
  suspend = vi.fn(async () => {
    made.suspended += 1;
  });
  createBuffer = (_channels: number, length: number) => ({
    getChannelData: () => new Float32Array(length),
  });
  createGain = () => new FakeNode();
  createBiquadFilter = () => new FakeNode();
  createBufferSource = () => new FakeNode();
  createOscillator = () => {
    made.oscillators += 1;
    return new FakeNode();
  };
}

const office = (working: number) =>
  ({
    agents: Array.from({ length: 3 }, (_, index) => ({ working: index < working })),
  }) as unknown as Snapshot;

describe('the room', () => {
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(made, { sources: 0, oscillators: 0, stopped: 0, resumed: 0, suspended: 0 });
    vi.stubGlobal('AudioContext', FakeAudio);
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    useOfficeSound.setState({ on: false, volume: 0.5 });
    useOfficeStore.setState({ office: office(0) });
  });

  afterEach(() => {
    stop?.();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('makes no sound at all while it is off, and builds nothing', () => {
    stop = startOfficeSound();
    useOfficeStore.setState({ office: office(3) });
    vi.advanceTimersByTime(5000);
    expect(made.sources).toBe(0);
  });

  it('types while agents work, and falls silent when they stop', () => {
    stop = startOfficeSound();
    useOfficeSound.getState().setOn(true);
    // The room tone is one looping source. With nobody working there are no keys.
    expect(made.sources).toBe(1);
    vi.advanceTimersByTime(5000);
    expect(made.sources).toBe(1);
    useOfficeStore.setState({ office: office(3) });
    vi.advanceTimersByTime(3000);
    const typing = made.sources;
    expect(typing).toBeGreaterThan(3);
    // Everyone stops: the keys stop at once and the room tone eases to nothing.
    useOfficeStore.setState({ office: office(0) });
    vi.advanceTimersByTime(300);
    const after = made.sources;
    vi.advanceTimersByTime(5000);
    expect(made.sources).toBe(after);
  });

  it('types faster for a busier office', () => {
    stop = startOfficeSound();
    useOfficeSound.getState().setOn(true);
    const keysIn = (working: number) => {
      useOfficeStore.setState({ office: office(working) });
      // Let the room settle on the new level, then count a stretch of typing.
      vi.advanceTimersByTime(1000);
      const before = made.sources;
      vi.advanceTimersByTime(20_000);
      return made.sources - before;
    };
    const one = keysIn(1);
    const three = keysIn(3);
    expect(one).toBeGreaterThan(5);
    expect(three).toBeGreaterThan(one);
  });

  it('is stopped for good by turning it off', () => {
    stop = startOfficeSound();
    useOfficeSound.getState().setOn(true);
    useOfficeStore.setState({ office: office(2) });
    vi.advanceTimersByTime(2000);
    useOfficeSound.getState().setOn(false);
    const after = made.sources;
    vi.advanceTimersByTime(8000);
    expect(made.sources).toBe(after);
    expect(made.suspended).toBeGreaterThan(0);
  });

  it('rests while the page is hidden', () => {
    stop = startOfficeSound();
    useOfficeSound.getState().setOn(true);
    const before = made.suspended;
    Object.assign(document, { visibilityState: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(made.suspended).toBe(before + 1);
  });
});

describe('the chime', () => {
  beforeEach(() => {
    vi.stubGlobal('AudioContext', FakeAudio);
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    made.oscillators = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('plays three notes when the sound is on, and none when it is off', () => {
    useOfficeSound.setState({ on: false, volume: 0.5 });
    const stop = startOfficeSound();
    playChime();
    expect(made.oscillators).toBe(0);
    useOfficeSound.getState().setOn(true);
    playChime();
    expect(made.oscillators).toBe(3);
    useOfficeSound.getState().setOn(false);
    stop();
  });
});
