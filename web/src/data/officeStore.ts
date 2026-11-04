// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';
import type { ServerMessage, Snapshot } from '../gen/models.ts';
import { applyMessage } from './applyMessage.ts';

const TOAST_MS = 3800;
let nextToast = 1;
let quiet: ((text: string) => boolean) | null = null;

/** Lets a screen that already says something leave out the toast that would repeat it. */
export function setToastFilter(filter: ((text: string) => boolean) | null) {
  quiet = filter;
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
  toast: (text: string) => void;
}

export const useOfficeStore = create<OfficeState>((set, get) => ({
  office: null,
  toasts: [],
  setSnapshot: (office) => set({ office }),
  apply: (message) => {
    const { office } = get();
    // A message already applied, replayed after a reload, does not toast again.
    if (office && message.seq <= office.seq) return;
    if (message.type === 'toast' && message.text && !quiet?.(message.text))
      get().toast(message.text);
    if (office) set({ office: applyMessage(office, message) });
  },
  toast: (text) => {
    const id = nextToast++;
    set((state) => ({ toasts: [...state.toasts, { id, text }] }));
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
    }, TOAST_MS);
  },
}));
