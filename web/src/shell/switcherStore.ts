// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';

interface SwitcherState {
  open: boolean;
  show: () => void;
  hide: () => void;
}

/** Whether the quick switcher is open. Ctrl K, Command K and the button in the top bar all use it. */
export const useSwitcher = create<SwitcherState>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));
