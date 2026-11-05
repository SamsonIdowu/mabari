// SPDX-License-Identifier: Apache-2.0

/** How long items may wait for a frame that never comes, as in a tab nobody is looking at. */
const MAX_WAIT_MS = 100;

export interface FrameBatch<T> {
  /** Holds an item for the next frame. */
  add: (item: T) => void;
  /** Hands over whatever is held now, without waiting for the frame. */
  flush: () => void;
  /** Drops whatever is held, and stops waiting. */
  discard: () => void;
}

/**
 * Collects items and hands them over together, once per animation frame.
 *
 * The office can send thousands of changes a second. Applying each one on its own costs the page
 * a full render apiece, and a page that renders once per message has no time left to draw: a few
 * thousand messages keep the main thread busy for seconds and the browser draws about ten frames
 * a second. Applying a frame's worth together costs one render, whatever the count. Order is kept.
 * A timer hands the items over too, because a hidden tab runs no animation frames.
 */
export function frameBatch<T>(handle: (items: T[]) => void): FrameBatch<T> {
  let held: T[] = [];
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stopWaiting = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    clearTimeout(timer);
    frame = undefined;
    timer = undefined;
  };

  const flush = () => {
    stopWaiting();
    if (held.length === 0) return;
    const items = held;
    held = [];
    handle(items);
  };

  return {
    add: (item) => {
      held.push(item);
      if (frame !== undefined) return;
      frame = requestAnimationFrame(flush);
      timer = setTimeout(flush, MAX_WAIT_MS);
    },
    flush,
    discard: () => {
      stopWaiting();
      held = [];
    },
  };
}

/** What a person does to the page, from the first touch to the last. */
const INPUT_EVENTS = [
  'keydown',
  'keyup',
  'pointerdown',
  'pointerup',
  'click',
  'input',
  'submit',
] as const;

/**
 * Hands over what a batch holds before the page reacts to the person. The screen may be a frame
 * behind the changes that arrived, but a key press or a click never acts on an office that is a
 * frame behind: it reads what has already been received. Returns how to stop.
 */
export function flushBeforeInput(
  batch: Pick<FrameBatch<unknown>, 'flush'>,
  target: EventTarget = window,
): () => void {
  const flush = () => batch.flush();
  for (const type of INPUT_EVENTS) {
    target.addEventListener(type, flush, { capture: true, passive: true });
  }
  return () => {
    for (const type of INPUT_EVENTS) target.removeEventListener(type, flush, { capture: true });
  };
}
