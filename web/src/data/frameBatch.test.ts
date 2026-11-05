// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushBeforeInput, frameBatch } from './frameBatch.ts';

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

describe('flushBeforeInput', () => {
  it('hands over what is held when the person presses a key or clicks, before the page reacts', () => {
    withFrames();
    const handle = vi.fn();
    const batch = frameBatch<string>(handle);
    const page = new EventTarget();
    const stop = flushBeforeInput(batch, page);
    // The page's own handler comes after the one that hands the changes over.
    const reacted: number[] = [];
    page.addEventListener('keydown', () => reacted.push(handle.mock.calls.length));
    batch.add('a');
    page.dispatchEvent(new Event('keydown'));
    expect(handle).toHaveBeenCalledWith(['a']);
    batch.add('b');
    page.dispatchEvent(new Event('click'));
    expect(handle).toHaveBeenLastCalledWith(['b']);
    // By the time the page's handler ran, 'a' was applied.
    expect(reacted).toEqual([1]);
    stop();
    batch.add('c');
    page.dispatchEvent(new Event('keydown'));
    expect(handle).toHaveBeenCalledTimes(2);
  });
});
