// SPDX-License-Identifier: Apache-2.0
import { useOfficeStore } from '../data/officeStore.ts';
import type { LiveAgent } from '../gen/models.ts';

const THROTTLE_MS = 900;
/** Two bright notes, each with a quiet overtone, as in the prototype. */
const NOTES = [
  { frequency: 1318.5, delay: 0 },
  { frequency: 1975.5, delay: 0.11 },
];

let context: AudioContext | null = null;
let lastPlayed = -Infinity;

/** Browsers block sound until someone clicks or presses a key, so this runs on the first one. */
function unlock() {
  context ??= new AudioContext();
  if (context.state === 'suspended') void context.resume();
}

function tone(
  audio: AudioContext,
  frequency: number,
  at: number,
  peak: number,
  attack: number,
  length: number,
) {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(peak, at + attack);
  gain.gain.exponentialRampToValueAtTime(peak / 275, at + length);
  oscillator.connect(gain);
  gain.connect(audio.destination);
  oscillator.start(at);
  oscillator.stop(at + length + 0.1);
}

/** Plays the chime, at most once every 0.9 seconds. Made with Web Audio, so no sound files. */
export function playDing() {
  if (!context) return;
  const now = performance.now();
  if (now - lastPlayed < THROTTLE_MS) return;
  lastPlayed = now;
  for (const { frequency, delay } of NOTES) {
    const at = context.currentTime + delay;
    tone(context, frequency, at, 0.22, 0.008, 1.1);
    tone(context, frequency * 2.01, at, 0.05, 0.006, 0.5);
  }
}

/**
 * True when an approval has just started waiting for someone: an agent already on the floor now
 * has a pending approval it didn't have before. One that auto approve settled never shows as
 * pending, so it stays quiet.
 */
export function approvalArrived(before: LiveAgent[], after: LiveAgent[]): boolean {
  return after.some((agent) => {
    if (agent.state !== 'approval' || !agent.approval) return false;
    const earlier = before.find((item) => item.id === agent.id);
    return earlier !== undefined && earlier.approval?.id !== agent.approval.id;
  });
}

/** Starts listening, and returns how to stop. */
export function listenForApprovals(): () => void {
  document.addEventListener('pointerdown', unlock, { capture: true });
  document.addEventListener('keydown', unlock, { capture: true });
  const unsubscribe = useOfficeStore.subscribe((state, previous) => {
    const { office } = state;
    if (!office?.settings.approvalSound || !previous.office) return;
    if (approvalArrived(previous.office.agents, office.agents)) playDing();
  });
  return () => {
    document.removeEventListener('pointerdown', unlock, { capture: true });
    document.removeEventListener('keydown', unlock, { capture: true });
    unsubscribe();
  };
}
