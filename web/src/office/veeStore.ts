// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';
import { api, type VeeReply } from '../data/api.ts';
import { addToastFilter, onWatchFired, useOfficeStore } from '../data/officeStore.ts';
import { mabariCreate, mabariImprove } from './builderStore.tsx';
import { slug } from './defs.ts';
import { holderOf, relayLine, replyFor, stillWaiting, type Relay } from './relay.ts';
import { showResult } from './send.ts';
import { VEE_GESTURES, type PlayingGesture, type VeeState } from './vee.ts';

const DIALOG_DELAY_MS = 500;
const TALK_MS = 6000;
const TALK_BASE_MS = 900;
const TALK_PER_LETTER_MS = 38;
/** The acknowledgement stays up at least this long before a reply that was already there. */
const ACK_SHOWN_MS = 900;

export const VEE_HELLO: VeeReply = {
  text: "Hi, I'm Mabari, your office manager. Tell me what you need and I'll hand it to the right agent, then tell you what Claude, Codex or any other AI says back.",
  gesture: '',
  kind: '',
  lines: null,
  estimate: null,
  working: 0,
  total: 0,
  need: 0,
  relay: null,
};

export interface MabariUpdate {
  id: number;
  text: string;
  at: number;
  /** For an update from Mabari's rounds, the project it is about ("" for none). */
  about?: string;
}

const UPDATES_KEPT = 30;
/** How many of Mabari's replies the bubble's pager can go back through. */
const LOG_KEPT = 20;
let nextUpdate = 1;

/** In full screen Home can't be seen, so Mabari's news also shows as a toast. */
function toastInFullscreen(text: string) {
  if (typeof document !== 'undefined' && document.body.classList.contains('ofs')) {
    useOfficeStore.getState().toast(`Mabari: ${text}`);
  }
}

interface VeeStore {
  state: VeeState;
  said: VeeReply;
  /** Everything Mabari said on Home, oldest first, so an earlier reply can be read again. */
  log: VeeReply[];
  /** Which of the log the bubble shows, or null for the latest. */
  view: number | null;
  /** Steps the bubble to an earlier (-1) or later (+1) reply, as the prototype's pager does. */
  look: (step: number) => void;
  heard: string;
  gesture: PlayingGesture | null;
  talkUntil: number;
  /** Instructions Mabari passed on and is waiting to hear back about. */
  relays: Relay[];
  /** Replies relayed while the person was on another page, for the badge on Home. */
  unread: number;
  /** True while Home is on screen. */
  onHome: boolean;
  /** Mabari's latest messages, newest last, for the updates button in full screen. */
  updates: MabariUpdate[];
  /**
   * The project messages go to: a project id, "any" for any agent in the office, or empty to let
   * Mabari choose from its map of the projects and ask when it can't tell.
   */
  project: string;
  setProject: (project: string) => void;
  /** True while the mic on Home is listening, so nothing makes Mabari gesture over it. */
  listening: boolean;
  setListening: (listening: boolean) => void;
  play: (name: string) => void;
  say: (reply: VeeReply, queued?: boolean) => void;
  /**
   * Adds what Mabari found about a project on its rounds, without saying it out loud on Home. It
   * replaces the last one about the same project, so the rounds never crowd out replies.
   */
  report: (about: string, text: string) => void;
  /**
   * Sends a message, to the project given or else the one picked next to the box. False when the
   * message never reached Mabari, so the words can be put back in the box.
   */
  hear: (text: string, project?: string) => Promise<boolean>;
  setOnHome: (on: boolean) => void;
  /** Mabari posts an update in the Home chat, read aloud with Voice on, counted when elsewhere. */
  post: (text: string, gesture?: string) => void;
  /** Called once a frame to finish what has finished. */
  settle: (now: number) => void;
  /** Back to the greeting, and quiet, after the office was wiped or replaced. */
  reset: () => void;
}

/**
 * Reads a reply aloud with the browser's own voices, which run on this computer. A relayed
 * reply waits for the acknowledgement to finish instead of cutting it off.
 */
function speak(text: string, queued: boolean) {
  if (!window.speechSynthesis) return;
  if (!queued) window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.04;
  utterance.pitch = 1.15;
  window.speechSynthesis.speak(utterance);
}

/**
 * Requests for the agent builder: Mabari's skills fill in the build dialog here, on the page, and
 * Mabari says what it did. Nothing is saved until the person presses Save.
 */
function builderReply(reply: VeeReply): VeeReply {
  const target = reply.target ?? '';
  switch (reply.kind) {
    case 'newAgent': {
      const asked = target.length > 6 ? target : '';
      const name = mabariCreate(asked);
      return {
        ...reply,
        text: asked
          ? `I drafted ${name} for that. Check it and save, and I'll start sending it matching work.`
          : "Let's build one. Tell me what it should do in the box and press Draft.",
      };
    }
    case 'improve': {
      const office = useOfficeStore.getState().office;
      let found = mabariImprove(slug(target));
      const agent = office?.agents.find((item) => item.name.toLowerCase() === target.trim());
      if (!found && agent?.defId) found = mabariImprove(agent.defId);
      if (!found) {
        const some = (office?.defs ?? [])
          .filter((def) => !def.system)
          .slice(0, 3)
          .map((def) => def.name);
        return {
          ...reply,
          gesture: 'shrug',
          text: `I couldn't find a built agent called ${target}.${some.length ? ` Try one from the agent builder, like ${some.join(', ')}.` : ' Build one in the agent builder first.'}`,
        };
      }
      return {
        ...reply,
        text: found.changes
          ? `I reviewed ${found.name} and suggest ${found.changes} change${found.changes === 1 ? '' : 's'}. They're open for you to check and save.`
          : `${found.name} already looks solid. I opened it in case you want to tweak it.`,
      };
    }
    case 'builder':
      setTimeout(() => {
        window.location.hash = '#builder';
      }, DIALOG_DELAY_MS);
      return reply;
    default:
      return reply;
  }
}

function fail(error: Error): VeeReply {
  return { ...VEE_HELLO, text: error.message, gesture: 'shrug' };
}

let ackAt = 0;
const relaying = new Set<string>();

/** Where the project picked next to the box is remembered, in this browser only. */
const PROJECT_KEY = 'mabari.vee.project';

function savedProject(): string {
  try {
    return globalThis.localStorage?.getItem(PROJECT_KEY) ?? '';
  } catch {
    return '';
  }
}

export const useVee = create<VeeStore>((set, get) => ({
  state: 'idle',
  said: VEE_HELLO,
  log: [],
  view: null,
  look: (step) =>
    set((state) => {
      const last = state.log.length - 1;
      const next = Math.max(0, Math.min(last, (state.view ?? last) + step));
      return { view: next === last ? null : next };
    }),
  heard: '',
  gesture: null,
  talkUntil: 0,
  relays: [],
  unread: 0,
  onHome: false,
  project: savedProject(),
  listening: false,
  setListening: (listening) => set({ listening }),
  setProject: (project) => {
    set({ project });
    try {
      globalThis.localStorage?.setItem(PROJECT_KEY, project);
    } catch {
      // Remembering the choice is a convenience; without storage it lasts until a reload.
    }
  },
  updates: [],
  play: (name) => {
    const gesture = VEE_GESTURES[name];
    if (gesture) set({ gesture: { name, start: performance.now(), dur: gesture.dur } });
  },
  report: (about, text) =>
    set((state) => ({
      updates: [
        ...state.updates.filter((update) => update.about !== about),
        { id: nextUpdate++, text, at: Date.now(), about },
      ].slice(-UPDATES_KEPT),
    })),
  say: (reply, queued = false) => {
    set((state) => ({
      updates: [...state.updates, { id: nextUpdate++, text: reply.text, at: Date.now() }].slice(
        -UPDATES_KEPT,
      ),
    }));
    set((state) => ({ log: [...state.log, reply].slice(-LOG_KEPT), view: null }));
    set({
      said: reply,
      state: 'talk',
      talkUntil:
        performance.now() +
        Math.min(TALK_MS, TALK_BASE_MS + reply.text.length * TALK_PER_LETTER_MS),
    });
    if (reply.gesture) get().play(reply.gesture);
    if (useOfficeStore.getState().office?.settings.spokenReplies) {
      speak(reply.spoken ?? reply.text, queued);
    }
  },
  // No pause and no model: the server answers from the office and the dispatcher's own scoring,
  // so the acknowledgement shows as soon as it comes back.
  hear: async (text, project) => {
    set({ heard: text, state: 'think' });
    try {
      const result = await api.vee(text, project ?? get().project);
      ackAt = Date.now();
      get().say(builderReply(result.reply));
      if (result.message) showResult(result.message, text);
      if (result.reply.relay) {
        set((state) => ({ relays: [...state.relays, result.reply.relay!] }));
        watch();
      }
      return true;
    } catch (error) {
      get().say(fail(error as Error));
      return false;
    }
  },
  setOnHome: (on) => set(on ? { onHome: true, unread: 0 } : { onHome: false }),
  post: (text, gesture = 'nod') => {
    get().say({ ...VEE_HELLO, text, gesture, kind: '' }, true);
    if (!get().onHome) {
      set((state) => ({ unread: state.unread + 1 }));
      toastInFullscreen(text);
    }
  },
  reset: () => {
    window.speechSynthesis?.cancel();
    relaying.clear();
    set({
      state: 'idle',
      said: VEE_HELLO,
      log: [],
      view: null,
      heard: '',
      gesture: null,
      talkUntil: 0,
      relays: [],
      unread: 0,
      updates: [],
    });
  },
  settle: (now) => {
    const { gesture, state, talkUntil } = get();
    if (gesture && now >= gesture.start + gesture.dur) set({ gesture: null });
    if (state === 'talk' && now > talkUntil) set({ state: 'idle' });
  },
}));

/** Posts an agent's reply in the Home chat, speaks it, and counts it if Home isn't showing. */
function relay(item: Relay, reply: string) {
  // A prompt Claude Code opened with has no agent until a session takes it; name that session.
  const holder = holderOf(useOfficeStore.getState().office, item);
  if (holder && !item.agentId) item = { ...item, agentId: holder.id, agent: holder.name };
  const line = relayLine(item, reply);
  const store = useVee.getState();
  // The acknowledgement that came when this was sent stays with the reply, so who got it and why
  // can still be read once the reply lands.
  const ack = store.log.find((said) => said.relay?.instructionId === item.instructionId)?.text;
  store.say(
    {
      ...VEE_HELLO,
      text: line.text,
      gesture: 'nod',
      kind: 'relayed',
      spoken: line.spoken,
      agentId: line.clipped ? item.agentId : undefined,
      ack,
    },
    true,
  );
  if (!store.onHome) {
    useVee.setState((state) => ({ unread: state.unread + 1 }));
    toastInFullscreen(line.text);
  }
}

/**
 * Relays each reply the moment the server pushes it over the event stream. Nothing polls: this
 * runs when the office changes, and once right after Mabari passes something on, in case the
 * reply was already there.
 */
function watch() {
  const office = useOfficeStore.getState().office;
  const { relays } = useVee.getState();
  if (!relays.length) return;
  const keep: Relay[] = [];
  for (const item of relays) {
    if (relaying.has(item.instructionId)) continue;
    const answered = replyFor(office, item);
    if (answered) {
      relaying.add(item.instructionId);
      const wait = Math.max(0, ackAt + ACK_SHOWN_MS - Date.now());
      setTimeout(() => {
        relaying.delete(item.instructionId);
        relay(item, answered.reply);
      }, wait);
    } else if (stillWaiting(office, item)) {
      keep.push(item);
    }
  }
  if (keep.length !== relays.length) useVee.setState({ relays: keep });
}

// On Home, Mabari reads the reply out itself, so the server's "Ledger replied" toast would repeat it.
addToastFilter((text) => {
  const { onHome, relays } = useVee.getState();
  if (!onHome) return false;
  const office = useOfficeStore.getState().office;
  return relays.some((item) => {
    const name = holderOf(office, item)?.name ?? item.agent;
    return text.startsWith(`${name} replied.`) || text.startsWith(`${item.agent} replied.`);
  });
});

useOfficeStore.subscribe((state, previous) => {
  if (state.office !== previous.office) watch();
});

// A watch that fires ("tell me when Ledger is done") says so in Home's chat too. The toast it
// already got is the whole of what shows elsewhere, so unlike post this adds no second one.
onWatchFired((fired) => {
  const store = useVee.getState();
  store.say({ ...VEE_HELLO, text: fired.text, gesture: 'nod', kind: '' }, true);
  if (!store.onHome) useVee.setState((state) => ({ unread: state.unread + 1 }));
});
