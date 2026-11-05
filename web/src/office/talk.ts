// SPDX-License-Identifier: Apache-2.0
// Agents talking on the floor, as in the prototype: nothing travels between them. The receiver
// gets a small envelope that pops in over its head, and both name tags get a chip ("↗ To …" on
// the sender, "✉ From …" on the receiver). All of it fades after about 4 seconds.
import type { Message } from '../gen/models.ts';
import { R } from './background.ts';

/** Message kinds and their colours, from the prototype's CONV table. */
export const MESSAGE_KINDS: Record<string, { color: string; label: string }> = {
  handoff: { color: '#1DD1A1', label: 'Handoff' },
  question: { color: '#48DBFB', label: 'Question' },
  answer: { color: '#4FB3FF', label: 'Answer' },
  report: { color: '#FF9F43', label: 'Report' },
  review: { color: '#FF6B9A', label: 'Review' },
};

const NEUTRAL = '#8E8E93';
/** How long a message shows on the floor, in milliseconds. */
export const SHOW_MS = 4200;
const FADE_FROM_MS = 3600;

export interface Point {
  x: number;
  y: number;
}

export function kindColor(kind: string): string {
  return MESSAGE_KINDS[kind]?.color ?? NEUTRAL;
}

export function kindLabel(kind: string): string {
  return MESSAGE_KINDS[kind]?.label ?? kind;
}

/** The newest message to or from an agent that is still showing, or null. */
export function latestFor(agentId: string, messages: Message[], now: number): Message | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (now - message.time > SHOW_MS) return null;
    if (message.fromAgent === agentId || message.toAgents.includes(agentId)) return message;
  }
  return null;
}

export interface Chip {
  text: string;
  color: string;
  incoming: boolean;
  /**
   * Drawn as a ring, not filled. The prototype fills a receiver's chip, but a filled question
   * chip is the loudest thing on the floor after red, and only red and amber may ask for
   * attention. So questions are outlined on both sides.
   */
  outlined: boolean;
}

/** The chip under an agent's name tag while it is sending or receiving a message. */
export function chipFor(
  agentId: string,
  messages: Message[],
  now: number,
  nameOf: (id: string) => string,
): Chip | null {
  const message = latestFor(agentId, messages, now);
  if (!message) return null;
  const incoming = message.fromAgent !== agentId;
  const other = incoming ? nameOf(message.fromAgent) : nameOf(message.toAgents[0] ?? '');
  return {
    text: `${incoming ? '✉ From' : '↗ To'} ${other} · ${kindLabel(message.kind)}`,
    color: kindColor(message.kind),
    incoming,
    outlined: !incoming || message.kind === 'question',
  };
}

/** Draws the envelope that pops in over each receiver's head. Without motion it just appears. */
export function drawEnvelopes(
  c: CanvasRenderingContext2D,
  messages: Message[],
  where: (id: string) => Point | null,
  now: number,
  still: boolean,
): void {
  for (const message of messages.slice(-40)) {
    const age = now - message.time;
    if (age > SHOW_MS || age < 0) continue;
    const to = where(message.toAgents[0] ?? '');
    if (!to) continue;
    const color = kindColor(message.kind);
    const pop = still ? 1 : Math.min(1, age / 220);
    const fade = age > FADE_FROM_MS ? 1 - (age - FADE_FROM_MS) / (SHOW_MS - FADE_FROM_MS) : 1;
    const bob = still || age >= 1200 ? 0 : Math.sin(age / 140) * 1.5;
    c.globalAlpha = Math.max(0, fade);
    c.save();
    c.translate(to.x + 16, to.y - 58 + bob - (1 - pop) * 8);
    c.scale(0.6 + 0.4 * pop, 0.6 + 0.4 * pop);
    R(c, -9, -6, 18, 13, '#FFFFFF');
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.strokeRect(-9, -6, 18, 13);
    c.beginPath();
    c.moveTo(-9, -6);
    c.lineTo(0, 2);
    c.lineTo(9, -6);
    c.stroke();
    c.fillStyle = color;
    c.beginPath();
    c.ellipse(9, -7, 3.5, 3.5, 0, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }
  c.globalAlpha = 1;
}
