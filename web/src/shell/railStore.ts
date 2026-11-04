// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';

const STORAGE_KEY = 'mabari-rail';
const NARROW_WIDTH = 1180;

/** A saved choice wins. Otherwise narrow screens start collapsed. */
export function resolveRailCollapsed(saved: string | null, width: number): boolean {
  return saved ? saved === 'closed' : width < NARROW_WIDTH;
}

function readSaved(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function save(collapsed: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, collapsed ? 'closed' : 'open');
  } catch {
    // Nothing to do: the choice lasts until the page reloads.
  }
}

interface RailState {
  collapsed: boolean;
  toggle: () => void;
}

export const useRailStore = create<RailState>((set, get) => ({
  collapsed: resolveRailCollapsed(readSaved(), window.innerWidth),
  toggle: () => {
    const collapsed = !get().collapsed;
    save(collapsed);
    set({ collapsed });
  },
}));
