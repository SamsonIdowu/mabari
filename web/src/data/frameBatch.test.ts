// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { frameBatch } from './frameBatch.ts';

const FRAME_MS = 16;

/** Frames that arrive on the fake clock, as in a visible tab. */
function withFrames() {
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => setTimeout(run, FRAME_MS));
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
}

/** A tab nobody is looking at: frames are asked for and never come. */
function withoutFrames() {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('frameBatch', () => {
  it('hands a frame of items over together, in the order they came', () => {
    withFrames();
    const handle = vi.fn();
    const batch = frameBatch<number>(handle);
    for (let n = 0; n < 5000; n++) batch.add(n);
    expect(handle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FRAME_MS);
    expect(handle).toHaveBeenCalledTimes(1);
    const items = handle.mock.calls[0]![0] as number[];
    expect(items).toHaveLength(5000);
    expect(items.every((item, index) => item === index)).toBe(true);
    // Nothing is handed over twice, and no frame is left waiting.
    vi.advanceTimersByTime(1000);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts a new batch for what comes after a frame', () => {
    withFrames();
    const handle = vi.fn();
    const batch = frameBatch<string>(handle);
    batch.add('a');
    vi.advanceTimersByTime(FRAME_MS);
    batch.add('b');
    batch.add('c');
    vi.advanceTimersByTime(FRAME_MS);
    expect(handle.mock.calls).toEqual([[['a']], [['b', 'c']]]);
  });

  it('still hands items over when no frame comes, as in a hidden tab', () => {
    withoutFrames();
    const handle = vi.fn();
    const batch = frameBatch<string>(handle);
    batch.add('a');
    batch.add('b');
    vi.advanceTimersByTime(99);
    expect(handle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(handle).toHaveBeenCalledWith(['a', 'b']);
  });

  it('flush hands items over at once, and the frame it cancelled hands over nothing more', () => {
    withFrames();
    const handle = vi.fn();
    const batch = frameBatch<string>(handle);
    batch.add('a');
    batch.flush();
    expect(handle).toHaveBeenCalledWith(['a']);
    vi.advanceTimersByTime(1000);
    expect(handle).toHaveBeenCalledTimes(1);
    // Flushing with nothing held does nothing.
    batch.flush();
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('discard drops what is held, and waits for nothing', () => {
    withFrames();
    const handle = vi.fn();
    const batch = frameBatch<string>(handle);
    batch.add('a');
    batch.discard();
    vi.advanceTimersByTime(1000);
    expect(handle).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    // It works again afterwards.
    batch.add('b');
    vi.advanceTimersByTime(FRAME_MS);
    expect(handle).toHaveBeenCalledWith(['b']);
  });
});
