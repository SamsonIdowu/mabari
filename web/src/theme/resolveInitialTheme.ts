// SPDX-License-Identifier: Apache-2.0
import type { ThemeName } from '../shared/tokens.ts';

/** A saved choice wins. Otherwise Mabari starts dark, as the prototype does. */
export function resolveInitialTheme(saved: string | null): ThemeName {
  return saved === 'light' || saved === 'dark' ? saved : 'dark';
}
