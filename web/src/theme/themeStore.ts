// SPDX-License-Identifier: Apache-2.0
import type { ThemeName } from '../shared/tokens.ts';
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

const lightQuery = window.matchMedia('(prefers-color-scheme: light)');

export const useThemeStore = create<ThemeState>((set, get) => {
  const theme = resolveInitialTheme(readSavedTheme(), lightQuery.matches);
  applyTheme(theme);
  // Until someone picks a theme, Mabari keeps following the computer.
  lightQuery.addEventListener('change', (event) => {
    if (readSavedTheme()) return;
    const next = event.matches ? 'light' : 'dark';
    applyTheme(next);
    set({ theme: next });
  });
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
