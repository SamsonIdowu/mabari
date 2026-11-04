import type { ThemeName } from '@mabari/shared/tokens';
import { create } from 'zustand';
import { resolveInitialTheme } from './resolveInitialTheme.ts';

const STORAGE_KEY = 'mabari.theme';

/** Storage can be blocked or unavailable; the theme still works, it just isn't remembered. */
function readSavedTheme(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveTheme(theme: ThemeName): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Nothing to do: the choice lasts until the page reloads.
  }
}

function applyTheme(theme: ThemeName): void {
  document.documentElement.setAttribute('data-theme', theme);
}

interface ThemeState {
  theme: ThemeName;
  toggle: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => {
  const theme = resolveInitialTheme(readSavedTheme());
  applyTheme(theme);
  return {
    theme,
    toggle: () => {
      const next = get().theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      saveTheme(next);
      set({ theme: next });
    },
  };
});
