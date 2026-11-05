// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { sidewaysOf, wheelUse, type WheelLike } from './wheel.ts';

const wheel = (overrides: Partial<WheelLike> = {}): WheelLike => ({
  deltaX: 0,
  deltaY: 0,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  ...overrides,
});

describe('what the wheel does over the floor', () => {
  it('zooms with a plain wheel when the page has nothing to scroll, as before', () => {
    expect(wheelUse(wheel({ deltaY: -100 }), false)).toBe('zoom');
    expect(wheelUse(wheel({ deltaY: 100 }), false)).toBe('zoom');
  });

  it('leaves a plain wheel to the page when the page can scroll', () => {
    expect(wheelUse(wheel({ deltaY: 100 }), true)).toBe('scroll');
    expect(wheelUse(wheel({ deltaY: -100 }), true)).toBe('scroll');
  });

  it('zooms with Ctrl or Command held, which is how a pinch arrives, even when the page scrolls', () => {
    expect(wheelUse(wheel({ deltaY: -100, ctrlKey: true }), true)).toBe('zoom');
    expect(wheelUse(wheel({ deltaY: 100, metaKey: true }), true)).toBe('zoom');
    expect(wheelUse(wheel({ deltaY: -100, ctrlKey: true }), false)).toBe('zoom');
  });

  it('moves along a wide office for a sideways wheel, or Shift with the wheel, either way', () => {
    expect(wheelUse(wheel({ deltaX: 60, deltaY: 5 }), true)).toBe('pan');
    expect(wheelUse(wheel({ deltaX: 60, deltaY: 5 }), false)).toBe('pan');
    expect(wheelUse(wheel({ deltaY: 100, shiftKey: true }), true)).toBe('pan');
    expect(wheelUse(wheel({ deltaY: 100, shiftKey: true }), false)).toBe('pan');
    expect(sidewaysOf(wheel({ deltaY: 100, shiftKey: true }))).toBe(100);
    expect(sidewaysOf(wheel({ deltaX: 30, deltaY: 100 }))).toBe(30);
  });

  it('does nothing to a wheel that moved nowhere', () => {
    expect(wheelUse(wheel(), true)).toBe('scroll');
  });
});
