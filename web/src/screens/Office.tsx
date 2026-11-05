// SPDX-License-Identifier: Apache-2.0
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import { clockText, minsText } from '../format.ts';
import type { LiveAgent, Snapshot } from '../gen/models.ts';
import { toggleFullscreen } from '../office/fullscreen.ts';
import colourKey from '../office/colourKey.html?raw';
import { hiddenClasses, useLayers } from '../office/layers.ts';
import { agentsHere, floorCounts, useFloorList } from '../office/floorList.ts';
import { renderOverlays } from '../office/overlays.ts';
import { onFloor, restKey } from '../office/layout.ts';
import { OfficeScene } from '../office/scene.ts';
import { selectAgent, selectResting, useOfficeUi, type StatusFilter } from '../office/uiStore.ts';
import { providers, type ProviderName } from '../shared/tokens.ts';
import { useVee } from '../office/veeStore.ts';
import { useVoice } from '../office/voiceStore.ts';
import { Icon } from '../shell/Icon.tsx';
import { useEscape } from '../shell/useEscape.ts';
import { AgentPanel } from './AgentPanel.tsx';
import { RestingPanel } from './RestingPanel.tsx';
import { FloorList } from './FloorList.tsx';
import { ApprovalCard, AutoApproveButton, AutoApproveDialog } from './Approvals.tsx';
import { ApprovalBell, MabariUpdates, MabariUpdatesButton, WallBar } from './OfficeWall.tsx';
import { PromptTray } from './PromptTray.tsx';
import { VoiceCard } from './VoiceCard.tsx';

type Menu = 'project' | 'model' | 'key' | null;

const CHEVRON = 'M6 9l6 6 6-6';

const useFilters = () => {
  const project = useOfficeUi((state) => state.project);
  const provider = useOfficeUi((state) => state.provider);
  const model = useOfficeUi((state) => state.model);
  const status = useOfficeUi((state) => state.status);
  const team = useOfficeUi((state) => state.team);
  return { project, provider, model, status, team };
};

function pointIn(event: React.MouseEvent<HTMLElement>) {
  const box = event.currentTarget.getBoundingClientRect();
  return { x: event.clientX - box.left, y: event.clientY - box.top };
}

/** Shows which part of a wide office is in view, under the floor. Hidden when it all shows. */
function placeScrollBar(bar: HTMLDivElement | null, scene: OfficeScene) {
  if (!bar) return;
  const span = scene.span();
  bar.hidden = !span;
  if (!span) return;
  const thumb = bar.firstElementChild as HTMLElement;
  const place = `${(span.from * 100).toFixed(2)}:${((span.to - span.from) * 100).toFixed(2)}`;
  if (thumb.dataset.place === place) return;
  const [left, width] = place.split(':');
  thumb.dataset.place = place;
  thumb.style.left = `${left}%`;
  thumb.style.width = `${width}%`;
}

/** Below this width the floor's toolbar and readout no longer fit side by side. */
const NARROW_STAGE = 560;
const WHEEL_STEP = 40;
const WHEEL_GAP_MS = 120;

function Summary({ scoped }: { scoped: LiveAgent[] }) {
  // Working comes from the server, so agents that report no progress rate count too. Only those
  // with an estimate say when they will be done.
  const { agents, working, need, queued, tone } = floorCounts(scoped);
  const estimated = scoped.filter((agent) => agent.estimate);
  const held = scoped.filter((a) => a.state === 'approval' || a.state === 'paused').length;
  const seconds = Math.max(0, ...estimated.map((agent) => agent.estimate?.secondsLeft ?? 0));
  return (
    <span className="help" id="officeClock">
      {agents} agent{agents === 1 ? '' : 's'} · {working} working
      {need ? (
        <>
          {' · '}
          <b style={tone === 'calm' ? undefined : { color: `var(--${tone})` }}>
            {need} need{need === 1 ? 's' : ''} you
          </b>
        </>
      ) : null}
      {queued ? (
        <>
          {' · '}
          <b className="queuedn" style={{ color: 'var(--amber)' }}>
            {queued} queued
          </b>
        </>
      ) : null}
      {estimated.length ? (
        <>
          {' · '}
          <span
            title={`Estimated time to completion for every agent in this view${held ? `, not counting ${held} waiting on you` : ''}`}
          >
            done ~{minsText(seconds)}
          </span>
        </>
      ) : null}
    </span>
  );
}

function ProjectMenu({ office, close }: { office: Snapshot; close: () => void }) {
  const current = useOfficeUi((state) => state.project);
  const set = useOfficeUi((state) => state.set);
  const items = [{ id: 'all', name: 'All projects', color: '#8E8E93' }, ...office.projects];
  return (
    <div className="menu" role="menu">
      {items.map((project) => {
        const count =
          project.id === 'all'
            ? onFloor(office.agents).length
            : onFloor(office.agents).filter((agent) => agent.projectId === project.id).length;
        return (
          <button
            type="button"
            key={project.id}
            className={current === project.id ? 'mi on' : 'mi'}
            role="menuitemradio"
            aria-checked={current === project.id}
            onClick={() => {
              set({ project: project.id, team: null });
              close();
            }}
          >
            <span className="pdot" style={{ background: project.color }} />
            <span style={{ flex: 1 }}>{project.name}</span>
            <span className="help num">
              {/* A completed project's agents have moved on: its card on the Projects page counts
                  who worked on it, so here it says it is done rather than "0 agents". */}
              {'status' in project && project.status === 'done' && !count
                ? 'completed'
                : `${count} agent${count === 1 ? '' : 's'}`}
            </span>
          </button>
        );
      })}
      <div className="msep" />
      <button
        type="button"
        className="mi"
        role="menuitem"
        onClick={() => {
          close();
          useOfficeUi.getState().set({ newProject: true });
        }}
      >
        <Icon>
          <path d="M12 5v14M5 12h14" />
        </Icon>
        New project from a description
      </button>
      {office.demo ? (
        <button
          type="button"
          className="mi"
          role="menuitem"
          title="Clear the demo agents. Only real agents from your connections stay."
          onClick={() => {
            close();
            stopDemo();
          }}
        >
          <Icon>
            <path d="M6 6h12v12H6z" />
          </Icon>
          Stop the demo
        </button>
      ) : null}
      <a className="mi" href="#projects" role="menuitem" onClick={close}>
        <Icon>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </Icon>
        Open the Projects page
      </a>
    </div>
  );
}

function ModelMenu({ agents, close }: { agents: LiveAgent[]; close: () => void }) {
  const provider = useOfficeUi((state) => state.provider);
  const model = useOfficeUi((state) => state.model);
  const set = useOfficeUi((state) => state.set);
  const choose = (nextProvider: string, nextModel: string) => {
    set({ provider: nextProvider, model: nextModel });
    close();
  };
  return (
    <div className="menu" role="menu">
      <button
        type="button"
        className={provider === 'all' ? 'mi on' : 'mi'}
        role="menuitemradio"
        aria-checked={provider === 'all'}
        onClick={() => choose('all', 'all')}
      >
        <span style={{ flex: 1 }}>All models</span>
        <span className="help num">{agents.length}</span>
      </button>
      {(Object.keys(providers) as ProviderName[]).map((id) => {
        const group = agents.filter((agent) => agent.provider === id);
        if (!group.length) return null;
        const models = [...new Set(group.map((agent) => agent.model))];
        return [
          <div className="mhead" key={id}>
            <span className={`pdot ${providers[id].cssClass}`} />
            {providers[id].label}
          </div>,
          <button
            type="button"
            key={`${id}-all`}
            className={provider === id && model === 'all' ? 'mi on' : 'mi'}
            role="menuitemradio"
            aria-checked={provider === id && model === 'all'}
            onClick={() => choose(id, 'all')}
          >
            <span style={{ flex: 1 }}>Every {providers[id].label} agent</span>
            <span className="help num">{group.length}</span>
          </button>,
          ...models.map((name) => (
            <button
              type="button"
              key={name}
              className={model === name ? 'mi sub on' : 'mi sub'}
              role="menuitemradio"
              aria-checked={model === name}
              onClick={() => choose(id, name)}
            >
              <span className="mono" style={{ flex: 1 }}>
                {name}
              </span>
              <span className="help num">
                {group.filter((agent) => agent.model === name).length}
              </span>
            </button>
          )),
        ];
      })}
    </div>
  );
}

function FilterBar({ office, scoped }: { office: Snapshot; scoped: LiveAgent[] }) {
  const filters = useFilters();
  const set = useOfficeUi((state) => state.set);
  const clearFilters = useOfficeUi((state) => state.clearFilters);
  const [menu, setMenu] = useState<Menu>(null);
  const toggle = (name: Menu) => setMenu(menu === name ? null : name);
  const close = () => setMenu(null);
  // Escape closes one thing at a time. An open dialog handles the key itself.
  useEscape(() => {
    if (document.querySelector('.scrim') || useVoice.getState().phase) return;
    const ui = useOfficeUi.getState();
    if (menu) close();
    else if (ui.team) ui.set({ team: null });
    else if (ui.selected) ui.set({ selected: null, follow: false });
    else if (ui.fullscreen) toggleFullscreen();
  });

  const project = office.projects.find((item) => item.id === filters.project);
  const provider = providers[filters.provider as ProviderName];
  const modelLabel =
    filters.model !== 'all' ? filters.model : provider ? `All ${provider.label}` : 'All models';
  const inProject = onFloor(office.agents).filter(
    (agent) => filters.project === 'all' || agent.projectId === filters.project,
  );
  const { need, tone } = floorCounts(scoped);
  const filtered =
    filters.provider !== 'all' ||
    filters.model !== 'all' ||
    filters.status !== 'all' ||
    filters.project !== 'all';
  const statuses: [StatusFilter, string][] = [
    ['all', 'Everyone'],
    ['needs', 'Needs me'],
    ['active', 'Working'],
  ];

  return (
    <div className="obar2 inhead">
      <div className="ddwrap">
        <button
          type="button"
          className="dd"
          aria-haspopup="menu"
          aria-expanded={menu === 'project'}
          onClick={() => toggle('project')}
        >
          <span className="ddl">Project</span>
          <span className="pdot" style={{ background: project?.color ?? '#8E8E93' }} />
          <b>{project?.name ?? 'All projects'}</b>
          <Icon>
            <path d={CHEVRON} />
          </Icon>
        </button>
        {menu === 'project' ? <ProjectMenu office={office} close={close} /> : null}
      </div>
      <div className="ddwrap">
        <button
          type="button"
          className="dd"
          aria-haspopup="menu"
          aria-expanded={menu === 'model'}
          onClick={() => toggle('model')}
        >
          <span className="ddl">Models</span>
          {provider ? <span className={`pdot ${provider.cssClass}`} /> : null}
          <b>{modelLabel}</b>
          <Icon>
            <path d={CHEVRON} />
          </Icon>
        </button>
        {menu === 'model' ? <ModelMenu agents={inProject} close={close} /> : null}
      </div>
      <div className="seg" role="group" aria-label="Agent status">
        {statuses.map(([id, label]) => (
          <button
            type="button"
            key={id}
            className={filters.status === id ? 'on' : ''}
            aria-pressed={filters.status === id}
            onClick={() => set({ status: id })}
          >
            {label}
            {id === 'needs' && need ? (
              <span className={`badge${tone === 'red' ? '' : ` ${tone}`}`}>{need}</span>
            ) : null}
          </button>
        ))}
      </div>
      {filtered ? (
        <button type="button" className="btn ghost sm" onClick={clearFilters}>
          Clear filters
        </button>
      ) : null}
      <span className="note inline">
        Project and Models narrow the floor. Hidden agents keep working.
      </span>
      <div className="ddwrap" style={{ marginLeft: 'auto' }}>
        <button
          type="button"
          className="btn ghost sm"
          id="ddKey"
          aria-haspopup="true"
          aria-expanded={menu === 'key'}
          aria-label="Colour key"
          onClick={() => toggle('key')}
        >
          <Icon>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v6M12 7h.01" />
          </Icon>
          <span className="klbl">Colour key</span>
        </button>
        {menu === 'key' ? (
          <div
            className="menu right"
            style={{ minWidth: 320 }}
            dangerouslySetInnerHTML={{ __html: colourKey }}
          />
        ) : null}
      </div>
    </div>
  );
}

function TeamBanner({ lead, agents }: { lead: LiveAgent; agents: LiveAgent[] }) {
  const set = useOfficeUi((state) => state.set);
  const subs = agents.filter((agent) => agent.leadId === lead.id).length;
  const subModel = lead.subModel && lead.subModel !== 'inherit' ? lead.subModel : lead.model;
  return (
    <div style={{ padding: '0 20px' }}>
      <div
        className="banner"
        style={{
          marginTop: 12,
          borderColor: lead.hue,
          boxShadow: `inset 4px 0 0 ${lead.hue}`,
        }}
      >
        <Icon>
          <path d="M3 21V9l9-6 9 6v12M9 21v-7h6v7" />
        </Icon>
        <span className="grow">
          Inside <b>{lead.name}&apos;s office</b>: {lead.name} and {subs} subagent
          {subs === 1 ? '' : 's'}. New subagents here use <span className="mono">{subModel}</span>{' '}
          from {lead.name}&apos;s agent settings.
        </span>
        <button type="button" className="btn sm" onClick={() => set({ team: null })}>
          Back to the full floor
        </button>
      </div>
    </div>
  );
}

/** Stops the demo, so the office shows only agents from real connections. */
function stopDemo() {
  void api
    .stopDemo()
    .then(() => useOfficeStore.getState().toast('The demo has stopped. Only real agents show now.'))
    .catch((error: unknown) =>
      useOfficeStore.getState().toast(error instanceof Error ? error.message : 'Try again'),
    );
}

/** While the demo runs, says so and offers to turn it off. It also turns itself off in time. */
function DemoBanner({ office }: { office: Snapshot }) {
  if (!office.demo) return null;
  return (
    <div style={{ padding: '0 20px' }}>
      <div className="banner" id="demoBanner" style={{ marginTop: 12 }}>
        <Icon>
          <path d="M12 8v5M12 16h.01" />
          <circle cx="12" cy="12" r="9" />
        </Icon>
        <span className="grow">
          <b>This is the demo office.</b> These agents are simulated
          {office.demoEndsAt
            ? `, and the demo turns itself off at ${clockText(office.demoEndsAt)}`
            : ''}
          . Your real agents stay on the floor when it ends.
        </span>
        <button type="button" className="btn sm" onClick={stopDemo}>
          Turn off the demo
        </button>
      </div>
    </div>
  );
}

function AutoBanner({ office }: { office: Snapshot }) {
  const { on, scope } = office.settings.autoApprove;
  const showing = useOfficeUi((state) => state.autoBanner);
  const set = useOfficeUi((state) => state.set);
  if (!on || !showing) return null;
  return (
    <div style={{ padding: '0 20px' }}>
      <div className="banner amber" style={{ marginTop: 12 }}>
        <Icon>
          <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
        </Icon>
        <span className="grow">
          Auto approve is on for every agent
          {scope === 'all' ? (
            <>
              , <b>including risky actions</b>.
            </>
          ) : (
            '. Risky actions still wait for you.'
          )}{' '}
          Every auto-approval is recorded in the Activity log.
        </span>
        <button
          type="button"
          className="btn sm"
          onClick={() => void api.autoApprove(false, scope, false)}
        >
          Turn off
        </button>
        <button
          type="button"
          className="btn ghost sm bannerx"
          aria-label="Hide this message"
          title="Hide"
          onClick={() => set({ autoBanner: false })}
        >
          <Icon>
            <path d="M6 6l12 12M18 6 6 18" />
          </Icon>
        </button>
      </div>
    </div>
  );
}

/** Connection problems the floor should mention: a quiet hook, or an expired sign in. */
function AccountBanners({ office }: { office: Snapshot }) {
  const toast = useOfficeStore((state) => state.toast);
  const status = (kind: string) => office.accounts.find((item) => item.kind === kind)?.status;
  const reattach = () =>
    api
      .connectClaude()
      .catch((error: unknown) => toast(error instanceof Error ? error.message : 'Try again'));
  return (
    <div id="hookBanner" style={{ padding: '0 20px' }}>
      {status('claude_code') === 'stale' ? (
        <div className="banner amber" style={{ marginTop: 12 }}>
          <Icon>
            <path d="M12 8v5M12 16h.01" />
          </Icon>
          <span className="grow">
            The Claude Code hook stopped reporting. Claude agents on the floor may be out of date.
          </span>
          <button type="button" className="btn sm" onClick={reattach}>
            Reattach the hook
          </button>
        </div>
      ) : null}
      {status('codex') === 'expired' ? (
        <div className="banner red" style={{ marginTop: 12 }}>
          <Icon>
            <path d="M12 8v5M12 16h.01" />
          </Icon>
          <span className="grow">
            Your ChatGPT sign in expired, so Codex agents stopped reporting.
          </span>
          <a className="btn sm" href="#accounts">
            Sign in again
          </a>
        </div>
      ) : null}
    </div>
  );
}

function FloorMessage({ office }: { office: Snapshot }) {
  const connected = office.accounts.some((account) => account.status !== 'off');
  if (office.agents.length) return null;
  const loadDemo = () => void api.loadDemo();
  return (
    <div className="floormsg">
      <div className="card">
        {connected ? (
          <>
            <h2>Connected. No agents running yet.</h2>
            <p className="muted">
              Start a session in your terminal, or run one from the agent builder. It will walk in
              and take a desk.
            </p>
          </>
        ) : (
          <>
            <h2>No accounts connected</h2>
            <p className="muted">
              Connect ChatGPT, attach Claude Code or add an API key, and your agents will take a
              desk here.
            </p>
          </>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          {connected ? (
            <a className="btn primary" href="#builder">
              Build an agent
            </a>
          ) : (
            <a className="btn primary" href="#accounts">
              Connect an account
            </a>
          )}
          <button type="button" className="btn" onClick={loadDemo}>
            {connected ? 'Load the demo team' : 'Explore a demo office'}
          </button>
        </div>
        {connected ? <p className="help">Looking for running sessions…</p> : null}
      </div>
    </div>
  );
}

function CanvasTools() {
  const selected = useOfficeUi((state) => state.selected);
  const follow = useOfficeUi((state) => state.follow);
  const spotlight = useOfficeUi((state) => state.spotlight);
  const set = useOfficeUi((state) => state.set);
  const zoomBy = useOfficeUi((state) => state.zoomBy);
  const fit = useOfficeUi((state) => state.fit);
  const wide = useOfficeUi((state) => state.fullscreen);
  const list = useFloorList();
  return (
    <div className="ctools" role="toolbar" aria-label="Office view">
      <button
        type="button"
        title="Zoom out (−, or scroll)"
        aria-label="Zoom out"
        onClick={() => zoomBy(-1)}
      >
        <Icon>
          <path d="M5 12h14" />
        </Icon>
      </button>
      <span id="zoomPct" className="num">
        100%
      </span>
      <button
        type="button"
        title="Zoom in (+, or scroll)"
        aria-label="Zoom in"
        onClick={() => zoomBy(1)}
      >
        <Icon>
          <path d="M12 5v14M5 12h14" />
        </Icon>
      </button>
      <span className="csep" />
      <button
        type="button"
        title="Fit the whole office (0)"
        aria-label="Fit the whole office"
        onClick={fit}
      >
        <Icon>
          <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
        </Icon>
      </button>
      <button
        type="button"
        title="Follow the selected agent"
        aria-label="Follow the selected agent"
        aria-pressed={follow && selected !== null}
        disabled={selected === null}
        onClick={() => set({ follow: !follow })}
      >
        <Icon>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
        </Icon>
      </button>
      <button
        type="button"
        id="fsBtn"
        title={wide ? 'Exit full screen (F or Esc)' : 'Full screen (F)'}
        aria-label="Full screen"
        aria-pressed={wide}
        onClick={toggleFullscreen}
      >
        <Icon>
          <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
        </Icon>
      </button>
      <button
        type="button"
        title="Spotlight the selected agent with its live steps"
        aria-label="Spotlight view"
        aria-pressed={spotlight}
        onClick={() => set({ spotlight: !spotlight })}
      >
        <Icon>
          <circle cx="5" cy="12" r="2" />
          <circle cx="19" cy="6" r="2" />
          <circle cx="19" cy="18" r="2" />
          <path d="M7 12h5V6h5M12 12v6h5" />
        </Icon>
      </button>
      <button
        type="button"
        id="floorListBtn"
        title={list.shown ? 'Hide the list of everyone on the floor' : 'List everyone on the floor'}
        aria-label="List of everyone on the floor"
        aria-pressed={list.shown}
        aria-controls={list.shown ? 'floorList' : undefined}
        onClick={list.toggle}
      >
        <Icon>
          <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />
        </Icon>
      </button>
    </div>
  );
}

function Stage({ office }: { office: Snapshot }) {
  const fullscreen = useOfficeUi((state) => state.fullscreen);
  useEffect(() => {
    document.body.classList.toggle('ofs', fullscreen);
    return () => document.body.classList.remove('ofs');
  }, [fullscreen]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tags = useRef<HTMLDivElement>(null);
  const layers = useLayers((state) => state.layers);
  const readout = useRef<HTMLDivElement>(null);
  const spotlight = useRef<HTMLDivElement>(null);
  const hint = useRef<HTMLSpanElement>(null);
  const scrollBar = useRef<HTMLDivElement>(null);
  const queueNote = useRef<HTMLDivElement>(null);
  const stageBox = useRef<HTMLDivElement>(null);
  const scene = useRef<OfficeScene | null>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const skipClick = useRef(false);
  const set = useOfficeUi((state) => state.set);

  // On a narrow floor the readout moves up, off the toolbar it would otherwise cover.
  useEffect(() => {
    const element = stageBox.current;
    if (!element) return undefined;
    const mark = () => element.classList.toggle('narrow', element.clientWidth < NARROW_STAGE);
    mark();
    const observer = new ResizeObserver(mark);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return undefined;
    const running = new OfficeScene(element, (current) => {
      if (!tags.current || !readout.current || !spotlight.current) return;
      renderOverlays(
        {
          tags: tags.current,
          readout: readout.current,
          spotlight: spotlight.current,
          hint: hint.current,
          zoom: document.getElementById('zoomPct'),
          queueNote: queueNote.current,
        },
        current,
        onFloor(useOfficeStore.getState().office?.agents ?? []),
      );
      placeScrollBar(scrollBar.current, current);
    });
    scene.current = running;
    running.start();

    let scrolled = 0;
    let lastStep = 0;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      // Scrolling sideways, or with Shift held, moves along a wide office. Up and down zooms.
      const sideways = event.shiftKey ? event.deltaY || event.deltaX : event.deltaX;
      if (Math.abs(sideways) > Math.abs(event.shiftKey ? 0 : event.deltaY)) {
        if (!running.canPan()) return;
        const { pan, set: update } = useOfficeUi.getState();
        update({ follow: false, pan: { x: pan.x + sideways / running.matrix().a, y: pan.y } });
        return;
      }
      scrolled += event.deltaY;
      const time = performance.now();
      if (Math.abs(scrolled) > WHEEL_STEP && time - lastStep > WHEEL_GAP_MS) {
        useOfficeUi.getState().zoomBy(scrolled < 0 ? 1 : -1);
        scrolled = 0;
        lastStep = time;
      }
    };
    const onFullscreen = () => {
      if (!document.fullscreenElement) useOfficeUi.getState().set({ fullscreen: false });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') useVoice.getState().stop();
    };
    const onKey = (event: KeyboardEvent) => {
      const { tagName } = event.target as HTMLElement;
      if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return;
      if (document.querySelector('.scrim')) return;
      const voice = useVoice.getState();
      if (event.key === 'Enter' && voice.phase === 'confirm' && tagName !== 'BUTTON') {
        event.preventDefault();
        voice.send();
        return;
      }
      if (event.code === 'Space' && tagName !== 'BUTTON' && tagName !== 'A') {
        event.preventDefault();
        const current = useOfficeStore.getState().office;
        if (!event.repeat && current) voice.start(current);
        return;
      }
      const ui = useOfficeUi.getState();
      if (event.key === '+' || event.key === '=') ui.zoomBy(1);
      else if (event.key === '-' || event.key === '_') ui.zoomBy(-1);
      else if (event.key === '0') ui.fit();
      else if (event.key === 'f' || event.key === 'F') toggleFullscreen();
      else return;
      event.preventDefault();
    };
    const onMove = (event: MouseEvent) => {
      const current = drag.current;
      const { follow, pan, set: update } = useOfficeUi.getState();
      if (!current) return;
      const dx = event.clientX - current.x;
      const dy = event.clientY - current.y;
      if (!current.moved && Math.hypot(dx, dy) < 5) return;
      if (!running.canPan() && !follow) return;
      current.moved = true;
      const scale = running.matrix().a;
      update({
        follow: false,
        pan: { x: pan.x - dx / scale, y: pan.y - dy / scale },
      });
      current.x = event.clientX;
      current.y = event.clientY;
    };
    const onUp = () => {
      if (drag.current?.moved) {
        skipClick.current = true;
        setTimeout(() => {
          skipClick.current = false;
        }, 0);
      }
      drag.current = null;
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('fullscreenchange', onFullscreen);
    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      running.stop();
      element.removeEventListener('wheel', onWheel);
      document.removeEventListener('fullscreenchange', onFullscreen);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const select = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (skipClick.current || !scene.current) return;
    const hit = scene.current.hit(pointIn(event));
    if (hit) {
      selectAgent(hit);
    } else {
      set({ selected: null, follow: false });
      // Mabari, on its rounds or at its desk, shows its updates.
      if (scene.current.mabariAt(pointIn(event))) {
        set({ mabariUpdates: true });
        useVee.setState({ unread: 0 });
        return;
      }
      // An agent file resting in the lounge opens its panel, as an agent does.
      const def = scene.current.restingAt(pointIn(event));
      if (def) {
        selectResting(restKey(def));
        return;
      }
      // The free desk starts a new agent there, with what it should do.
      const desk = scene.current.deskAt(pointIn(event));
      if (desk !== null) set({ startAtDesk: desk });
    }
  };

  const hover = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!scene.current) return;
    const point = pointIn(event);
    // A click on Mabari opens its updates, so the desk under it isn't offered then.
    const desk = scene.current.mabariAt(point) ? null : scene.current.deskAt(point);
    scene.current.hoverDesk = desk;
    const clickable =
      scene.current.hit(point) ||
      scene.current.restingAt(point) ||
      scene.current.mabariAt(point) ||
      desk !== null;
    event.currentTarget.style.cursor = clickable ? 'pointer' : '';
    event.currentTarget.title = desk !== null ? 'Put one of your agents to work at this desk' : '';
  };

  return (
    <div className="ofloor">
      <div className="stage" id="stage" ref={stageBox}>
        <canvas
          id="floor"
          ref={canvas}
          width="1216"
          height="704"
          aria-label="Office floor. Click an agent to inspect it."
          onClick={select}
          onMouseMove={hover}
          onMouseLeave={() => {
            if (scene.current) scene.current.hoverDesk = null;
          }}
          onMouseDown={(event) => {
            if (event.button === 0) {
              drag.current = { x: event.clientX, y: event.clientY, moved: false };
            }
          }}
        />
        <div className="ovl">
          <div ref={tags} className={hiddenClasses(layers)} />
          <div id="focusLayer" ref={spotlight} hidden>
            <div
              className="fscrim"
              title="Click to close the spotlight"
              onClick={() => set({ selected: null, follow: false })}
            />
            <svg className="flinks" aria-hidden="true" />
            <div className="fhero">
              <canvas width="96" height="128" aria-hidden="true" />
              <div className="fhshadow" />
              <div className="fbubble" />
              <div className="fhname" />
            </div>
            <div className="finfo" />
            <div className="fsteps" />
          </div>
        </div>
        <WallBar office={office} />
        <ApprovalBell office={office} />
        <div className="fnote note" style={{ right: '2%', top: '9%' }}>
          Approvals pop up from the bell. Click one to review it.
        </div>
        <div
          className="fnote note"
          id="noteQueue"
          ref={queueNote}
          style={{ left: '2%', top: '40%' }}
        >
          Amber tag: an instruction is waiting for this Claude Code agent&apos;s next checkpoint.
        </div>
        <div className="fnote note" style={{ left: '2%', top: '58%' }}>
          &quot;~4m&quot; on a tag is the agent&apos;s own estimate of time left.
        </div>
        <CanvasTools />
        <div className="readout" ref={readout} aria-live="off" />
        <PromptTray />
        <span className="stagehint" ref={hint}>
          Click an agent to see its live steps and to instruct or query it. Drag to move around when
          zoomed in, or along a wide office.
        </span>
        <div
          className="oscroll"
          ref={scrollBar}
          hidden
          title="The office goes on to the side. Drag here, drag the floor or scroll sideways."
          onMouseDown={(event) => {
            const bar = event.currentTarget;
            const move = (x: number) => {
              const box = bar.getBoundingClientRect();
              scene.current?.centreAt(Math.min(1, Math.max(0, (x - box.left) / box.width)));
            };
            move(event.clientX);
            const onMove = (next: MouseEvent) => move(next.clientX);
            const onUp = () => {
              window.removeEventListener('mousemove', onMove);
              window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <span />
        </div>
        <FloorMessage office={office} />
        <MabariUpdates />
      </div>
    </div>
  );
}

/**
 * The Agents header is one row when everything fits with comfortable gaps, and two rows when it
 * doesn't: the title with the actions first, then the filters. Nothing ever overlaps.
 */
function useOneRowWhenItFits() {
  const head = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = head.current;
    if (!element) return undefined;
    const fit = () => {
      const bar = element.querySelector<HTMLElement>('.obar2.inhead');
      if (!bar || !element.offsetWidth) return;
      // Measuring takes the stacked layout away for a moment. A short window scrolls, and the page
      // would be clamped to the shorter header and jump to the top, so its place is put back.
      const scroller = element.closest('main');
      const place = scroller?.scrollTop ?? 0;
      element.classList.remove('stack');
      const kids = [...bar.children].filter(
        (kid) => (kid as HTMLElement).offsetWidth,
      ) as HTMLElement[];
      const need =
        kids.reduce((sum, kid) => sum + kid.offsetWidth, 0) +
        HEAD_GAP * Math.max(0, kids.length - 1);
      if (need > bar.clientWidth + 1) element.classList.add('stack');
      if (scroller && scroller.scrollTop !== place) scroller.scrollTop = place;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    const bar = element.querySelector('.obar2.inhead');
    if (bar) for (const kid of bar.children) observer.observe(kid);
    window.addEventListener('resize', fit);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
    };
  });
  return head;
}

const HEAD_GAP = 12;

function OfficeHead({ office, scoped }: { office: Snapshot; scoped: LiveAgent[] }) {
  const head = useOneRowWhenItFits();
  return (
    <div className="ohead" ref={head}>
      <div className="ohtitle">
        <h1 id="oTitle">Agents</h1>
        <Summary scoped={scoped} />
      </div>
      <FilterBar office={office} scoped={scoped} />
      <div className="ohact">
        <AutoApproveButton settings={office.settings} />
        <MabariUpdatesButton />
        <button
          type="button"
          className="btn"
          title="Describe a project and let the planner pick a team"
          onClick={() => useOfficeUi.getState().set({ newProject: true })}
        >
          <Icon>
            <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
          </Icon>
          New project
        </button>
        <button
          type="button"
          className="btn"
          title="Make a new agent and give it a desk"
          onClick={() => {
            // In a project's view the new agent starts in that project.
            const { project } = useOfficeUi.getState();
            useOfficeUi.getState().set({ newAgent: project === 'all' ? {} : { project } });
          }}
        >
          <Icon>
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M19 8v6M16 11h6" />
          </Icon>
          New agent
        </button>
        <button
          type="button"
          className="btn fsonly"
          title="Leave full screen (Esc)"
          onClick={toggleFullscreen}
        >
          <Icon>
            <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
          </Icon>
          Exit full screen
        </button>
      </div>
    </div>
  );
}

export function Office() {
  const office = useOfficeStore((state) => state.office);
  const filters = useFilters();
  const selectedId = useOfficeUi((state) => state.selected);
  const list = useFloorList();
  if (!office) return null;

  const selected = office.agents.find((agent) => agent.id === selectedId);
  const resting = selected ? undefined : office.defs?.find((def) => restKey(def) === selectedId);
  const lead = filters.team ? office.agents.find((agent) => agent.id === filters.team) : undefined;
  const scoped = agentsHere(office.agents, filters);

  return (
    <section data-screen="office" style={{ height: '100%' }}>
      <div className="office">
        <div className="ocol">
          <OfficeHead office={office} scoped={scoped} />
          {lead ? <TeamBanner lead={lead} agents={office.agents} /> : null}
          <DemoBanner office={office} />
          <AutoBanner office={office} />
          <AccountBanners office={office} />
          <div className="ofrow">
            <Stage office={office} />
            {list.shown ? <FloorList office={office} filters={filters} /> : null}
          </div>
        </div>
        {selected ? <AgentPanel key={selected.id} office={office} agent={selected} /> : null}
        {resting ? <RestingPanel key={resting.id} office={office} def={resting} /> : null}
      </div>
      <ApprovalCard office={office} />
      <AutoApproveDialog office={office} />
      <VoiceCard />
    </section>
  );
}
