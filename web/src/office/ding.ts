// SPDX-License-Identifier: Apache-2.0
import { useOfficeStore } from '../data/officeStore.ts';
import type { LiveAgent } from '../gen/models.ts';

const THROTTLE_MS = 1000;
const NOTES = [
  { frequency: 880, delay: 0 },
  { frequency: 1318.51, delay: 0.12 },
];
const ATTACK = 0.012;
const DECAY = 0.45;
const VOLUME = 0.16;

let context: AudioContext | null = null;
let lastPlayed = -Infinity;

/** Browsers block sound until someone clicks or presses a key, so this runs on the first one. */
function unlock() {
  context ??= new AudioContext();
  if (context.state === 'suspended') void context.resume();
}

function note(audio: AudioContext, frequency: number, at: number) {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(VOLUME, at + ATTACK);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + ATTACK + DECAY);
  oscillator.connect(gain);
  gain.connect(audio.destination);
  oscillator.start(at);
  oscillator.stop(at + ATTACK + DECAY);
}

/** Plays two sine notes, at most once a second, so no sound files are needed. */
export function playDing() {
  if (!context) return;
  const now = performance.now();
  if (now - lastPlayed < THROTTLE_MS) return;
  lastPlayed = now;
  for (const { frequency, delay } of NOTES) note(context, frequency, context.currentTime + delay);
}

/** True when an agent that was already on the floor has just finished. */
export function someoneFinished(before: LiveAgent[], after: LiveAgent[]): boolean {
  return after.some((agent) => {
    if (agent.state !== 'done') return false;
    const earlier = before.find((item) => item.id === agent.id);
    return earlier !== undefined && earlier.state !== 'done';
  });
}

/** Starts listening, and returns how to stop. */
export function listenForCompletions(): () => void {
  document.addEventListener('pointerdown', unlock, { capture: true });
  document.addEventListener('keydown', unlock, { capture: true });
  const unsubscribe = useOfficeStore.subscribe((state, previous) => {
    const { office } = state;
    if (!office?.settings.completionSound || !previous.office) return;
    if (someoneFinished(previous.office.agents, office.agents)) playDing();
  });
  return () => {
    document.removeEventListener('pointerdown', unlock, { capture: true });
    document.removeEventListener('keydown', unlock, { capture: true });
    unsubscribe();
  };
}
