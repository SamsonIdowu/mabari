// SPDX-License-Identifier: Apache-2.0
import { clockText, etaLong, etaShort, modelLabel, STATE_CHIPS, stateLabel } from '../format.ts';
import { MabariDef, type LiveAgent } from '../gen/models.ts';
import { decisionColors, decisionLabels, providers, type ProviderName } from '../shared/tokens.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import { R } from './background.ts';
import {
  bubbleBox,
  MAX_SETTLE,
  PINNED_RANK,
  placeBubbles,
  tagBox,
  type Box,
  type BubbleItem,
} from './bubbles.ts';
import { drawChar } from './character.ts';
import { restingLook } from './resting.ts';
import type { OfficeScene, Walker } from './scene.ts';
import { chipFor } from './talk.ts';
import { inScope, matches, useOfficeUi } from './uiStore.ts';
import { whereWorking } from './where.ts';

const STEP_LABELS: Record<string, string> = {
  read_file: 'Read',
  edit_file: 'Edit',
  run_shell: 'Shell',
  web_search: 'Browse',
  think: 'Plan',
  spawn_agent: 'Subagent',
  approval: 'Approval',
  instruction: 'Your instruction',
  finish: 'Finished',
  start: 'Started',
  retry: 'Retry',
  interrupt: 'Interrupted',
  message: 'Message',
};

function esc(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/** Only touches the DOM when the content changed, because this runs every frame. */
function setHtml(element: Element, html: string): void {
  const cached = element as Element & { lastHtml?: string };
  if (cached.lastHtml !== html) {
    element.innerHTML = html;
    cached.lastHtml = html;
  }
}

const providerClass = (agent: LiveAgent) =>
  providers[agent.provider as ProviderName]?.cssClass ?? 'p-custom';

function fmtClock(value: number): string {
  const seconds = Math.max(0, Math.round(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${hours ? `${hours}:${pad(minutes)}` : minutes}:${pad(seconds % 60)}`;
}

const fmtK = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value));

/** How much tags and bubbles are drawn at, for an office zoom: they grow and shrink with it. */
function overlayScale(zoom: number): number {
  return Number(Math.max(0.72, Math.min(1.6, zoom / 1.05)).toFixed(2));
}

/** Name tags and speech bubbles, positioned over the canvas every frame. */
/** Tags and bubbles grow and shrink with the office, and quiet bubbles hide when it's small. */
function scaleTags(layer: HTMLElement, scene: OfficeScene): void {
  const overlay = layer.closest<HTMLElement>('.ovl');
  if (!overlay) return;
  const zoom = scene.matrix().a;
  // On a big floor drawn very small, tags show only names, so neighbours don't run together.
  overlay.classList.toggle('tiny', zoom < 0.6);
  const scale = overlayScale(zoom).toFixed(2);
  if (overlay.dataset.oz === scale) return;
  overlay.dataset.oz = scale;
  overlay.style.setProperty('--oz', scale);
  overlay.classList.toggle('far', Number(scale) < 0.86);
}

/**
 * An element's size before the overlay's scaling, measured only when what is in it changed:
 * this runs every frame, and reading a size forces the page to lay out. A bubble that is not
 * showing is shown for the moment it takes to measure. Null when it takes no room at all.
 */
interface Size {
  key: string;
  width: number;
  height: number;
  /** For a bubble: its height cut to one line, with the class `one`. */
  oneLine: number;
}
const measured = new WeakMap<Element, Size>();
function sizeOf(element: HTMLElement, key: string): Size | null {
  const known = measured.get(element);
  if (known?.key === key) return known;
  const wasHidden = element.hidden;
  const wasOne = element.classList.contains('one');
  element.hidden = false;
  element.classList.remove('one');
  const size: Size = { key, width: element.offsetWidth, height: element.offsetHeight, oneLine: 0 };
  element.classList.add('one');
  size.oneLine = element.offsetHeight;
  element.classList.toggle('one', wasOne);
  element.hidden = wasHidden;
  if (!size.width && !size.height) {
    measured.delete(element);
    return null;
  }
  measured.set(element, size);
  return size;
}

/** The bubbles that were cut to one line last frame, so this frame draws them that way again. */
const cutShort = new WeakSet<Element>();

/** What one agent's bubble and tag need from the placing pass, once their content is in. */
interface Placing {
  id: string;
  bubble: HTMLElement;
  tag: HTMLElement;
  /** Where the tag hangs from, and where the bubble sits when nothing is in its way, in pixels. */
  at: { x: number; y: number };
  bubbleAt: { x: number; y: number };
  /** How far the bubble may come down towards its agent, in pixels. */
  settle: number;
  rank: number;
  /** Not wanted at all: nothing to say, walking, or in the spotlight. */
  quiet: boolean;
  /** May be cut to one line to make room. A reply is read in full, and an approval is brief. */
  shortenable: boolean;
  tagKey: string;
  bubbleKey: string;
}

/** A session running as Mabari, the default agent, is "Mabari · Shop", after its folder. */
const shownName = (agent: Pick<LiveAgent, 'name' | 'defId'>) =>
  agent.defId === MabariDef ? `Mabari · ${agent.name}` : agent.name;

function renderTags(layer: HTMLElement, scene: OfficeScene, agents: LiveAgent[]): void {
  const ui = useOfficeUi.getState();
  const { width, height } = scene.size;
  const seen = new Set<string>();
  const messages = useOfficeStore.getState().office?.messages ?? [];
  const projects = useOfficeStore.getState().office?.projects ?? [];
  const now = Date.now();
  const nameOf = (id: string) => scene.walkers.get(id)?.name ?? 'someone';
  const placing: Placing[] = [];
  for (const walker of scene.walkers.values()) {
    seen.add(walker.id);
    let element = layer.querySelector<HTMLElement>(`[data-o="${CSS.escape(walker.id)}"]`);
    if (!element) {
      element = document.createElement('div');
      element.dataset.o = walker.id;
      element.innerHTML = `<div class="bub"></div><div class="tag ${providerClass(walker)}"><span class="nt"></span><span class="qd" hidden>Waiting to deliver</span><span class="mchip" hidden></span></div>`;
      layer.appendChild(element);
    }
    const visible = inScope(walker, ui, agents) && matches(walker, ui);
    element.hidden = !visible;
    if (!visible) continue;

    const bubble = element.firstElementChild as HTMLElement;
    const tag = element.lastElementChild as HTMLElement;
    const point = scene.screenOf(walker);
    const left = `${(point.x / width) * 100}%`;
    element.style.setProperty('--ac', walker.hue);
    tag.style.left = left;
    tag.style.top = `${(point.y / height) * 100}%`;

    const eta = etaShort(walker);
    // Short lines stacked, rather than one long pill, so neighbouring tags keep apart: the name,
    // then for a workflow sub-agent where it works, then the model and time left.
    const where = walker.workflow ? whereWorking(walker, projects) : null;
    const tagHtml =
      `<span class="nn"><span class="pdot" style="width:7px;height:7px;border-radius:2px"></span><b>${esc(shownName(walker))}</b></span>` +
      (where
        ? `<span class="pj"><i style="background:${esc(where.color)}"></i><span class="pjn">${esc(where.name)}</span></span>`
        : '') +
      `<span class="nm"><small>${esc(modelLabel(walker.model))}</small>${eta ? `<em>${eta}</em>` : ''}</span>`;
    setHtml(tag.firstElementChild!, tagHtml);
    const attention = walker.state === 'approval' || walker.state === 'error';
    tag.className = `tag ${providerClass(walker)}${ui.selected === walker.id ? ' sel' : ''}${attention ? ' attn' : ''}`;
    const queued = Boolean(walker.queued?.length);
    tag.querySelector<HTMLElement>('.qd')!.hidden = !queued;
    const chip = chipFor(walker.id, messages, now, nameOf);
    const chipElement = tag.querySelector<HTMLElement>('.mchip')!;
    chipElement.hidden = !chip;
    if (chip) {
      if (chipElement.textContent !== chip.text) chipElement.textContent = chip.text;
      chipElement.style.setProperty('--mc', chip.color);
      chipElement.className = `mchip ${chip.outlined ? 'mc-out' : 'mc-in'}`;
    }

    const isReply = walker.bubbleKind === 'reply';
    const isTalk = walker.bubbleKind === 'talk';
    const isAsk = walker.bubbleKind === 'ask';
    const spotlit = ui.selected === walker.id && !ui.team && ui.spotlight;
    const quiet = !walker.bubble || (walker.path.length > 0 && !isReply) || (spotlit && !isReply);
    // What needs you and what answers you is never hidden. See bubbles.ts.
    const asking = isAsk || (walker.state === 'approval' && !isTalk);
    const rank = asking ? 3 : isReply || (walker.state === 'error' && !isTalk) ? 2 : isTalk ? 1 : 0;
    bubble.hidden = quiet;
    if (bubble.textContent !== walker.bubble) bubble.textContent = walker.bubble;
    const bubbleClass = `bub${isReply ? ' reply' : ''}${isTalk ? ' talk' : ''}${isAsk ? ' ask' : ''}${walker.state === 'approval' && !isTalk ? ' red' : ''}${rank >= PINNED_RANK ? ' pin' : ''}`;
    bubble.className = cutShort.has(bubble) ? `${bubbleClass} one` : bubbleClass;
    bubble.style.borderColor = isTalk ? walker.talkColor : '';
    const raised = walker.state === 'thinking' || walker.state === 'error' ? 26 : 0;
    const bubblePoint = scene.screenOf({ x: walker.x, y: walker.y - 48 - raised });
    // A raised bubble may come back down to the usual place, and a little nearer than that.
    const usual = raised ? scene.screenOf({ x: walker.x, y: walker.y - 48 }).y : bubblePoint.y;
    placing.push({
      id: walker.id,
      bubble,
      tag,
      at: point,
      bubbleAt: bubblePoint,
      settle: MAX_SETTLE + Math.max(0, usual - bubblePoint.y),
      rank,
      quiet,
      shortenable: rank < 3 && !isReply,
      tagKey: `${tagHtml}|${chip?.text ?? ''}|${queued}|${tag.className}`,
      bubbleKey: `${walker.bubble}|${bubbleClass}`,
    });
  }
  for (const element of [...layer.querySelectorAll<HTMLElement>('[data-o]')]) {
    if (!seen.has(element.dataset.o!)) element.remove();
  }
  placeOnFloor(layer, scene, placing);
}

/**
 * Puts each bubble over its agent, moved clear of the name tags and of other bubbles, or hidden if
 * it cannot be, and keeps it on the floor. See bubbles.ts for the rules.
 */
function placeOnFloor(layer: HTMLElement, scene: OfficeScene, placing: Placing[]): void {
  const { width, height } = scene.size;
  const overlay = layer.closest<HTMLElement>('.ovl');
  const scale = overlayScale(scene.matrix().a);
  const far = overlay?.classList.contains('far') ?? false;
  const tiny = overlay?.classList.contains('tiny') ? 'tiny' : '';
  const tagsHidden = layer.classList.contains('hide-tags');
  const bubblesHidden = layer.classList.contains('hide-bub');
  const tags: Box[] = [];
  const items: BubbleItem[] = [];
  for (const entry of placing) {
    // A tag that is not drawn covers nothing.
    const selected = entry.tag.classList.contains('sel') || entry.tag.classList.contains('attn');
    if (!tagsHidden || selected) {
      const size = sizeOf(entry.tag, `${entry.tagKey}|${tiny}`);
      if (size) tags.push(tagBox(entry.at.x, entry.at.y, size.width, size.height, scale));
    }
    // A bubble the zoom or the noise filters already hide needs no place.
    const pinned = entry.rank >= PINNED_RANK;
    if (entry.quiet || (!pinned && (far || bubblesHidden))) continue;
    const size = sizeOf(entry.bubble, entry.bubbleKey);
    if (size) {
      const { x, y } = entry.bubbleAt;
      const box = bubbleBox(x, y, size.width, size.height, scale);
      const short =
        entry.shortenable && size.oneLine < size.height - 1
          ? bubbleBox(x, y, size.width, size.oneLine, scale)
          : undefined;
      items.push({ id: entry.id, rank: entry.rank, box, short, settle: entry.settle });
    }
  }
  const placed = placeBubbles(items, tags, width);
  for (const entry of placing) {
    const place = placed.get(entry.id);
    if (place) {
      entry.bubble.hidden = place.hidden;
      entry.bubble.classList.toggle('one', place.short);
      if (place.short) cutShort.add(entry.bubble);
      else cutShort.delete(entry.bubble);
    }
    entry.bubble.style.left = `${((entry.bubbleAt.x + (place?.shift ?? 0)) / width) * 100}%`;
    entry.bubble.style.top = `${((entry.bubbleAt.y - (place?.lift ?? 0)) / height) * 100}%`;
  }
}

/**
 * Quiet name tags for the agent definitions resting in the lounge. They aren't agents, so they
 * have no model, bubble or message chip, and a search or filter doesn't pick them out.
 */
function renderResting(layer: HTMLElement, scene: OfficeScene): void {
  const { width, height } = scene.size;
  const shown = scene.restingShown();
  const seen = new Set<string>();
  for (const { def, walker } of scene.resting) {
    seen.add(walker.id);
    let element = layer.querySelector<HTMLElement>(`[data-r="${CSS.escape(walker.id)}"]`);
    if (!element) {
      const look = restingLook(def);
      element = document.createElement('div');
      element.dataset.r = walker.id;
      element.className = `tag rest ${providers[look.provider].cssClass}`;
      element.innerHTML = `<span class="rn"><span class="pdot" style="width:7px;height:7px;border-radius:2px"></span><b>${esc(def.name)}</b></span>`;
      element.style.setProperty('--ac', look.hue);
      layer.appendChild(element);
    }
    element.hidden = !shown;
    if (!shown) continue;
    const point = scene.screenOf(walker);
    element.style.left = `${(point.x / width) * 100}%`;
    element.style.top = `${(point.y / height) * 100}%`;
  }
  for (const element of [...layer.querySelectorAll<HTMLElement>('[data-r]')]) {
    if (!seen.has(element.dataset.r!)) element.remove();
  }
}

function renderReadout(readout: HTMLElement, agents: LiveAgent[], selected: LiveAgent | null) {
  const ui = useOfficeUi.getState();
  let rows: [string, string][];
  if (selected) {
    rows = [
      ['Elapsed', fmtClock(selected.elapsed)],
      ['Left', selected.estimate ? fmtClock(selected.estimate.secondsLeft) : '–'],
      ['Tokens', `${fmtK(selected.tokensIn)} in · ${fmtK(selected.tokensOut)} out`],
      ['Cost', `$${selected.cost.toFixed(2)}`],
    ];
  } else {
    const scoped = agents.filter((agent) => inScope(agent, ui, agents));
    const finish = Math.max(0, ...scoped.map((agent) => agent.estimate?.finishAt ?? 0));
    rows = [
      ['Agents', String(scoped.length)],
      ['Working', String(scoped.filter((agent) => agent.working).length)],
      ['Finish', finish ? `~${clockText(finish)}` : '–'],
    ];
  }
  setHtml(
    readout,
    rows
      .map(([label, value]) => `<div><span>${label}</span><b class="num">${esc(value)}</b></div>`)
      .join(''),
  );
  readout.hidden = agents.length === 0;
}

function renderSpotlight(
  layer: HTMLElement,
  scene: OfficeScene,
  walker: Walker | null,
  t: number,
): void {
  const ui = useOfficeUi.getState();
  const show = !!walker && !ui.team && ui.spotlight;
  layer.hidden = !show;
  if (!show || !walker) return;

  const svg = layer.querySelector('svg')!;
  const hero = layer.querySelector<HTMLElement>('.fhero')!;
  const info = layer.querySelector<HTMLElement>('.finfo')!;
  const steps = layer.querySelector<HTMLElement>('.fsteps')!;
  const { width: cw, height: ch } = scene.size;

  // The selected agent, drawn large and facing you.
  const unit = Math.max(3, Math.min(7, Math.floor(Math.min(ch * 0.5, 320) / 48)));
  const heroW = 48 * unit;
  const heroH = 60 * unit;
  const canvas = hero.querySelector('canvas')!;
  if (canvas.width !== heroW || canvas.height !== heroH) {
    canvas.width = heroW;
    canvas.height = heroH;
  }
  const g = canvas.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, heroW, heroH);
  g.imageSmoothingEnabled = false;
  g.setTransform(unit, 0, 0, unit, 0, 0);
  drawChar(
    g,
    { ...walker, x: 24, y: 54, path: [], front: true, popUntil: 0, dir: 0 },
    t,
    false,
    false,
  );
  if (['editing', 'running', 'reading', 'browsing'].includes(walker.state)) {
    const screen = (providers[walker.provider as ProviderName] ?? providers.custom).color;
    R(g, 13, 36, 22, 2, '#3A3D4D');
    R(g, 15, 27, 18, 10, '#4A4E61');
    R(g, 16, 28, 16, 8, screen);
    R(g, 16, 28, 16, 2, 'rgba(255,255,255,.25)');
  }
  if (walker.state === 'thinking') {
    const phase = Math.floor(t / 350) % 3;
    for (let dot = 0; dot < 3; dot++) {
      g.globalAlpha = dot <= phase ? 1 : 0.25;
      R(g, 30 + dot * 4, 4 - dot * 2, 3, 3, '#C9C9CE');
    }
    g.globalAlpha = 1;
  }

  const heroX = Math.round(cw / 2 - heroW / 2);
  const heroY = Math.round(ch / 2 - heroH / 2 + 10);
  Object.assign(hero.style, {
    left: `${heroX}px`,
    top: `${heroY}px`,
    width: `${heroW}px`,
    height: `${heroH}px`,
  });

  const name = hero.querySelector('.fhname')!;
  setHtml(
    name,
    `<span class="idot" style="--ac:${esc(walker.hue)}"></span><b>${esc(walker.name)}</b><span class="muted">${esc(walker.model.split(' · ')[0] ?? '')}</span>`,
  );

  const label = walker.bubble || stateLabel(walker.state);
  const bubble = hero.querySelector('.fbubble')!;
  if (bubble.textContent !== label) bubble.textContent = label;
  bubble.className = `fbubble${walker.state === 'approval' ? ' red' : ''}`;

  const eta = etaLong(walker);
  setHtml(
    info,
    `<div class="fhead"><span>Info</span><span class="fstate">${esc(stateLabel(walker.state))}</span></div><div class="fname"><span class="idot" style="--ac:${esc(walker.hue)}"></span><b>${esc(walker.name)}</b><span class="mono muted">#A-${String(walker.n).padStart(4, '0')}</span></div><div class="ftask">${esc(walker.task)}</div><div class="fmeta"><span class="chip ${STATE_CHIPS[walker.state] ?? ''}">${walker.estimate ? '<i></i>' : ''}${esc(stateLabel(walker.state))}</span>${etaShort(walker) ? `<span class="muted">${esc(eta)}</span>` : ''}</div>`,
  );

  const colours: Record<string, string> = decisionColors;
  const labels: Record<string, string> = decisionLabels;
  const items = [
    { kind: 'now', text: label, when: 'live', title: 'Now' },
    ...(walker.feed ?? []).slice(0, 2).map((event) => ({
      kind: event.tool,
      text: event.summary,
      when: clockText(event.time),
      title: STEP_LABELS[event.tool] ?? labels[event.tool] ?? event.tool,
    })),
  ];
  setHtml(
    steps,
    items
      .map((item, index) => {
        const colour =
          colours[item.kind] ?? (item.kind === 'message' ? '#1DD1A1' : 'var(--accent)');
        return `<div class="fstep${index === 0 ? ' live' : ''}" style="--dc:${colour}"><div class="fsh"><span class="dec" style="--dc:${colour}">${esc(item.title)}</span><span class="mono muted">${esc(item.when)}</span></div><div class="fst">${esc(item.text)}</div></div>`;
      })
      .join(''),
  );

  const infoW = info.offsetWidth || 220;
  const infoH = info.offsetHeight || 110;
  const stepsW = steps.offsetWidth || 236;
  const stepsH = steps.offsetHeight || 190;
  const gap = Math.max(28, Math.min(72, (cw - heroW - infoW - stepsW) / 2 - 24));
  const middle = heroY + heroH * 0.52;
  let stepsX = heroX + heroW + gap;
  const infoX = heroX - gap - infoW;
  const showInfo = infoX >= 8;
  info.hidden = !showInfo;
  if (stepsX + stepsW > cw - 8) stepsX = cw - 8 - stepsW;
  const stepsY = Math.min(ch - stepsH - 60, Math.max(12, middle - stepsH / 2));
  const infoY = Math.min(ch - infoH - 60, Math.max(12, middle - infoH / 2));
  steps.style.left = `${stepsX}px`;
  steps.style.top = `${stepsY}px`;
  info.style.left = `${infoX}px`;
  info.style.top = `${infoY}px`;

  svg.setAttribute('viewBox', `0 0 ${cw} ${ch}`);
  const fromX = heroX + heroW - unit * 8;
  const midX = (fromX + stepsX) / 2;
  let lines = '';
  [...steps.children].forEach((step, index) => {
    const element = step as HTMLElement;
    const y = stepsY + element.offsetTop + element.offsetHeight / 2;
    const live = index === 0 ? ' live' : '';
    lines += `<path d="M${fromX} ${middle} H${midX} V${y} H${stepsX}" class="fl${live}"/><circle cx="${stepsX}" cy="${y}" r="3.5" class="fn${live}"/>`;
  });
  lines += `<circle cx="${fromX}" cy="${middle}" r="4" class="fn live"/>`;
  if (showInfo) {
    const edge = infoX + infoW;
    const infoMiddle = infoY + infoH / 2;
    const toX = heroX + unit * 8;
    lines += `<path d="M${edge} ${infoMiddle} H${(edge + toX) / 2} V${middle} H${toX}" class="fl"/><circle cx="${edge}" cy="${infoMiddle}" r="3.5" class="fn"/><circle cx="${toX}" cy="${middle}" r="4" class="fn"/>`;
  }
  setHtml(svg, lines);
}

export interface OverlayElements {
  tags: HTMLElement;
  readout: HTMLElement;
  spotlight: HTMLElement;
  hint: HTMLElement | null;
  zoom: HTMLElement | null;
  /** The design note about amber tags, kept beside the first agent with a waiting instruction. */
  queueNote: HTMLElement | null;
}

function placeQueueNote(note: HTMLElement, scene: OfficeScene, agents: LiveAgent[]): void {
  const waiting = agents.find((agent) => (agent.queued?.length ?? 0) > 0);
  const walker = waiting ? scene.walkers.get(waiting.id) : undefined;
  if (!walker) return;
  const { width, height } = scene.floor;
  note.style.left = `${Math.max(1, Math.min(70, (walker.x / width) * 100 - 14))}%`;
  note.style.top = `${Math.min(80, (walker.y / height) * 100 + 9)}%`;
}

/**
 * Mabari's label. At its desk it sits under Mabari, as in the prototype; out on its rounds it
 * goes above its head, over the bubbles, so it's never hidden by whoever it's with.
 */
function renderMabari(layer: HTMLElement, scene: OfficeScene): void {
  let element = layer.querySelector<HTMLElement>('.mabtag');
  if (!element) {
    element = document.createElement('div');
    element.className = 'mabtag';
    layer.appendChild(element);
  }
  const { width, height } = scene.size;
  const m = scene.manager;
  const point = scene.screenOf({ x: m.x, y: scene.mabariHome ? m.y + 20 : m.y - 58 });
  element.classList.toggle('away', !scene.mabariHome);
  element.style.left = `${(point.x / width) * 100}%`;
  element.style.top = `${(point.y / height) * 100}%`;
  if (element.textContent !== scene.mabariLabel) element.textContent = scene.mabariLabel;
}

/** Everything drawn in HTML over the canvas, updated once a frame. */
export function renderOverlays(
  elements: OverlayElements,
  scene: OfficeScene,
  agents: LiveAgent[],
): void {
  const ui = useOfficeUi.getState();
  const walker = ui.selected ? (scene.walkers.get(ui.selected) ?? null) : null;
  const shown = walker && inScope(walker, ui, agents) && matches(walker, ui) ? walker : null;
  renderTags(elements.tags, scene, agents);
  renderResting(elements.tags, scene);
  renderMabari(elements.tags, scene);
  scaleTags(elements.tags, scene);
  renderReadout(elements.readout, agents, walker);
  renderSpotlight(elements.spotlight, scene, shown, performance.now());
  if (elements.hint) elements.hint.hidden = walker !== null;
  if (elements.queueNote && document.body.classList.contains('notes')) {
    placeQueueNote(elements.queueNote, scene, agents);
  }
  if (elements.zoom) {
    const text = `${Math.round(scene.view.s * 100)}%`;
    if (elements.zoom.textContent !== text) elements.zoom.textContent = text;
  }
}
