// SPDX-License-Identifier: Apache-2.0
import type { ThemeName } from '../shared/tokens.ts';

/** A saved choice wins. Otherwise Mabari opens in light mode. */
export function resolveInitialTheme(saved: string | null): ThemeName {
  return saved === 'dark' ? 'dark' : 'light';
}
