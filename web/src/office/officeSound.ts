// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';
import { useOfficeStore } from '../data/officeStore.ts';

/**
 * The sound of the office: a soft room tone with the tap of keys, made with Web Audio and no
 * files. Both rise with how many agents are working, and with none working there is no sound at
 * all, so silence means nothing is running and the state of the office can be heard. It is off
 * until you turn it on in Settings, which is also where its volume is, and it is kept on this
 * browser, since it is about the speakers in front of you.
 */

const STORAGE_KEY = 'mabari.sound';

export interface SoundSettings {
  on: boolean;
  /** From 0 to 1. */
  volume: number;
}

export const DEFAULT_SOUND: SoundSettings = { on: false, volume: 0.5 };

/** Reads what is stored, falling back to off for anything missing or wrong. */
export function readSound(raw: string | null | undefined): SoundSettings {
  try {
    const parsed = JSON.parse(raw ?? 'null') as Partial<SoundSettings> | null;
    const volume = typeof parsed?.volume === 'number' ? parsed.volume : DEFAULT_SOUND.volume;
    return {
      on: parsed?.on === true,
      volume: Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : DEFAULT_SOUND.volume)),
    };
  } catch {
    return DEFAULT_SOUND;
  }
}

const storage = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

interface SoundStore extends SoundSettings {
  setOn: (on: boolean) => void;
  setVolume: (volume: number) => void;
}

const save = (settings: SoundSettings) => {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be blocked; the choice lasts until the page closes.
  }
};

export const useOfficeSound = create<SoundStore>((set, get) => ({
  ...readSound(storage()?.getItem(STORAGE_KEY)),
  setOn: (on) => {
    set({ on });
    save({ on, volume: get().volume });
  },
  setVolume: (volume) => {
    set({ volume });
    save({ on: get().on, volume });
  },
}));

/** How loud the room tone is, from 0 to 1: nothing with nobody working, then rising and levelling off. */
export function roomLevel(working: number): number {
  if (working <= 0) return 0;
  return Math.min(1, 0.25 + working * 0.13);
}

/** Key taps a second: none with nobody working, then rising with the number, up to a busy floor. */
export function tapRate(working: number): number {
  if (working <= 0) return 0;
  return Math.min(9, 1.1 * working ** 0.9);
}

/** The most the speakers are given at full volume, because the room is meant to be quiet. */
const MAX_GAIN = 0.32;
/** From the slider to a gain: quieter at the low end, where hearing is most sensitive. */
export const masterGain = (volume: number): number => MAX_GAIN * volume * volume;

/** How many agents are working, which is the server's own flag, so a waiting agent isn't. */
export function workingCount(agents: { working: boolean }[]): number {
  return agents.filter((agent) => agent.working).length;
}

/** Two seconds of brown noise: what a room sounds like when nothing in it is loud. */
function noiseBuffer(audio: AudioContext): AudioBuffer {
  const length = audio.sampleRate * 2;
  const buffer = audio.createBuffer(1, length, audio.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let index = 0; index < length; index++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    data[index] = last * 3.5;
  }
  // The end meets the start, so the loop has no click.
  const fade = 400;
  for (let index = 0; index < fade; index++) {
    const mix = index / fade;
    data[length - fade + index] = data[length - fade + index]! * (1 - mix) + data[index]! * mix;
  }
  return buffer;
}

/** The nodes of the room while it is on. */
interface Room {
  master: GainNode;
  tone: GainNode;
  working: (count: number) => void;
  stop: () => void;
}

function buildRoom(audio: AudioContext, volume: number): Room {
  const buffer = noiseBuffer(audio);
  const master = audio.createGain();
  master.gain.value = masterGain(volume);
  master.connect(audio.destination);
  const tone = audio.createGain();
  tone.gain.value = 0;
  const lowpass = audio.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 420;
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(lowpass);
  lowpass.connect(tone);
  tone.connect(master);
  source.start();

  let rate = 0;
  let level = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** One key: a short burst of the same noise through a band, so it clicks rather than hisses. */
  const tap = () => {
    const at = audio.currentTime;
    const click = audio.createBufferSource();
    click.buffer = buffer;
    const band = audio.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1800 + Math.random() * 1600;
    band.Q.value = 1.4;
    const envelope = audio.createGain();
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime((0.5 + Math.random() * 0.5) * level, at + 0.002);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.035);
    click.connect(band);
    band.connect(envelope);
    envelope.connect(master);
    click.start(at, Math.random() * 1.5, 0.05);
  };
  const next = () => {
    timer = undefined;
    if (rate <= 0) return;
    tap();
    // Typing comes in bursts: now and then a quick second key, then a pause.
    const gap =
      Math.random() < 0.3 ? 70 + Math.random() * 60 : (1000 / rate) * (0.5 + Math.random());
    timer = setTimeout(next, gap);
  };
  return {
    master,
    tone,
    working: (count) => {
      level = roomLevel(count);
      rate = tapRate(count);
      // Easing to the new level, so the room swells and dies away rather than switching.
      tone.gain.setTargetAtTime(0.7 * level, audio.currentTime, 0.5);
      if (rate > 0 && timer === undefined) timer = setTimeout(next, 200);
      if (rate <= 0 && timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    stop: () => {
      clearTimeout(timer);
      timer = undefined;
      rate = 0;
      source.stop();
      master.disconnect();
    },
  };
}

/** Resuming or suspending can be refused, and nothing is lost if it is: the sound stays quiet. */
const quietly = (result: Promise<void> | undefined) => result?.catch(() => undefined);

let audio: AudioContext | null = null;
let room: Room | null = null;
/** A sample is playing, so the room sounds busy for a moment whatever the office is doing. */
let sampling = false;

function context(): AudioContext | null {
  if (audio) return audio;
  try {
    audio = new AudioContext();
  } catch {
    audio = null;
  }
  return audio;
}

function currentWorking(): number {
  return workingCount(useOfficeStore.getState().office?.agents ?? []);
}

/** Brings the room in line with the settings and the office: on or off, how loud, how busy. */
function apply(): void {
  const { on, volume } = useOfficeSound.getState();
  if (!on) {
    room?.stop();
    room = null;
    quietly(audio?.suspend());
    return;
  }
  const ctx = context();
  if (!ctx) return;
  if (document.visibilityState === 'visible') quietly(ctx.resume());
  room ??= buildRoom(ctx, volume);
  room.master.gain.setTargetAtTime(masterGain(volume), ctx.currentTime, 0.05);
  room.working(sampling ? 5 : currentWorking());
}

/** Plays the room for two seconds as if the floor were busy, so the volume can be set by ear. */
export function playSample(): void {
  if (!useOfficeSound.getState().on) return;
  sampling = true;
  apply();
  setTimeout(() => {
    sampling = false;
    apply();
  }, 2200);
}

/** A soft rising chime, for a project shipping, when the office's sound is on. */
export function playChime(): void {
  const { on, volume } = useOfficeSound.getState();
  if (!on || !audio || audio.state !== 'running') return;
  const gain = Math.min(0.3, masterGain(volume) * 1.6);
  [1046.5, 1318.5, 1568].forEach((frequency, index) => {
    const at = audio!.currentTime + index * 0.11;
    const oscillator = audio!.createOscillator();
    const envelope = audio!.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(gain, at + 0.01);
    envelope.gain.exponentialRampToValueAtTime(gain / 200, at + 0.9);
    oscillator.connect(envelope);
    envelope.connect(audio!.destination);
    oscillator.start(at);
    oscillator.stop(at + 1);
  });
}

/**
 * Starts listening: to the settings and to the office, so the room follows them. Browsers keep
 * sound silent until someone clicks or presses a key, so the first one wakes it. It rests while
 * the page is hidden. Returns how to stop.
 */
export function startOfficeSound(): () => void {
  const wake = () => {
    if (useOfficeSound.getState().on) apply();
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') apply();
    else quietly(audio?.suspend());
  };
  document.addEventListener('pointerdown', wake, { capture: true });
  document.addEventListener('keydown', wake, { capture: true });
  document.addEventListener('visibilitychange', onVisible);
  const unsubscribeSettings = useOfficeSound.subscribe(apply);
  const unsubscribeOffice = useOfficeStore.subscribe((state, previous) => {
    if (!room || state.office?.agents === previous.office?.agents) return;
    room.working(sampling ? 5 : currentWorking());
  });
  apply();
  return () => {
    document.removeEventListener('pointerdown', wake, { capture: true });
    document.removeEventListener('keydown', wake, { capture: true });
    document.removeEventListener('visibilitychange', onVisible);
    unsubscribeSettings();
    unsubscribeOffice();
    room?.stop();
    room = null;
    quietly(audio?.suspend());
  };
}
