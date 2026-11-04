import type { ThemeName } from '@mabari/shared/tokens';

/** A saved choice wins. Otherwise Mabari starts dark, as the prototype does. */
export function resolveInitialTheme(saved: string | null): ThemeName {
  return saved === 'light' || saved === 'dark' ? saved : 'dark';
}
