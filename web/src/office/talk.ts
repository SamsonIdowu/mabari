// SPDX-License-Identifier: Apache-2.0
// Agents talking on the floor, ported from the prototype: a dashed curve between the two while a
// message is fresh, and an envelope that flies from sender to receiver when it is sent.
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
const CURVE_MS = 4500;
const FLIGHT_MS = 950;

export interface Point {
  x: number;
  y: number;
}

interface Flight {
  a: Point;
  b: Point;
  t0: number;
  col: string;
}

export function kindColor(kind: string): string {
  return MESSAGE_KINDS[kind]?.color ?? NEUTRAL;
}

/** Remembers which messages it has seen, so only new ones fly. */
export class Talk {
  private seen = new Set<string>();
  private flights: Flight[] = [];
  private primed = false;

  /** Starts a flight for each message that is new since the last frame. */
  update(messages: Message[], where: (id: string) => Point | null, now: number): void {
    const recent = messages.slice(-20);
    if (!this.primed) {
      for (const message of messages) this.seen.add(message.id);
      this.primed = true;
      return;
    }
    for (const message of recent) {
      if (this.seen.has(message.id)) continue;
      this.seen.add(message.id);
      const a = where(message.fromAgent);
      const b = where(message.toAgents[0] ?? '');
      if (a && b) this.flights.push({ a, b, t0: now, col: kindColor(message.kind) });
    }
  }

  /** Draws fresh conversations as dashed curves between the two agents. */
  drawCurves(
    c: CanvasRenderingContext2D,
    messages: Message[],
    where: (id: string) => Point | null,
    t: number,
    clock: number,
  ): void {
    for (const message of messages.slice(-40)) {
      const age = clock - message.time;
      if (age > CURVE_MS || age < 0) continue;
      const a = where(message.fromAgent);
      const b = where(message.toAgents[0] ?? '');
      if (!a || !b) continue;
      c.globalAlpha = Math.max(0, 1 - age / CURVE_MS) * 0.85;
      c.strokeStyle = kindColor(message.kind);
      c.lineWidth = 2;
      c.setLineDash([3, 5]);
      c.lineDashOffset = -t / 40;
      const mx = (a.x + b.x) / 2;
      const my = Math.min(a.y, b.y) - 70;
      c.beginPath();
      c.moveTo(a.x, a.y - 30);
      c.quadraticCurveTo(mx, my, b.x, b.y - 30);
      c.stroke();
      c.setLineDash([]);
      c.globalAlpha = 1;
    }
  }

  /** Draws the envelopes in flight, with a short trail. */
  drawFlights(c: CanvasRenderingContext2D, now: number): void {
    this.flights = this.flights.filter((flight) => now - flight.t0 < FLIGHT_MS);
    for (const flight of this.flights) {
      const progress = (now - flight.t0) / FLIGHT_MS;
      const eased = progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
      const ax = flight.a.x;
      const ay = flight.a.y - 30;
      const bx = flight.b.x;
      const by = flight.b.y - 30;
      const at = (q: number) => ({
        x: ax + (bx - ax) * q,
        y: ay + (by - ay) * q - Math.sin(q * Math.PI) * 48,
      });
      for (let i = 1; i < 6; i++) {
        const q = at(Math.max(0, eased - i * 0.035));
        c.globalAlpha = 0.55 - i * 0.09;
        R(c, q.x - 1.5, q.y - 1.5, 3, 3, flight.col);
      }
      const m = at(eased);
      c.globalAlpha = 1;
      R(c, m.x - 7, m.y - 5, 14, 10, '#FFFDF7');
      R(c, m.x - 7, m.y - 5, 14, 2, flight.col);
      c.strokeStyle = flight.col;
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(m.x - 7, m.y - 4);
      c.lineTo(m.x, m.y + 1);
      c.lineTo(m.x + 7, m.y - 4);
      c.stroke();
    }
    c.globalAlpha = 1;
  }

  /** How many envelopes are flying, for tests. */
  get flying(): number {
    return this.flights.length;
  }
}
