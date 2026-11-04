// SPDX-License-Identifier: Apache-2.0
import type { ThemeName } from '../shared/tokens.ts';

/** A saved choice wins. Otherwise Mabari follows the computer's setting. */
export function resolveInitialTheme(saved: string | null, systemPrefersLight: boolean): ThemeName {
  if (saved === 'light' || saved === 'dark') return saved;
  return systemPrefersLight ? 'light' : 'dark';
}
