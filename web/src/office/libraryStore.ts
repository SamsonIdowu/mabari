// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';

export type LibraryTab = 'states' | 'components';

/** The Library's open tab. Status screens comes first; old #states links open it too. */
export const useLibrary = create<{ tab: LibraryTab; set: (tab: LibraryTab) => void }>((set) => ({
  tab: 'states',
  set: (tab) => set({ tab }),
}));
