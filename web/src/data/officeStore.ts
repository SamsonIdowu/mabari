// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';
import type { ServerMessage, Snapshot } from '../gen/models.ts';
import { applyMessage } from './applyMessage.ts';

const TOAST_MS = 3800;
let nextToast = 1;
const quiet: ((text: string) => boolean)[] = [];

/**
 * Lets a screen that already says something leave out the toast that would repeat it. Each filter
 * answers true for a toast to drop, and any one is enough.
 */
export function addToastFilter(filter: (text: string) => boolean) {
  quiet.push(filter);
}

export interface Toast {
  id: number;
  text: string;
}

interface OfficeState {
  /** Null until the first snapshot arrives. */
  office: Snapshot | null;
  toasts: Toast[];
  setSnapshot: (snapshot: Snapshot) => void;
  apply: (message: ServerMessage) => void;
  /** Applies messages in order, and tells the screens once, not once for each. */
  applyAll: (messages: ServerMessage[]) => void;
  toast: (text: string) => void;
}

export const useOfficeStore = create<OfficeState>((set, get) => ({
  office: null,
  toasts: [],
  setSnapshot: (office) => set({ office }),
  apply: (message) => get().applyAll([message]),
  applyAll: (messages) => {
    const before = get().office;
    let office = before;
    for (const message of messages) {
      // A message already applied, replayed after a reload, does not toast again.
      if (office && message.seq <= office.seq) continue;
      const { text } = message;
      if (message.type === 'toast' && text && !quiet.some((drop) => drop(text))) get().toast(text);
      if (office) office = applyMessage(office, message);
    }
    if (office !== before) set({ office });
  },
  toast: (text) => {
    const id = nextToast++;
    set((state) => ({ toasts: [...state.toasts, { id, text }] }));
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
    }, TOAST_MS);
  },
}));
