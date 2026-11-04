// SPDX-License-Identifier: Apache-2.0
import { clockText, etaLong, etaShort, modelLabel, STATE_CHIPS, stateLabel } from '../format.ts';
import type { LiveAgent } from '../gen/models.ts';
import { decisionColors, decisionLabels, providers, type ProviderName } from '../shared/tokens.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import { R } from './background.ts';
import { drawChar } from './character.ts';
import { H, W } from './layout.ts';
import type { OfficeScene, Walker } from './scene.ts';
import { chipFor } from './talk.ts';
import { inScope, matches, useOfficeUi } from './uiStore.ts';

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

/** Name tags and speech bubbles, positioned over the canvas every frame. */
/** Tags and bubbles grow and shrink with the office, and quiet bubbles hide when it's small. */
function scaleTags(layer: HTMLElement, scene: OfficeScene): void {
  const overlay = layer.closest<HTMLElement>('.ovl');
  if (!overlay) return;
  const scale = Math.max(0.72, Math.min(1.6, scene.matrix().a / 1.05)).toFixed(2);
  if (overlay.dataset.oz === scale) return;
  overlay.dataset.oz = scale;
  overlay.style.setProperty('--oz', scale);
  overlay.classList.toggle('far', Number(scale) < 0.86);
}

function renderTags(layer: HTMLElement, scene: OfficeScene, agents: LiveAgent[]): void {
  const ui = useOfficeUi.getState();
  const { width, height } = scene.size;
  const seen = new Set<string>();
  const messages = useOfficeStore.getState().office?.messages ?? [];
  const now = Date.now();
  const nameOf = (id: string) => scene.walkers.get(id)?.name ?? 'someone';
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
    setHtml(
      tag.firstElementChild!,
      `<span class="pdot" style="width:7px;height:7px;border-radius:2px"></span><b>${esc(walker.name)}</b><small>${esc(modelLabel(walker.model))}</small>${eta ? `<em>${eta}</em>` : ''}`,
    );
    const attention = walker.state === 'approval' || walker.state === 'error';
    tag.className = `tag ${providerClass(walker)}${ui.selected === walker.id ? ' sel' : ''}${attention ? ' attn' : ''}`;
    tag.querySelector<HTMLElement>('.qd')!.hidden = !walker.queued?.length;
    const chip = chipFor(walker.id, messages, now, nameOf);
    const chipElement = tag.querySelector<HTMLElement>('.mchip')!;
    chipElement.hidden = !chip;
    if (chip) {
      if (chipElement.textContent !== chip.text) chipElement.textContent = chip.text;
      chipElement.style.setProperty('--mc', chip.color);
      chipElement.className = `mchip ${chip.incoming ? 'mc-in' : 'mc-out'}`;
    }

    const isReply = walker.bubbleKind === 'reply';
    const isTalk = walker.bubbleKind === 'talk';
    const spotlit = ui.selected === walker.id && !ui.team && ui.spotlight;
    bubble.hidden = !walker.bubble || (walker.path.length > 0 && !isReply) || (spotlit && !isReply);
    if (bubble.textContent !== walker.bubble) bubble.textContent = walker.bubble;
    bubble.className = `bub${isReply ? ' reply' : ''}${isTalk ? ' talk' : ''}${walker.state === 'approval' && !isTalk ? ' red' : ''}`;
    bubble.style.borderColor = isTalk ? walker.talkColor : '';
    const raised = walker.state === 'thinking' || walker.state === 'error' ? 26 : 0;
    const bubblePoint = scene.screenOf({ x: walker.x, y: walker.y - 48 - raised });
    bubble.style.left = left;
    bubble.style.top = `${(bubblePoint.y / height) * 100}%`;
  }
  for (const element of [...layer.querySelectorAll<HTMLElement>('[data-o]')]) {
    if (!seen.has(element.dataset.o!)) element.remove();
  }
}

function renderBoard(board: HTMLElement, scene: OfficeScene, agents: LiveAgent[]): void {
  const ui = useOfficeUi.getState();
  const waiting = agents.filter(
    (agent) => agent.state === 'approval' && inScope(agent, ui, agents),
  );
  const items = waiting.map((agent) => {
    const { detail, type } = agent.approval ?? { detail: { cmd: '', path: '' }, type: '' };
    // The prototype's apSum: the command, the plan's project, or the file.
    const summary =
      type === 'command'
        ? detail.cmd
        : type === 'plan'
          ? `Approve the plan for ${detail.project ?? ''}`
          : `Edit ${detail.path}`;
    return `<button class="bitem" type="button" data-review="${esc(agent.approval?.id ?? '')}"><i></i><span><b>${esc(agent.name)}</b>: ${esc(summary ?? '')}</span>Review</button>`;
  });
  setHtml(
    board,
    `<h4><span>Needs approval</span>${waiting.length ? `<span class="badge">${waiting.length}</span>` : ''}</h4>${items.join('') || '<span class="bempty">Nothing waiting. Nice.</span>'}`,
  );
  const spotlit = ui.selected !== null && ui.spotlight && !ui.team;
  board.hidden = !!ui.team || spotlit;
  const point = scene.screenOf({ x: 8 * 32, y: 8 });
  board.style.left = `${point.x}px`;
  board.style.top = `${point.y}px`;
  board.style.width = `${Math.max(200, 6 * 32 * scene.matrix().a)}px`;
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
      ['Working', String(scoped.filter((agent) => agent.estimate).length)],
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
  board: HTMLElement;
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
  note.style.left = `${Math.max(1, Math.min(70, (walker.x / W) * 100 - 14))}%`;
  note.style.top = `${Math.min(80, (walker.y / H) * 100 + 9)}%`;
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
  scaleTags(elements.tags, scene);
  renderBoard(elements.board, scene, agents);
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
