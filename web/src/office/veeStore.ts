// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';
import { api, type VeeReply } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import { showResult } from './send.ts';
import { useOfficeUi } from './uiStore.ts';
import { VEE_GESTURES, type PlayingGesture, type VeeState } from './vee.ts';

const THINK_MS = 700;
const DIALOG_DELAY_MS = 500;
const TALK_MS = 6000;
const TALK_BASE_MS = 900;
const TALK_PER_LETTER_MS = 38;

export const VEE_HELLO: VeeReply = {
  text: "Hi, I'm Vee. Ask me what's happening, or tell me what you need.",
  gesture: '',
  kind: '',
  lines: null,
  estimate: null,
  working: 0,
  total: 0,
  need: 0,
  message: '',
};

interface VeeStore {
  state: VeeState;
  said: VeeReply;
  heard: string;
  gesture: PlayingGesture | null;
  talkUntil: number;
  play: (name: string) => void;
  say: (reply: VeeReply) => void;
  hear: (text: string) => Promise<void>;
  sendToTeam: (text: string) => Promise<void>;
  /** Called once a frame to finish what has finished. */
  settle: (now: number) => void;
}

/** Reads a reply aloud with the browser's own voices, which run on this computer. */
function speak(text: string) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.04;
  utterance.pitch = 1.15;
  window.speechSynthesis.speak(utterance);
}

function fail(error: Error): VeeReply {
  return { ...VEE_HELLO, text: error.message, gesture: 'shrug' };
}

export const useVee = create<VeeStore>((set, get) => ({
  state: 'idle',
  said: VEE_HELLO,
  heard: '',
  gesture: null,
  talkUntil: 0,
  play: (name) => {
    const gesture = VEE_GESTURES[name];
    if (gesture) set({ gesture: { name, start: performance.now(), dur: gesture.dur } });
  },
  say: (reply) => {
    set({
      said: reply,
      state: 'talk',
      talkUntil:
        performance.now() +
        Math.min(TALK_MS, TALK_BASE_MS + reply.text.length * TALK_PER_LETTER_MS),
    });
    if (reply.gesture) get().play(reply.gesture);
    if (useOfficeStore.getState().office?.settings.spokenReplies) speak(reply.text);
  },
  hear: async (text) => {
    set({ heard: text, state: 'think' });
    const pause = new Promise((resolve) => setTimeout(resolve, THINK_MS));
    try {
      const [result] = await Promise.all([api.vee(text, false), pause]);
      get().say(result.reply);
      if (result.message) showResult(result.message, text);
      if (result.reply.kind === 'newAgent') {
        setTimeout(() => useOfficeUi.getState().set({ newAgent: {} }), DIALOG_DELAY_MS);
      }
    } catch (error) {
      get().say(fail(error as Error));
    }
  },
  sendToTeam: async (text) => {
    try {
      const result = await api.vee(text, true);
      get().say(result.reply);
    } catch (error) {
      get().say(fail(error as Error));
    }
  },
  settle: (now) => {
    const { gesture, state, talkUntil } = get();
    if (gesture && now >= gesture.start + gesture.dur) set({ gesture: null });
    if (state === 'talk' && now > talkUntil) set({ state: 'idle' });
  },
}));
