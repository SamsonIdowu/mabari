// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { wrapTarget } from './modalStack.ts';

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
