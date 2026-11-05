// SPDX-License-Identifier: Apache-2.0
import { useOfficeStore } from '../data/officeStore.ts';
import type { AgentDef, LiveAgent } from '../gen/models.ts';
import { identityHues, providers, type ProviderName } from '../shared/tokens.ts';
import { useThemeStore } from '../theme/themeStore.ts';
import { blk, buildBg, ell, loungeProps, PAL, R, RACKS, rrect, WORK_RACKS } from './background.ts';
import {
  clampView,
  homeView,
  teamView,
  toScreen,
  viewMatrix,
  visibleWorld,
  fromScreen,
  type Size,
  type View,
} from './camera.ts';
import { drawChar } from './character.ts';
import { restingLook, stableHash } from './resting.ts';
import { drawEnvelopes } from './talk.ts';
import { drawMascot } from './vee.ts';
import {
  BASE_FLOOR,
  BASE_H,
  BASE_W,
  deskCorner,
  deskSeat,
  deskTile,
  floorFor,
  doorOf,
  loungeArea,
  loungeSeat,
  pathTo,
  onFloor,
  receptionOf,
  restKey,
  seatingFor,
  spotFor,
  STATE_LOCATIONS,
  type Floor,
  type Point,
  type Seating,
} from './layout.ts';
import { useLayers } from './layers.ts';
import { teamLinks } from './links.ts';
import {
  BETWEEN_MS,
  lastSaid,
  MABARI_PACE,
  nextVisit,
  onRound,
  projectUpdate,
  ROUND_REST_MS,
  roundDone,
  VISIT_MS,
  worthSaying,
} from './rounds.ts';
import { filesShown, inScope, matches, useOfficeUi } from './uiStore.ts';
import { useVee } from './veeStore.ts';

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
  /** Where it is heading, so it can walk again when the floor changes shape. */
  goal?: Point;
  /** When a resting agent next strolls to another spot in the lounge. */
  strollAt?: number;
  /** True while it is on one of those strolls, which is slower than walking to work. */
  strolling?: boolean;
};

/** An agent definition resting in the lounge: drawn like an agent, but not one. */
export interface Resting {
  def: AgentDef;
  walker: Walker;
}

const backgrounds: Partial<Record<'dark' | 'light', { key: string; canvas: HTMLCanvasElement }>> =
  {};

/** The painted floor, drawn again only when the theme or the floor's shape changes. */
export function officeBackground(
  theme: 'dark' | 'light',
  floor: Floor = BASE_FLOOR,
): HTMLCanvasElement {
  const cached = backgrounds[theme];
  if (cached?.key === floor.key) return cached.canvas;
  const canvas = buildBg(theme, floor);
  backgrounds[theme] = { key: floor.key, canvas };
  return canvas;
}

/** The welcome screen's office: five desks in use and the free one, the lounge and the meeting room. */
const HERO_FLOOR = floorFor({ taken: [0, 1, 2, 5, 6], working: [0, 1, 2, 5, 6] }, 1, ['meeting']);
const HERO_AGENTS = [
  { ...deskSeat({ desk: 0 }), provider: 'claude', state: 'editing' },
  { ...deskSeat({ desk: 1 }), provider: 'openai', state: 'thinking' },
  { ...deskSeat({ desk: 5 }), provider: 'custom', state: 'browsing' },
  { ...loungeSeat(HERO_FLOOR, 0), provider: 'claude', state: 'idle' },
  { ...deskSeat({ desk: 6 }), provider: 'openai', state: 'approval' },
];
const HERO_SKINS = ['#F2C9A0', '#D9A27A', '#B07850', '#8C5A3A', '#6B4128'];
const HERO_HAIR = ['#2A1B12', '#5A3A22', '#101010', '#B5651D', '#D9C27A'];

/** The still picture on the welcome screen: the office with five agents at work. */
export function paintHero(c: CanvasRenderingContext2D, theme: 'dark' | 'light'): void {
  const canvas = c.canvas;
  if (canvas.width !== HERO_FLOOR.width || canvas.height !== HERO_FLOOR.height) {
    canvas.width = HERO_FLOOR.width;
    canvas.height = HERO_FLOOR.height;
    canvas.style.aspectRatio = `${HERO_FLOOR.width}/${HERO_FLOOR.height}`;
  }
  c.imageSmoothingEnabled = false;
  c.drawImage(officeBackground(theme, HERO_FLOOR), 0, 0);
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

/** Dust in a shaft of light over the desks, from the middle of the work area. */
const moteX = (floor: Floor) => floor.door - 110 + Math.random() * 220;

function makeMotes(): Mote[] {
  return Array.from({ length: 30 }, () => ({
    x: moteX(BASE_FLOOR),
    y: 70 + Math.random() * 180,
    s: Math.random() * 1.6 + 1,
    v: Math.random() * 0.2 + 0.05,
  }));
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const sizeOf = (floor: Floor): Size => ({ width: floor.width, height: floor.height });

/** Draws the floor every frame. It lives outside React, which would be far too slow for this. */
export class OfficeScene {
  hoverDesk: number | null = null;
  readonly walkers = new Map<string, Walker>();
  /** Agent definitions resting in the lounge, in seat order. */
  resting: Resting[] = [];
  seating: Seating = seatingFor([], []);
  private seatedFrom: { agents: LiveAgent[]; defs: AgentDef[]; inRooms: boolean; view: number } = {
    agents: [],
    defs: [],
    inRooms: false,
    view: 0,
  };
  view: View = { cx: BASE_W / 2, cy: BASE_H / 2, s: 1 };
  size = { width: BASE_W, height: BASE_H };
  /** The floor's size last frame, to notice it changing. */
  private world: Size = { width: BASE_W, height: BASE_H };
  private readonly restingById = new Map<string, Walker>();
  /**
   * Mabari, the office manager, on its rounds: where it is, where it's walking, who it's with
   * and until when, and who it saw last.
   */
  readonly manager = {
    x: 0,
    y: 0,
    path: [] as Point[],
    dir: 0,
    walk: 0,
    placed: false,
    visiting: null as string | null,
    until: 0,
    /** Until when it stands still: between visits, or resting at its desk after a round. */
    restUntil: 0,
    last: null as string | null,
  };
  /** Mabari's label, drawn over the floor in overlays.ts, and whether it's at its desk. */
  mabariLabel = 'Mabari · Manager';
  mabariHome = true;
  private readonly context: CanvasRenderingContext2D;
  private readonly motes = makeMotes();
  private frame = 0;
  private last = 0;
  private readonly onFrame: (scene: OfficeScene) => void;

  constructor(canvas: HTMLCanvasElement, onFrame: (scene: OfficeScene) => void) {
    this.context = canvas.getContext('2d')!;
    this.onFrame = onFrame;
  }

  get floor(): Floor {
    return this.seating.floor;
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
    return viewMatrix(this.view, this.size, sizeOf(this.floor));
  }

  /** How much of the office shows at 100%, in world pixels. */
  visible(): Size {
    return visibleWorld(this.size);
  }

  /** Whether the office reaches past the view, so dragging moves along it. */
  canPan(): boolean {
    const visible = this.visible();
    const zoom = useOfficeUi.getState().zoom;
    return (
      zoom > 1 || visible.width < this.floor.width - 1 || visible.height < this.floor.height - 1
    );
  }

  /**
   * Which stretch of the office's width is in view, as shares of it from 0 to 1, for the scroll
   * bar under a wide office. Null when it all shows.
   */
  span(): { from: number; to: number } | null {
    const width = this.floor.width;
    const shown = this.visible().width / this.view.s;
    if (shown >= width - 1) return null;
    const from = Math.max(0, this.view.cx - shown / 2) / width;
    return { from, to: Math.min(1, from + shown / width) };
  }

  /** Moves the view along a wide office, so this share of its width is in the middle. */
  centreAt(share: number): void {
    const ui = useOfficeUi.getState();
    const home = homeView(this.size, sizeOf(this.floor));
    ui.set({
      follow: false,
      team: null,
      pan: { x: share * this.floor.width - home.x, y: ui.pan.y },
    });
  }

  screenOf(point: Point): Point {
    return toScreen(point, this.matrix());
  }

  worldOf(point: Point): Point {
    return fromScreen(point, this.matrix());
  }

  /**
   * The free desk, if it is at this point: the one empty desk on the floor. Clicking it starts a
   * new agent there, with what it should do.
   */
  deskAt(point: Point): number | null {
    const office = useOfficeStore.getState().office;
    if (!office || office.firstRun || useOfficeUi.getState().team || this.hit(point)) return null;
    const world = this.worldOf(point);
    const desk = this.floor.free;
    const position = deskTile(desk);
    const over =
      world.x > position.x * 32 &&
      world.x < position.x * 32 + 68 &&
      world.y > position.y * 32 - 14 &&
      world.y < position.y * 32 + 52;
    return over && !office.agents.some((agent) => agent.desk === desk) ? desk : null;
  }

  private drawDeskHint(theme: 'dark' | 'light'): void {
    if (this.hoverDesk === null) return;
    const position = deskTile(this.hoverDesk);
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

  /** The agent under a point on the canvas, in screen pixels. */
  hit(point: Point): Walker | null {
    const world = this.worldOf(point);
    const ui = useOfficeUi.getState();
    const agents = onFloor(useOfficeStore.getState().office?.agents ?? []);
    // A bigger office is drawn smaller, so the target never gets smaller than a fingertip.
    const { reachX, reachY } = this.reach();
    let best: Walker | null = null;
    let bestDistance = 1000;
    for (const walker of this.walkers.values()) {
      if (!inScope(walker, ui, agents)) continue;
      const dx = Math.abs(world.x - walker.x);
      const dy = world.y - (walker.y - 22);
      if (dx < reachX && Math.abs(dy) < reachY && dx + Math.abs(dy) < bestDistance) {
        best = walker;
        bestDistance = dx + Math.abs(dy);
      }
    }
    return best;
  }

  /** The resting agent definition under a point on the canvas, or null. Agents come first. */
  restingAt(point: Point): AgentDef | null {
    if (!this.restingShown() || this.hit(point)) return null;
    const world = this.worldOf(point);
    const { reachX, reachY } = this.reach();
    for (const { def, walker } of this.resting) {
      const dx = Math.abs(world.x - walker.x);
      if (dx < reachX && Math.abs(world.y - (walker.y - 22)) < reachY) return def;
    }
    return null;
  }

  /** How far from a character a click still picks it, in world pixels: at least 26 by 40 on screen. */
  private reach() {
    const scale = this.matrix().a;
    return { reachX: Math.max(20, 26 / scale), reachY: Math.max(36, 40 / scale) };
  }

  /** Resting definitions belong to no project or team, so a filter on either hides them. */
  restingShown(): boolean {
    return filesShown(useOfficeUi.getState());
  }

  /** Brings the walkers in line with the server's agents, and seats everyone. */
  private sync(): void {
    const office = useOfficeStore.getState().office;
    const agents = onFloor(office?.agents ?? []);
    const defs = office?.defs ?? [];
    // The store replaces these lists when they change, so the seating is worked out only then,
    // and when the last agent walks out of a room, which stays open until then.
    // Only an agent that went to a room keeps it open, not one resting nearby.
    const wall = this.floor.wall;
    const inRooms =
      wall !== null &&
      [...this.walkers.values()].some(
        (walker) => walker.x > wall && STATE_LOCATIONS[walker.state] !== 'lounge',
      );
    // The floor fills at least the view, half work area and half lounge, so it's worked out
    // again whenever the half the view sets changes, a tile at a time.
    const view = Math.round(this.visible().width);
    if (
      agents !== this.seatedFrom.agents ||
      defs !== this.seatedFrom.defs ||
      inRooms !== this.seatedFrom.inRooms ||
      Math.floor(view / 64) !== Math.floor(this.seatedFrom.view / 64)
    ) {
      const before = this.floor;
      this.seating = seatingFor(agents, defs, inRooms ? this.floor.rooms : [], view);
      this.seatedFrom = { agents, defs, inRooms, view };
      this.reshaped(before, this.floor);
    }
    const floor = this.floor;
    const present = new Set(agents.map((agent) => agent.id));
    for (const id of this.walkers.keys()) {
      if (!present.has(id)) this.walkers.delete(id);
    }
    const teleport = reducedMotion();
    agents.forEach((agent, index) => {
      const existing = this.walkers.get(agent.id);
      const target = spotFor(agent, index + 1, this.seating);
      if (!existing) {
        const isNewHelper = this.walkers.size > 0 && agent.leadId !== null;
        const start = isNewHelper ? deskSeat(agent) : target;
        this.walkers.set(agent.id, {
          ...agent,
          n: index + 1,
          x: start.x,
          y: start.y,
          path: pathTo(start, target, floor),
          dir: 0,
          walk: 0,
          spd: 0,
          popUntil: isNewHelper ? Date.now() + 1600 : 0,
          goal: target,
        });
        return;
      }
      const startedLeaving = agent.leaving && !existing.leaving;
      const goal = existing.goal;
      const moved =
        !agent.leaving &&
        (existing.state !== agent.state ||
          existing.desk !== agent.desk ||
          !goal ||
          Math.abs(goal.x - target.x) > 0.5 ||
          Math.abs(goal.y - target.y) > 0.5);
      Object.assign(existing, agent, { n: index + 1 });
      if (startedLeaving) existing.path = pathTo(existing, doorOf(floor), floor);
      if (moved) {
        existing.goal = target;
        existing.path = pathTo(existing, target, floor);
        if (teleport) {
          existing.x = target.x;
          existing.y = target.y;
          existing.path = [];
        }
      }
    });
    this.syncResting();
  }

  /**
   * After the floor changed shape: whoever rests moves with the lounge at once, so nobody is left
   * inside the work area's walls, and everyone still walking, Mabari too, takes a new route
   * through the doorway where it is now. The dust shaft moves with the work area.
   */
  private reshaped(before: Floor, after: Floor): void {
    if (
      before.width === after.width &&
      before.workEnd === after.workEnd &&
      before.door === after.door &&
      before.lounge?.x === after.lounge?.x
    ) {
      return;
    }
    const dx = before.lounge && after.lounge ? after.lounge.x - before.lounge.x : 0;
    const lounging = [
      ...[...this.walkers.values()].filter(
        (walker) => STATE_LOCATIONS[walker.state] === 'lounge' && !walker.leaving,
      ),
      ...this.resting.map((item) => item.walker),
    ];
    for (const walker of lounging) {
      walker.x += dx;
      if (walker.goal) walker.goal = { x: walker.goal.x + dx, y: walker.goal.y };
      walker.path = [];
      walker.strolling = false;
    }
    for (const walker of this.walkers.values()) {
      const end = walker.path.at(-1);
      if (!end) continue;
      walker.path = pathTo(walker, walker.leaving ? doorOf(after) : (walker.goal ?? end), after);
    }
    const m = this.manager;
    const end = m.path.at(-1);
    if (end) m.path = pathTo(m, end, after);
    for (const mote of this.motes) mote.x += after.door - before.door;
  }

  /** Seats the resting definitions, keeping each one's walker so it bobs on its own time. */
  private syncResting(): void {
    const seen = new Set<string>();
    this.resting = this.seating.resting.map((def) => {
      seen.add(def.id);
      const seat = loungeSeat(this.floor, this.seating.lounge.get(restKey(def)) ?? 0);
      let walker = this.restingById.get(def.id);
      if (!walker) {
        const look = restingLook(def);
        walker = {
          id: restKey(def),
          name: def.name,
          state: 'idle',
          n: stableHash(def.id) % 1000,
          path: [],
          dir: 0,
          walk: 0,
          spd: 0,
          popUntil: 0,
          front: true,
          ...look,
        } as unknown as Walker;
        this.restingById.set(def.id, walker);
      }
      // A new resident starts at its own spot, and goes back to it when the lounge moves.
      const goal = walker.goal;
      if (!goal || Math.abs(goal.x - seat.x) > 0.5 || Math.abs(goal.y - seat.y) > 0.5) {
        if (!goal || reducedMotion()) {
          walker.x = seat.x;
          walker.y = seat.y;
          walker.path = [];
        } else {
          walker.path = [{ x: seat.x, y: seat.y }];
        }
        walker.goal = seat;
      }
      return { def, walker };
    });
    for (const id of this.restingById.keys()) {
      if (!seen.has(id)) this.restingById.delete(id);
    }
  }

  /**
   * Agents resting in the lounge don't sit still: now and then each strolls to another spot on
   * the lounge's rug, and stops there with its coffee. Not with reduced motion.
   */
  private wander(now: number): void {
    const area = loungeArea(this.floor);
    if (!area || reducedMotion()) return;
    const lounging = [
      ...[...this.walkers.values()].filter(
        (walker) => STATE_LOCATIONS[walker.state] === 'lounge' && !walker.leaving,
      ),
      ...this.resting.map((item) => item.walker),
    ];
    // Only a few stroll at once, so the lounge is alive but never busy.
    let strolling = lounging.filter((walker) => walker.strolling && walker.path.length).length;
    const most = lounging.length > 6 ? 2 : 1;
    for (const walker of lounging) {
      if (walker.path.length) continue;
      walker.strolling = false;
      if (!walker.strollAt) {
        walker.strollAt = now + 6000 + ((walker.n * 977) % 14000);
        continue;
      }
      if (now < walker.strollAt || strolling >= most) continue;
      // A short stroll from where it stands, to another spot on the rug.
      const reach = 70;
      const spot = {
        x: Math.min(area.x1, Math.max(area.x0, walker.x + (Math.random() * 2 - 1) * reach)),
        y: Math.min(area.y1, Math.max(area.y0, walker.y + (Math.random() * 2 - 1) * reach * 0.6)),
      };
      walker.path = [spot];
      walker.strolling = true;
      walker.strollAt = now + 14000 + Math.random() * 16000;
      strolling++;
    }
  }

  /**
   * Mabari's rounds: it walks to each agent at work in turn, project by project, stays by its
   * desk a moment to check in, and says how that project is doing in its updates. With nobody at
   * work it goes back to its desk by the door.
   */
  private doRounds(now: number, dt: number): void {
    const m = this.manager;
    const floor = this.floor;
    const home = receptionOf(floor);
    const teleport = reducedMotion();
    if (!m.placed) {
      m.x = home.x;
      m.y = home.y;
      m.placed = true;
    }
    const target = m.path[0];
    if (target) {
      const dx = target.x - m.x;
      const dy = target.y - m.y;
      const distance = Math.hypot(dx, dy);
      const step = MABARI_PACE * dt;
      m.walk += dt;
      m.dir = Math.abs(dx) > 1 ? Math.sign(dx) : m.dir;
      if (teleport || distance <= step) {
        m.x = target.x;
        m.y = target.y;
        m.path.shift();
        if (!m.path.length && m.visiting) m.until = now + VISIT_MS;
      } else {
        m.x += (dx / distance) * step;
        m.y += (dy / distance) * step;
      }
      return;
    }
    const office = useOfficeStore.getState().office;
    const agents = onFloor(office?.agents ?? []);
    // Sessions running as Mabari, the default agent, are on the round like any agent at work:
    // each works in its own project.
    const round = onRound(agents);
    if (m.visiting) {
      const still = round.some((agent) => agent.id === m.visiting);
      if (still && now < m.until) return;
      const seen = agents.find((agent) => agent.id === m.visiting);
      if (seen) {
        const key = seen.projectId ?? '';
        const project = office?.projects.find((item) => item.id === seen.projectId) ?? null;
        const text = projectUpdate(project, agents, seen.projectId ?? null);
        if (worthSaying(text, lastSaid.get(key), now)) {
          lastSaid.set(key, { text, at: now });
          useVee.getState().report(key, text);
        }
      }
      m.visiting = null;
      m.restUntil = now + BETWEEN_MS;
    }
    if (now < m.restUntil) return;
    const next = nextVisit(round, m.last);
    const walker = next ? this.walkers.get(next.id) : undefined;
    if (!next || !walker || walker.path.length) {
      if (!next && Math.hypot(m.x - home.x, m.y - home.y) > 2) m.path = pathTo(m, home, floor);
      return;
    }
    // After a whole round it goes back to its desk and rests a while before the next.
    if (roundDone(round, m.last, next)) {
      m.last = null;
      m.restUntil = now + ROUND_REST_MS;
      if (Math.hypot(m.x - home.x, m.y - home.y) > 2) m.path = pathTo(m, home, floor);
      return;
    }
    // It stands beside the agent's chair, in the gap before the next desk.
    const spot = { x: walker.x + 46, y: walker.y + 2 };
    m.visiting = next.id;
    m.last = next.id;
    m.until = now + VISIT_MS;
    m.path = pathTo(m, spot, floor);
  }

  /**
   * Whether a point on the canvas is on Mabari, wherever its rounds have taken it. Like an
   * agent, it never gets smaller than a fingertip to click, and where it stands beside an agent,
   * whichever is nearer the point wins.
   */
  mabariAt(point: Point): boolean {
    const world = this.worldOf(point);
    const m = this.manager;
    const { reachX, reachY } = this.reach();
    const dx = Math.abs(world.x - m.x);
    if (dx > Math.max(22, reachX) || Math.abs(world.y - (m.y - 22)) > Math.max(34, reachY)) {
      return false;
    }
    const agent = this.hit(point);
    return !agent || dx < Math.abs(world.x - agent.x);
  }

  private moveAgents(dt: number): void {
    this.wander(Date.now());
    this.doRounds(Date.now(), dt);
    for (const walker of [...this.walkers.values(), ...this.resting.map((item) => item.walker)]) {
      const target = walker.path[0];
      if (!target) {
        walker.spd = 0;
        continue;
      }
      const dx = target.x - walker.x;
      const dy = target.y - walker.y;
      const distance = Math.hypot(dx, dy);
      // A stroll in the lounge is slower than walking to work.
      walker.spd = Math.min(walker.strolling ? 0.04 : 0.12, walker.spd + 0.0005 * dt);
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
    const floor = this.floor;
    if (ui.team) {
      const lead = this.walkers.get(ui.team);
      if (lead) {
        const subs = [...this.walkers.values()].filter((item) => item.leadId === lead.id);
        return teamView(
          [lead, ...subs].map((item) => deskCorner(item)),
          this.visible(),
        );
      }
    }
    if (ui.follow && ui.selected) {
      const walker = this.walkers.get(ui.selected);
      if (walker) return { cx: walker.x + 70, cy: walker.y, s: Math.max(ui.zoom, 1.6) };
    }
    const home = homeView(this.size, sizeOf(floor));
    return { cx: home.x + ui.pan.x, cy: home.y + ui.pan.y, s: ui.zoom };
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
    // Tests read the floor's size, and where the free desk is, to find things on it.
    const world = `${this.floor.width}x${this.floor.height}`;
    if (canvas.dataset.world !== world) canvas.dataset.world = world;
    const tile = deskTile(this.floor.free);
    const free = `${tile.x * 32 + 34},${tile.y * 32 + 20}`;
    if (canvas.dataset.freeDesk !== free) canvas.dataset.freeDesk = free;
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
        mote.x = moteX(this.floor);
      }
      c.fillRect(mote.x + (mote.y - 64) * 0.2, mote.y, mote.s, mote.s);
    }
  }

  /**
   * The lounge's small motions: steam from the coffee machine, the floor lamp's warm glow, and
   * fish and bubbles in the tank. With reduced motion, t stays at 0 and they hold still.
   */
  private drawLoungeLife(theme: 'dark' | 'light', t: number): void {
    const props = loungeProps(this.floor);
    if (!props) return;
    const c = this.context;
    // A soft pool of light under the lamp, breathing slowly.
    c.save();
    c.globalAlpha = (theme === 'dark' ? 0.1 : 0.16) + Math.sin(t / 1800) * 0.02;
    c.fillStyle = '#FFE7A8';
    c.beginPath();
    c.ellipse(props.lamp.x + 1, props.lamp.y + 30, 30, 18, 0, 0, Math.PI * 2);
    c.fill();
    c.restore();
    // Steam rising from the machine.
    c.fillStyle = theme === 'dark' ? 'rgba(255,255,255,.35)' : 'rgba(120,120,128,.35)';
    for (let puff = 0; puff < 3; puff++) {
      const rise = ((t / 40 + puff * 9) % 27) / 27;
      const px = props.machine.x + 1 + Math.sin(t / 300 + puff * 2) * 2;
      const py = props.machine.y - 2 - rise * 16;
      c.globalAlpha = 1 - rise;
      c.fillRect(Math.round(px), Math.round(py), 2, 2);
    }
    c.globalAlpha = 1;
    // Fish and bubbles in the tank.
    const tank = props.tank;
    if (!tank) return;
    const fish = [
      { colour: theme === 'dark' ? '#8FC1CF' : '#3E7C8F', speed: 9000, depth: 0.3, phase: 0 },
      { colour: theme === 'dark' ? '#C9D6DF' : '#6B7F8F', speed: 13000, depth: 0.6, phase: 0.45 },
    ];
    for (const one of fish) {
      const lap = ((t / one.speed + one.phase) % 1) * 2;
      const forward = lap < 1;
      const along = forward ? lap : 2 - lap;
      const fx = tank.x + 4 + along * (tank.w - 14);
      const fy = tank.y + 3 + one.depth * (tank.h - 10) + Math.sin(t / 700 + one.phase * 9);
      c.fillStyle = one.colour;
      c.fillRect(Math.round(fx), Math.round(fy), 5, 3);
      c.fillRect(Math.round(forward ? fx - 2 : fx + 5), Math.round(fy), 2, 3);
    }
    c.fillStyle = 'rgba(255,255,255,.55)';
    for (let bubble = 0; bubble < 3; bubble++) {
      const rise = ((t / 60 + bubble * 7) % 20) / 20;
      c.fillRect(
        Math.round(tank.x + tank.w - 10 + Math.sin(t / 400 + bubble) * 1.5),
        Math.round(tank.y + tank.h - 5 - rise * (tank.h - 7)),
        1,
        1,
      );
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
      for (const member of [lead, ...subs]) {
        const position = deskCorner(member);
        x0 = Math.min(x0, position.x - 8);
        y0 = Math.min(y0, position.y - 20);
        x1 = Math.max(x1, position.x + 72);
        y1 = Math.max(y1, position.y + 66);
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

  /** Colours for the links, read from the theme's tokens once per theme. */
  private linkInk: { theme: string; line: string; live: string; node: string } | null = null;

  /**
   * The "Connections between agents" layer: a line from each lead to each of its subagents, as
   * the spotlight draws them, so a subagent seated far from its lead still shows whose it is.
   * Quiet when the subagent waits, moving in the accent colour while it works.
   */
  private drawLinks(walkers: Walker[], theme: 'dark' | 'light', t: number): void {
    if (!useLayers.getState().layers.link) return;
    const links = teamLinks(walkers);
    if (!links.length) return;
    if (this.linkInk?.theme !== theme) {
      const style = getComputedStyle(document.documentElement);
      const token = (name: string, fallback: string) =>
        style.getPropertyValue(name).trim() || fallback;
      this.linkInk = {
        theme,
        line: token('--fg2', '#8E8E93'),
        live: token('--accent', '#5B9BF0'),
        node: token('--surface', '#FFFFFF'),
      };
    }
    const ink = this.linkInk;
    const c = this.context;
    c.lineWidth = 1.5;
    for (const link of links) {
      c.globalAlpha = link.live ? 0.95 : 0.55;
      c.strokeStyle = link.live ? ink.live : ink.line;
      c.setLineDash(link.live ? [5, 4] : [2, 4]);
      c.lineDashOffset = link.live ? -((t / 55) % 18) : 0;
      c.beginPath();
      c.moveTo(link.from.x, link.from.y);
      c.quadraticCurveTo(link.bend.x, link.bend.y, link.to.x, link.to.y);
      c.stroke();
      c.setLineDash([]);
      for (const end of [link.from, link.to]) {
        c.beginPath();
        c.arc(end.x, end.y, 3, 0, Math.PI * 2);
        c.fillStyle = link.live ? ink.live : ink.node;
        c.fill();
        c.stroke();
      }
    }
    c.globalAlpha = 1;
    c.lineDashOffset = 0;
  }

  private drawServerRoom(walkers: Walker[], t: number): void {
    const c = this.context;
    // The work area's racks blink slowly, a little quicker while anyone is running something.
    const busy = walkers.some((item) => item.state === 'running' && !item.path.length);
    WORK_RACKS.forEach((rx, ri) => {
      for (let slot = 0; slot < 5; slot++) {
        const on = Math.sin(t / (busy ? 260 : 900) + ri * 1.7 + slot * 2.3) > 0.2;
        R(c, rx + 19, 63 + slot * 8, 3, 3, on ? (slot % 2 ? '#3FB97A' : '#5B9BF0') : '#1A1B20');
      }
    });
    const running = walkers.some((item) => item.state === 'running' && !item.path.length);
    if (!this.floor.rooms.includes('server')) return;
    const shift = this.floor.shift;
    RACKS.forEach((at, ri) => {
      const rx = at + shift;
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
  }

  private drawDesk(walker: Walker, t: number): void {
    const c = this.context;
    const position = deskCorner(walker);
    const x = position.x;
    const y = position.y;
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
    } else if (walker.working) {
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
    const agents = onFloor(useOfficeStore.getState().office?.agents ?? []);
    const theme = useThemeStore.getState().theme;
    const c = this.context;
    const floor = this.floor;
    const world = sizeOf(floor);
    // When the floor grows or shrinks, the view moves with it at once rather than easing over,
    // so nothing slides across the screen and what you were looking at stays put.
    if (world.width !== this.world.width || world.height !== this.world.height) {
      const before = homeView(this.size, this.world);
      const after = homeView(this.size, world);
      this.view.cx += after.x - before.x;
      this.view.cy += after.y - before.y;
      this.world = world;
    }

    const target = clampView(this.viewTarget(), world, this.visible());
    if (!ui.team && !ui.follow) {
      const home = homeView(this.size, world);
      const pan = { x: target.cx - home.x, y: target.cy - home.y };
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
    c.drawImage(officeBackground(theme, floor), 0, 0);
    this.drawMotes(theme, t, dt);
    this.drawLoungeLife(theme, t);

    const walkers = [...this.walkers.values()];
    const inView = (walker: Walker) => inScope(walker, ui, agents);
    this.drawTeamOffices(walkers, t, inView);
    this.drawServerRoom(walkers, t);
    const scoped = walkers.filter(inView);
    // A desk's screen shows only on a desk that is on the floor.
    for (const walker of scoped) {
      if (floor.desks.includes(walker.desk)) this.drawDesk(walker, t);
    }
    this.drawDeskHint(theme);
    this.drawLinks(scoped, theme, t);
    // Everyone is drawn from back to front.
    const restingShown = this.restingShown();
    // An agent running Mabari's own agent file is Mabari, so it looks like Mabari.
    const office = useOfficeStore.getState().office;
    const mabariFiles = new Set(
      (office?.defs ?? []).filter((def) => def.system).map((def) => def.id),
    );
    const figures: { y: number; paint: () => void }[] = scoped.map((walker) => ({
      y: walker.y,
      paint: () =>
        mabariFiles.has(walker.defId)
          ? drawMabariAt(c, walker.x, walker.y, 1, t, theme, {
              pose: walker.working ? 'work' : 'idle',
              turn: walker.path.length ? walker.dir * 0.7 : 0,
              happy: false,
              dim: !matches(walker, ui),
              ring: ui.selected === walker.id ? walker.hue : '',
            })
          : drawChar(c, walker, t, !matches(walker, ui), ui.selected === walker.id),
    }));
    if (restingShown) {
      for (const { walker } of this.resting) {
        figures.push({ y: walker.y, paint: () => drawChar(c, walker, t, false, false) });
      }
    }
    figures.sort((a, b) => a.y - b.y);
    for (const figure of figures) figure.paint();
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
   * Mabari, the office manager: its desk by the door, and Mabari wherever its rounds have taken
   * it. It waves for a moment when it routes a request, and its label says what it's doing.
   */
  private drawMabariDesk(theme: 'dark' | 'light', t: number): void {
    const c = this.context;
    const P = PAL[theme];
    const desk = receptionOf(this.floor);
    blk(c, desk.x - 46, desk.y - 6, 92, 14, 14, P.desk, P.deskFront, P, P.deskEdge);
    const m = this.manager;
    const routed = useOfficeStore
      .getState()
      .office?.log.find((row) => row.agent === 'Mabari' && row.outcome.startsWith('Routed to '));
    const ping = !!routed && Date.now() - routed.time < MABARI_PING_MS;
    const visiting = m.visiting && !m.path.length ? this.walkers.get(m.visiting) : undefined;
    const walking = m.path.length > 0;
    drawMabariAt(c, m.x, m.y, 1.15, t, theme, {
      pose: ping || visiting ? (ping || t % 4000 < 900 ? 'wave' : 'ask') : 'idle',
      turn: walking ? m.dir * 0.7 : visiting ? -0.5 : 0,
      happy: ping,
      dim: false,
      ring: '',
    });
    this.mabariLabel =
      ping && routed
        ? `Mabari · sent to ${routed.outcome.slice('Routed to '.length)}`
        : visiting
          ? `Mabari · checking in with ${visiting.name}`
          : 'Mabari · Manager';
    this.mabariHome = Math.hypot(m.x - desk.x, m.y - desk.y) < 2;
  }
}

/** Mabari's mascot with its feet at x, y. Mabari always looks like this, whatever it does. */
function drawMabariAt(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  t: number,
  theme: 'dark' | 'light',
  look: {
    pose: 'idle' | 'wave' | 'ask' | 'work';
    turn: number;
    happy: boolean;
    /** Faded, as agents a filter leaves out are. */
    dim: boolean;
    /** The selection ring's colour, or empty when it isn't selected. */
    ring: string;
  },
): void {
  c.save();
  if (look.dim) c.globalAlpha = 0.2;
  if (look.ring && !look.dim) {
    c.strokeStyle = look.ring;
    c.lineWidth = 2;
    c.beginPath();
    c.ellipse(x, y, 17 + Math.sin(t / 250), 7, 0, 0, Math.PI * 2);
    c.stroke();
  }
  c.translate(x - 16 * scale, y - 44 * scale);
  c.scale(scale, scale);
  drawMascot(c, t, {
    pose: look.pose,
    rig: {
      turn: look.turn,
      ...(look.happy
        ? { eyes: 'happy' }
        : { look: { x: look.turn || Math.sin(t / 3000) * 0.6, y: -0.2 } }),
    },
    scarf: '#F4F4F4',
    dark: theme === 'dark',
  });
  c.restore();
}

/** How long Mabari waves and names the agent after routing a request. */
const MABARI_PING_MS = 2200;
