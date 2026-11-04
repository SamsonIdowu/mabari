// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { resolveInitialTheme } from './resolveInitialTheme.ts';

describe('resolveInitialTheme', () => {
  it('follows the computer when nothing is saved', () => {
    expect(resolveInitialTheme(null, true)).toBe('light');
    expect(resolveInitialTheme(null, false)).toBe('dark');
  });

  it('prefers a saved choice over the computer', () => {
    expect(resolveInitialTheme('light', false)).toBe('light');
    expect(resolveInitialTheme('dark', true)).toBe('dark');
  });

  it('ignores anything else', () => {
    expect(resolveInitialTheme('purple', true)).toBe('light');
  });
});
