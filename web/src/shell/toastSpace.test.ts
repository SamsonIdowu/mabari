// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { clearOfPanel, repeatsOpenPanel } from './toastSpace.ts';

describe('clearOfPanel', () => {
  const wide = { width: 1440, height: 900 };

  it('leaves toasts where they are when no panel is open', () => {
    expect(clearOfPanel(null, wide)).toEqual({});
  });

  it("moves them to the panel's left when there is room", () => {
    // The panel starts at x=1088, so the toasts end 16px before it.
    expect(clearOfPanel({ panelLeft: 1088, panelTop: 48, composerTop: 780 }, wide)).toEqual({
      right: 1440 - 1088 + 16,
    });
  });

  it('lifts them above the message box when the panel fills the window', () => {
    const narrow = { width: 390, height: 844 };
    expect(clearOfPanel({ panelLeft: 38, panelTop: 0, composerTop: 700 }, narrow)).toEqual({
      bottom: 844 - 700 + 16,
    });
  });

  it('lifts them above the panel when it has no message box', () => {
    const narrow = { width: 390, height: 844 };
    expect(clearOfPanel({ panelLeft: 38, panelTop: 0, composerTop: null }, narrow)).toEqual({
      bottom: 844 + 16,
    });
  });
});

describe('repeatsOpenPanel', () => {
  it("drops an agent's reply toast while that agent's panel is open", () => {
    expect(repeatsOpenPanel('Bolt replied. Open Bolt to read it.', 'Bolt')).toBe(true);
  });

  it("keeps it for another agent's panel, or with no panel open", () => {
    expect(repeatsOpenPanel('Bolt replied. Open Bolt to read it.', 'Sage')).toBe(false);
    expect(repeatsOpenPanel('Bolt replied. Open Bolt to read it.', null)).toBe(false);
  });

  it('keeps the confirmation that something was sent', () => {
    expect(repeatsOpenPanel('Sent to Bolt', 'Bolt')).toBe(false);
  });
});
