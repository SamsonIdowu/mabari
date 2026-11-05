// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { escapeIsFor, wrapTarget } from './modalStack.ts';

describe('wrapTarget', () => {
  it('sends Tab from the last stop round to the first', () => {
    expect(wrapTarget(3, 4, false)).toBe(0);
    expect(wrapTarget(0, 1, false)).toBe(0);
  });

  it('sends Shift+Tab from the first stop round to the last', () => {
    expect(wrapTarget(0, 4, true)).toBe(3);
    expect(wrapTarget(0, 1, true)).toBe(0);
  });

  it('sends Shift+Tab from the dialog itself, which is no stop, to the last stop', () => {
    expect(wrapTarget(-1, 4, true)).toBe(3);
  });

  it('leaves every other move to the browser', () => {
    expect(wrapTarget(1, 4, false)).toBeNull();
    expect(wrapTarget(-1, 4, false)).toBeNull();
    expect(wrapTarget(2, 4, true)).toBeNull();
  });

  it('has nowhere to go with no stops', () => {
    expect(wrapTarget(-1, 0, false)).toBeNull();
    expect(wrapTarget(-1, 0, true)).toBeNull();
  });
});

// REV-5: Escape belongs to the layer on top. Which dialogs a layer was shown over is what counts.
describe('escapeIsFor', () => {
  const [a, b, c] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('is for a layer shown over nothing when no dialog is open, and for one shown over the top dialog', () => {
    expect(escapeIsFor(new Set(), [])).toBe(true);
    expect(escapeIsFor(new Set([a]), [a])).toBe(true);
    expect(escapeIsFor(new Set([a, b]), [a, b])).toBe(true);
  });

  it('is not for a layer with a dialog it was not shown over on top', () => {
    expect(escapeIsFor(new Set([a]), [a, b])).toBe(false);
    expect(escapeIsFor(new Set(), [a])).toBe(false);
  });

  it('is for a layer again once the dialog over it closes', () => {
    expect(escapeIsFor(new Set([a]), [a])).toBe(true);
  });

  it('is only for the top one after a lower dialog closes and another opens', () => {
    // a opened, b over it (shown over a, b), then a closed and c opened: two are open, as when b
    // was shown, and counting them would let Escape close b and c together.
    const shownB = new Set([a, b]);
    const shownC = new Set([b, c]);
    const open = [b, c];
    expect(open).toHaveLength(2);
    expect(escapeIsFor(shownB, open)).toBe(false);
    expect(escapeIsFor(shownC, open)).toBe(true);
  });
});
