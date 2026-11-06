// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';

/** A folder that brings code of its own, which runs in any session started there. */
export interface FolderTrust {
  folder: string;
  found: string[];
}

interface TrustState {
  asking: (FolderTrust & { answer: (trusted: boolean) => void }) | null;
  /** Shows the question, and settles when the person has answered it. */
  ask: (trust: FolderTrust) => Promise<boolean>;
  answer: (trusted: boolean) => void;
}

/**
 * Starting a session with no terminal skips Claude Code's own trust dialog, so Mabari asks instead.
 * The API refuses with what the folder brings, and request() brings it here, so every way of
 * starting a session gets the same question without knowing about it.
 */
export const useTrust = create<TrustState>((set, get) => ({
  asking: null,
  ask: (trust) =>
    new Promise((resolve) => {
      // Anyone already waiting gets no: one question at a time, and it was not this one.
      get().asking?.answer(false);
      set({ asking: { ...trust, answer: resolve } });
    }),
  answer: (trusted) => {
    get().asking?.answer(trusted);
    set({ asking: null });
  },
}));
