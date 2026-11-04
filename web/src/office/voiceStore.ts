// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';
import { useOfficeStore } from '../data/officeStore.ts';
import type { Snapshot } from '../gen/models.ts';
import { send } from './send.ts';
import { listen, type Listener } from './speech.ts';
import { useOfficeUi } from './uiStore.ts';
import { detect, type Heard } from './voice.ts';

export type VoicePhase = 'listen' | 'confirm' | null;

interface VoiceStore {
  phase: VoicePhase;
  text: string;
  heard: Heard | null;
  /** The engine in use: browser speech, or Local Whisper on Mabari's server. */
  engine: string;
  /** Local Whisper is turning the recording into text, after release. */
  transcribing: boolean;
  start: (office: Snapshot) => void;
  /** The mic or Space was released. This only ever gets ready: it sends nothing. */
  stop: () => void;
  /** The one way a spoken message leaves: a click on Send, or Enter. */
  send: () => void;
  cancel: () => void;
}

const toast = (text: string) => useOfficeStore.getState().toast(text);

function detected(text: string): Heard | null {
  const office = useOfficeStore.getState().office;
  if (!office) return null;
  const { selected } = useOfficeUi.getState();
  const agent = office.agents.find((item) => item.id === selected) ?? null;
  return detect(text, office.agents, agent);
}

export const useVoice = create<VoiceStore>((set, get) => {
  let listener: Listener | null = null;
  let ended = false;

  /** Clears everything before aborting, because abort can call back into onEnd. */
  const close = () => {
    const active = listener;
    listener = null;
    set({ phase: null, text: '', heard: null, transcribing: false });
    active?.abort();
  };

  /** Runs after release. Voice can never approve, so an approval goes to the card for a click. */
  const settle = () => {
    const { phase, text, heard } = get();
    if (phase !== 'confirm') return;
    if (heard?.approval && heard.agent?.state === 'approval' && heard.agent.approval) {
      close();
      useOfficeUi.getState().set({
        selected: heard.agent.id,
        reviewing: heard.agent.approval.id,
        spokenApproval: true,
      });
      return;
    }
    if (ended && !text) {
      close();
      toast("I didn't catch that. Nothing was sent.");
    }
  };

  return {
    phase: null,
    text: '',
    heard: null,
    engine: 'browser',
    transcribing: false,
    start: (office) => {
      if (get().phase) return;
      if (!office.agents.length) {
        toast('There are no agents to talk to yet.');
        return;
      }
      const engine = office.settings.voiceEngine;
      ended = false;
      set({ phase: 'listen', text: '', heard: null, engine, transcribing: false });
      listener = listen(
        {
          onText: (text) => {
            set({ text, heard: detected(text) });
            settle();
          },
          onError: (message) => {
            close();
            toast(message);
          },
          onEnd: () => {
            ended = true;
            set({ transcribing: false });
            settle();
          },
        },
        engine,
      );
    },
    stop: () => {
      if (get().phase !== 'listen') return;
      set({ phase: 'confirm', transcribing: get().engine === 'whisper' && !ended });
      listener?.stop();
      settle();
    },
    send: () => {
      const { phase, text, heard } = get();
      const office = useOfficeStore.getState().office;
      if (phase !== 'confirm' || !text || !heard || !office) return;
      close();
      if (heard.agent) useOfficeUi.getState().set({ selected: heard.agent.id, target: 'selected' });
      void send(text, heard.mode, heard.agent?.id ?? 'auto', office);
    },
    cancel: () => {
      if (!get().phase) return;
      close();
      toast('Cancelled. Nothing was sent.');
    },
  };
});
