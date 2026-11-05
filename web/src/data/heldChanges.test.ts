// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { applyHeldChanges, holdChangesWith } from './heldChanges.ts';

describe('held changes', () => {
  it('applies what is held, when asked', () => {
    const apply = vi.fn();
    const release = holdChangesWith(apply);
    applyHeldChanges();
    expect(apply).toHaveBeenCalledTimes(1);
    release();
  });

  it('does nothing before the office is listening, and after it stops', () => {
    expect(() => applyHeldChanges()).not.toThrow();
    const apply = vi.fn();
    holdChangesWith(apply)();
    applyHeldChanges();
    expect(apply).not.toHaveBeenCalled();
  });

  it('keeps the newer registration when an older one lets go late', () => {
    const first = vi.fn();
    const second = vi.fn();
    const releaseFirst = holdChangesWith(first);
    const releaseSecond = holdChangesWith(second);
    releaseFirst();
    applyHeldChanges();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    releaseSecond();
  });
});
