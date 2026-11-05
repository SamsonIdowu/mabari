// SPDX-License-Identifier: Apache-2.0
import { useOfficeStore } from '../data/officeStore.ts';
import type { LiveAgent } from '../gen/models.ts';
import { identityHues, providers, type ProviderName } from '../shared/tokens.ts';
import { useThemeStore } from '../theme/themeStore.ts';
import { blk, buildBg, ell, PAL, R, RACKS, rrect } from './background.ts';
import { clampView, teamView, toScreen, viewMatrix, fromScreen, type View } from './camera.ts';
import { drawChar } from './character.ts';
import { drawEnvelopes } from './talk.ts';
import { drawMascot } from './vee.ts';
import {
  deskSeat,
  DESKS,
  H,
  pathTo,
  spotFor,
  SPOTS,
  STATE_LOCATIONS,
  W,
  type Point,
} from './layout.ts';
import { inScope, matches, useOfficeUi } from './uiStore.ts';

/** An agent as the floor sees it: the server's agent plus where it is walking. */
export type Walker = LiveAgent & {
  /** Its number in arrival order, which keeps animations and spots stable. */
  n: number;
  x: number;
  y: number;
  path: Point[];
  dir: number;
  walk: number;
  spd: number;
  popUntil: number;
  front?: boolean;
};

const backgrounds: Partial<Record<'dark' | 'light', HTMLCanvasElement>> = {};

export function officeBackground(theme: 'dark' | 'light'): HTMLCanvasElement {
  return (backgrounds[theme] ??= buildBg(theme));
}

const HERO_AGENTS = [
  { x: 288, y: 182, provider: 'claude', state: 'editing' },
  { x: 448, y: 182, provider: 'openai', state: 'thinking' },
  { x: 90, y: 588, provider: 'custom', state: 'browsing' },
  { x: 1046, y: 520, provider: 'claude', state: 'idle' },
  { x: 608, y: 310, provider: 'openai', state: 'approval' },
];
const HERO_SKINS = ['#F2C9A0', '#D9A27A', '#B07850', '#8C5A3A', '#6B4128'];
const HERO_HAIR = ['#2A1B12', '#5A3A22', '#101010', '#B5651D', '#D9C27A'];

/** The still picture on the welcome screen: the office with five agents at work. */
export function paintHero(c: CanvasRenderingContext2D, theme: 'dark' | 'light'): void {
  c.imageSmoothingEnabled = false;
  c.drawImage(officeBackground(theme), 0, 0);
  HERO_AGENTS.forEach((agent, index) => {
    const walker = {
      ...agent,
      n: 900 + index,
      path: [],
      popUntil: 0,
      dir: 0,
      walk: 0,
      skin: HERO_SKINS[index],
      hair: HERO_HAIR[index],
      hue: identityHues[index],
    } as unknown as Walker;
    drawChar(c, walker, 1200 + index * 400, false, false);
  });
}

interface Mote {
  x: number;
  y: number;
  s: number;
  v: number;
}

function makeMotes(): Mote[] {
  return Array.from({ length: 30 }, () => ({
    x: 608 + Math.random() * 220,
    y: 70 + Math.random() * 180,
    s: Math.random() * 1.6 + 1,
    v: Math.random() * 0.2 + 0.05,
  }));
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Draws the floor every frame. It lives outside React, which would be far too slow for this. */
export class OfficeScene {
  hoverDesk: number | null = null;
  readonly walkers = new Map<string, Walker>();
  view: View = { cx: W / 2, cy: H / 2, s: 1 };
  size = { width: W, height: H };
  private readonly context: CanvasRenderingContext2D;
  private readonly motes = makeMotes();
  private frame = 0;
  private last = 0;
  private readonly onFrame: (scene: OfficeScene) => void;

  constructor(canvas: HTMLCanvasElement, onFrame: (scene: OfficeScene) => void) {
    this.context = canvas.getContext('2d')!;
    this.onFrame = onFrame;
  }

  start(): void {
    const loop = (t: number) => {
      const dt = this.last ? Math.min(50, t - this.last) : 16;
      this.last = t;
      this.sync();
      this.moveAgents(dt);
      this.draw(reducedMotion() ? 0 : t, dt);
      this.onFrame(this);
      this.frame = requestAnimationFrame(loop);
    };
    this.frame = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
  }

  matrix() {
    return viewMatrix(this.view, this.size);
  }

  screenOf(point: Point): Point {
    return toScreen(point, this.matrix());
  }

  worldOf(point: Point): Point {
    return fromScreen(point, this.matrix());
  }

  /** The agent under a point on the canvas, in screen pixels. */
  /** The empty desk at a point, or null. An agent's desk never counts, even if it's filtered out. */
  deskAt(point: Point): number | null {
    const office = useOfficeStore.getState().office;
    if (!office || office.firstRun || useOfficeUi.getState().team || this.hit(point)) return null;
    const world = this.worldOf(point);
    const desk = DESKS.findIndex(
      (position) =>
        world.x > position.x * 32 &&
        world.x < position.x * 32 + 68 &&
        world.y > position.y * 32 - 14 &&
        world.y < position.y * 32 + 52,
    );
    if (desk < 0 || office.agents.some((agent) => agent.desk === desk)) return null;
    return desk;
  }

  private drawDeskHint(theme: 'dark' | 'light'): void {
    const position = this.hoverDesk === null ? undefined : DESKS[this.hoverDesk];
    if (!position) return;
    const c = this.context;
    const hx = position.x * 32;
    const hy = position.y * 32;
    const dark = theme === 'dark';
    c.save();
    c.strokeStyle = dark ? '#EDEDEE' : '#0C0C0C';
    c.lineWidth = 1.5;
    c.setLineDash([4, 3]);
    rrect(c, hx - 2, hy - 16, 72, 70, 8);
    c.stroke();
    c.setLineDash([]);
    c.fillStyle = dark ? '#EDEDEE' : '#0C0C0C';
    ell(c, hx + 34, hy + 44, 9, 9);
    c.fillStyle = dark ? '#0C0C0C' : '#FFFFFF';
    c.fillRect(hx + 30, hy + 43, 8, 2);
    c.fillRect(hx + 33, hy + 40, 2, 8);
    c.restore();
  }

  hit(point: Point): Walker | null {
    const world = this.worldOf(point);
    const ui = useOfficeUi.getState();
    const agents = useOfficeStore.getState().office?.agents ?? [];
    let best: Walker | null = null;
    let bestDistance = 1000;
    for (const walker of this.walkers.values()) {
      if (!inScope(walker, ui, agents)) continue;
      const dx = Math.abs(world.x - walker.x);
      const dy = world.y - (walker.y - 22);
      if (dx < 20 && Math.abs(dy) < 36 && dx + Math.abs(dy) < bestDistance) {
        best = walker;
        bestDistance = dx + Math.abs(dy);
      }
    }
    return best;
  }

  /** Brings the walkers in line with the server's agents. */
  private sync(): void {
    const agents = useOfficeStore.getState().office?.agents ?? [];
    const present = new Set(agents.map((agent) => agent.id));
    for (const id of this.walkers.keys()) {
      if (!present.has(id)) this.walkers.delete(id);
    }
    const teleport = reducedMotion();
    agents.forEach((agent, index) => {
      const existing = this.walkers.get(agent.id);
      const target = spotFor(agent.state, agent.desk, index + 1);
      if (!existing) {
        const isNewHelper = this.walkers.size > 0 && agent.leadId !== null;
        const start = isNewHelper ? deskSeat(agent.desk) : target;
        this.walkers.set(agent.id, {
          ...agent,
          n: index + 1,
          x: start.x,
          y: start.y,
          path: pathTo(start, target),
          dir: 0,
          walk: 0,
          spd: 0,
          popUntil: isNewHelper ? Date.now() + 1600 : 0,
        });
        return;
      }
      const startedLeaving = agent.leaving && !existing.leaving;
      const moved =
        !agent.leaving && (existing.state !== agent.state || existing.desk !== agent.desk);
      Object.assign(existing, agent, { n: index + 1 });
      if (startedLeaving) existing.path = pathTo(existing, SPOTS.door[0]!);
      if (moved) {
        existing.path = pathTo(existing, target);
        if (teleport) {
          existing.x = target.x;
          existing.y = target.y;
          existing.path = [];
        }
      }
    });
  }

  private moveAgents(dt: number): void {
    for (const walker of this.walkers.values()) {
      const target = walker.path[0];
      if (!target) {
        walker.spd = 0;
        continue;
      }
      const dx = target.x - walker.x;
      const dy = target.y - walker.y;
      const distance = Math.hypot(dx, dy);
      walker.spd = Math.min(0.12, walker.spd + 0.0005 * dt);
      const step = walker.spd * dt;
      walker.walk += dt;
      walker.dir = Math.abs(dx) > 1 ? (dx > 0 ? 1 : -1) : 0;
      if (distance <= step) {
        walker.x = target.x;
        walker.y = target.y;
        walker.path.shift();
      } else {
        walker.x += (dx / distance) * step;
        walker.y += (dy / distance) * step;
      }
    }
  }

  private viewTarget(): View {
    const ui = useOfficeUi.getState();
    if (ui.team) {
      const lead = this.walkers.get(ui.team);
      if (lead) {
        const subs = [...this.walkers.values()].filter((item) => item.leadId === lead.id);
        return teamView([lead.desk, ...subs.map((item) => item.desk)]);
      }
    }
    if (ui.follow && ui.selected) {
      const walker = this.walkers.get(ui.selected);
      if (walker) return { cx: walker.x + 70, cy: walker.y, s: Math.max(ui.zoom, 1.6) };
    }
    return { cx: W / 2 + ui.pan.x, cy: H / 2 + ui.pan.y, s: ui.zoom };
  }

  private fitCanvas(): void {
    const canvas = this.context.canvas;
    const width = canvas.clientWidth | 0;
    const height = canvas.clientHeight | 0;
    if (width && height && (canvas.width !== width || canvas.height !== height)) {
      canvas.width = width;
      canvas.height = height;
    }
    this.size = { width: canvas.width, height: canvas.height };
  }

  private drawSurroundings(theme: 'dark' | 'light'): void {
    const c = this.context;
    const P = PAL[theme];
    const m = this.matrix();
    const { width, height } = this.size;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.imageSmoothingEnabled = false;
    // The floor and back wall run to the edges, so the office fills the whole area.
    c.fillStyle = P.floorA;
    c.fillRect(0, 0, width, height);
    const tile = 32 * m.a;
    if (tile > 4) {
      c.fillStyle = P.plank;
      for (let y = m.f % (tile * 2); y < height; y += tile * 2) {
        c.fillRect(0, Math.round(y), width, 1);
      }
    }
    const wallBottom = m.f + 64 * m.a;
    if (wallBottom > 0) {
      c.fillStyle = P.wall;
      c.fillRect(0, 0, width, wallBottom);
      c.fillStyle = P.wallTop;
      c.fillRect(0, m.f, width, 4 * m.a);
      c.fillStyle = P.base;
      c.fillRect(0, m.f + 60 * m.a, width, 4 * m.a);
      c.fillStyle = 'rgba(0,0,0,.14)';
      c.fillRect(0, wallBottom, width, 5 * m.a);
    }
  }

  private drawMotes(theme: 'dark' | 'light', t: number, dt: number): void {
    const c = this.context;
    c.fillStyle = theme === 'dark' ? 'rgba(255,255,255,.25)' : 'rgba(255,255,255,.9)';
    for (const mote of this.motes) {
      mote.y += ((mote.v * dt) / 16) * 0.35;
      mote.x += Math.sin(t / 1000 + mote.s * 3) * 0.1;
      if (mote.y > 250) {
        mote.y = 70;
        mote.x = 608 + Math.random() * 220;
      }
      c.fillRect(mote.x + (mote.y - 64) * 0.2, mote.y, mote.s, mote.s);
    }
  }

  private drawTeamOffices(walkers: Walker[], t: number, inView: (w: Walker) => boolean): void {
    const c = this.context;
    for (const lead of walkers) {
      const subs = walkers.filter((item) => item.leadId === lead.id && !item.leaving);
      if (!subs.length || !inView(lead)) continue;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const desk of [lead.desk, ...subs.map((item) => item.desk)]) {
        const position = DESKS[desk]!;
        x0 = Math.min(x0, position.x * 32 - 8);
        y0 = Math.min(y0, position.y * 32 - 20);
        x1 = Math.max(x1, position.x * 32 + 72);
        y1 = Math.max(y1, position.y * 32 + 66);
      }
      c.globalAlpha = 0.13;
      c.fillStyle = lead.hue;
      rrect(c, x0, y0, x1 - x0, y1 - y0, 12);
      c.fill();
      c.globalAlpha = 0.9;
      c.strokeStyle = lead.hue;
      c.lineWidth = 2;
      c.setLineDash([6, 5]);
      c.lineDashOffset = -t / 90;
      rrect(c, x0, y0, x1 - x0, y1 - y0, 12);
      c.stroke();
      c.setLineDash([]);
      c.globalAlpha = 1;
      const label = `${lead.name}'s office`;
      c.font = '800 10px Nunito, sans-serif';
      c.fillStyle = lead.hue;
      rrect(c, x0 + 10, y1 - 8, c.measureText(label).width + 14, 15, 5);
      c.fill();
      c.fillStyle = '#0C0C0C';
      c.fillText(label, x0 + 17, y1 + 3);
    }
  }

  private drawServerRoom(walkers: Walker[], t: number): void {
    const c = this.context;
    const running = walkers.some((item) => item.state === 'running' && !item.path.length);
    RACKS.forEach((rx, ri) => {
      for (let s2 = 0; s2 < 5; s2++) {
        const on = Math.sin(t / (running ? 90 : 420) + ri * 1.7 + s2 * 2.3) > 0.2;
        R(c, rx + 19, 81 + s2 * 8, 3, 3, on ? (s2 % 2 ? '#3FB97A' : '#F2B33D') : '#1A1B20');
        const blink = Math.sin(t / (running ? 70 : 500) + ri + s2) > 0.4;
        R(c, rx + 13, 81 + s2 * 8, 3, 3, blink ? '#5B9BF0' : '#1A1B20');
      }
      if (running) {
        c.globalAlpha = 0.06 + Math.sin(t / 120 + ri) * 0.03;
        c.fillStyle = '#5B9BF0';
        c.fillRect(rx - 2, 122, 30, 36);
        c.globalAlpha = 1;
      }
    });
    R(c, 2, 17 * 32 + 10, 6, 40, Math.sin(t / 300) > 0 ? '#6CC7D9' : '#5AB3C4');
    c.globalAlpha = 0.12;
    c.fillStyle = '#6CC7D9';
    ell(c, 14, 17 * 32 + 30, 22, 28);
    c.globalAlpha = 1;
  }

  private drawDesk(walker: Walker, t: number): void {
    const c = this.context;
    const position = DESKS[walker.desk]!;
    const x = position.x * 32;
    const y = position.y * 32;
    const here = STATE_LOCATIONS[walker.state] === 'desk' && !walker.path.length;
    let glow: string | null = null;
    if (walker.state === 'editing' && here) {
      glow = (providers[walker.provider as ProviderName] ?? providers.custom).color;
      R(c, x + 20, y - 10, 24, 14, glow);
      for (let line = 0; line < 3; line++) {
        const width = Math.round(6 + ((t / 50 + line * 7) % 10));
        R(c, x + 22, y - 8 + ((t / 60 + line * 4) % 11), width, 1, '#1A1A22');
      }
    } else if (walker.state === 'error') {
      R(c, x + 20, y - 10, 24, 14, '#5C606B');
    } else if (walker.state === 'done' && here) {
      glow = '#3FB97A';
      R(c, x + 20, y - 10, 24, 14, glow);
    } else if (walker.state === 'running' && here) {
      // Test output scrolling past, mostly green with the odd amber line.
      R(c, x + 20, y - 10, 24, 14, '#0F1A12');
      for (let line = 0; line < 4; line++) {
        const rowY = y - 8 + ((t / 90 + line * 3) % 12);
        const width = Math.round(4 + ((line * 7 + Math.floor(t / 400)) % 14));
        R(c, x + 22, rowY, width, 1, line % 3 ? '#3FB97A' : '#F2B33D');
      }
      glow = '#3FB97A';
    } else if (walker.state === 'reading' && here) {
      // A document.
      R(c, x + 20, y - 10, 24, 14, '#F4F4F2');
      for (let line = 0; line < 4; line++)
        R(c, x + 22, y - 8 + line * 3, line % 2 ? 14 : 18, 1, '#9A9A9E');
    } else if (walker.state === 'browsing' && here) {
      // A web page: a bar, a picture and two lines of text.
      R(c, x + 20, y - 10, 24, 14, '#EAF2FA');
      R(c, x + 20, y - 10, 24, 3, '#9FB3CC');
      R(c, x + 22, y - 5, 9, 6, '#5B9BF0');
      R(c, x + 33, y - 5, 9, 1, '#9A9A9E');
      R(c, x + 33, y - 2, 7, 1, '#9A9A9E');
    } else if (walker.estimate) {
      R(c, x + 20, y - 10, 24, 14, '#2A3546');
      R(c, x + 22, y - 6, 12, 1, '#9FB3CC');
      R(c, x + 22, y - 3, 16, 1, '#9FB3CC');
    }
    if (glow) {
      c.globalAlpha = 0.16;
      c.fillStyle = glow;
      ell(c, x + 32, y + 12, 30, 12);
      c.globalAlpha = 1;
    }
    if (walker.state === 'approval') {
      const lit = Math.floor(t / 400) % 2;
      R(c, x + 6, y - 2, 8, 10, '#3A2A2A');
      R(c, x + 7, y - 4, 6, 5, lit ? '#FF4D4F' : '#9E2A2C');
      if (lit) {
        c.globalAlpha = 0.18;
        c.fillStyle = '#FF4D4F';
        ell(c, x + 10, y, 26, 20);
        c.globalAlpha = 0.25;
        ell(c, x + 10, y, 12, 10);
        c.globalAlpha = 1;
      }
    }
    if (walker.queued?.length) {
      const lit = Math.floor(t / 600) % 2;
      R(c, x + 52, y - 2, 8, 8, lit ? '#F2B33D' : '#9E7420');
      if (lit) {
        c.globalAlpha = 0.25;
        c.fillStyle = '#F2B33D';
        ell(c, x + 56, y + 2, 14, 10);
        c.globalAlpha = 1;
      }
    }
  }

  private draw(t: number, dt: number): void {
    const ui = useOfficeUi.getState();
    const agents = useOfficeStore.getState().office?.agents ?? [];
    const theme = useThemeStore.getState().theme;
    const c = this.context;

    const target = clampView(this.viewTarget());
    if (!ui.team && !ui.follow) {
      const pan = { x: target.cx - W / 2, y: target.cy - H / 2 };
      if (pan.x !== ui.pan.x || pan.y !== ui.pan.y) ui.set({ pan });
    }
    const ease = Math.min(1, dt / 140);
    this.view.s += (target.s - this.view.s) * ease;
    this.view.cx += (target.cx - this.view.cx) * ease;
    this.view.cy += (target.cy - this.view.cy) * ease;

    this.fitCanvas();
    this.drawSurroundings(theme);
    const m = this.matrix();
    c.setTransform(m.a, 0, 0, m.a, m.e, m.f);
    c.drawImage(officeBackground(theme), 0, 0);
    this.drawMotes(theme, t, dt);

    const walkers = [...this.walkers.values()];
    const inView = (walker: Walker) => inScope(walker, ui, agents);
    this.drawTeamOffices(walkers, t, inView);
    this.drawServerRoom(walkers, t);
    const scoped = walkers.filter(inView);
    for (const walker of scoped) this.drawDesk(walker, t);
    this.drawDeskHint(theme);
    for (const walker of [...scoped].sort((a, b) => a.y - b.y)) {
      drawChar(c, walker, t, !matches(walker, ui), ui.selected === walker.id);
    }
    const messages = useOfficeStore.getState().office?.messages ?? [];
    const where = (id: string) => {
      const walker = this.walkers.get(id);
      return walker && inView(walker) && !walker.leaving ? { x: walker.x, y: walker.y } : null;
    };
    drawEnvelopes(c, messages, where, Date.now(), reducedMotion());
    this.drawMabariDesk(theme, t);
    c.setTransform(1, 0, 0, 1, 0, 0);
  }

  /**
   * Mabari, the office manager, at the reception desk by the door. It waves for a moment when it
   * routes a request, and its label names who got it.
   */
  private drawMabariDesk(theme: 'dark' | 'light', t: number): void {
    const c = this.context;
    const P = PAL[theme];
    const x = MABARI_DESK.x;
    const y = MABARI_DESK.y;
    blk(c, x - 46, y - 6, 92, 14, 14, P.desk, P.deskFront, P, P.deskEdge);
    const routed = useOfficeStore
      .getState()
      .office?.log.find((row) => row.agent === 'Mabari' && row.outcome.startsWith('Routed to '));
    const ping = !!routed && Date.now() - routed.time < MABARI_PING_MS;
    const scale = 1.15;
    c.save();
    c.translate(x - 16 * scale, y - 44 * scale);
    c.scale(scale, scale);
    drawMascot(c, t, {
      pose: ping ? 'wave' : 'idle',
      rig: ping ? { eyes: 'happy' } : { look: { x: Math.sin(t / 3000) * 0.6, y: -0.2 } },
      scarf: '#F4F4F4',
      dark: theme === 'dark',
    });
    c.restore();
    const label =
      ping && routed
        ? `Mabari · sent to ${routed.outcome.slice('Routed to '.length)}`
        : 'Mabari · Manager';
    c.font = '800 10px Nunito, sans-serif';
    const width = c.measureText(label).width + 16;
    c.fillStyle = 'rgba(14,13,18,.86)';
    rrect(c, x - width / 2, y + 20, width, 16, 6);
    c.fill();
    c.fillStyle = '#F5F5F5';
    c.fillText(label, x - width / 2 + 8, y + 31);
  }
}

/** Where Mabari's reception desk stands, in world pixels, as in the prototype. */
export const MABARI_DESK = { x: 608, y: 652 };
/** How long Mabari waves and names the agent after routing a request. */
const MABARI_PING_MS = 2200;
