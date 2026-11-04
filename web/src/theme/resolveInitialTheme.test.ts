// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { resolveInitialTheme } from './resolveInitialTheme.ts';

describe('resolveInitialTheme', () => {
  it('opens in light mode when nothing is saved', () => {
    expect(resolveInitialTheme(null)).toBe('light');
  });

  it('keeps a saved choice', () => {
    expect(resolveInitialTheme('light')).toBe('light');
    expect(resolveInitialTheme('dark')).toBe('dark');
  });

  it('ignores anything else', () => {
    expect(resolveInitialTheme('purple')).toBe('light');
  });
});
