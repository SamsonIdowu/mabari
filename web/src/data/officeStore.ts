// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';
import type { ServerMessage, Snapshot } from '../gen/models.ts';
import { applyMessage } from './applyMessage.ts';

const TOAST_MS = 3800;
let nextToast = 1;

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
    if (message.type === 'toast' && message.text) get().toast(message.text);
    const { office } = get();
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
