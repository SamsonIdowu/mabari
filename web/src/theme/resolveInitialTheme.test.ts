// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { resolveInitialTheme } from './resolveInitialTheme.ts';

describe('resolveInitialTheme', () => {
  it('starts dark when nothing is saved', () => {
    expect(resolveInitialTheme(null)).toBe('dark');
  });

  it('uses a saved choice', () => {
    expect(resolveInitialTheme('light')).toBe('light');
    expect(resolveInitialTheme('dark')).toBe('dark');
  });

  it('ignores anything else', () => {
    expect(resolveInitialTheme('purple')).toBe('dark');
  });
});
