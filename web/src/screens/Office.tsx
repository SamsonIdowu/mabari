// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { api } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import { clockText, minsText } from '../format.ts';
import type { LiveAgent, Snapshot } from '../gen/models.ts';
import { nextZoom } from '../office/camera.ts';
import colourKey from '../office/colourKey.html?raw';
import { renderOverlays } from '../office/overlays.ts';
import { OfficeScene } from '../office/scene.ts';
import { inScope, needsYou, useOfficeUi, type StatusFilter } from '../office/uiStore.ts';
import { providers, type ProviderName } from '../shared/tokens.ts';
import { Icon } from '../shell/Icon.tsx';
import { AgentPanel } from './AgentPanel.tsx';
import { LATER } from './parts.tsx';

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

function Summary({ scoped }: { scoped: LiveAgent[] }) {
  const working = scoped.filter((agent) => agent.estimate);
  const need = scoped.filter(needsYou).length;
  const held = scoped.filter((a) => a.state === 'approval' || a.state === 'paused').length;
  const seconds = Math.max(0, ...working.map((agent) => agent.estimate?.secondsLeft ?? 0));
  const finish = Math.max(0, ...working.map((agent) => agent.estimate?.finishAt ?? 0));
  return (
    <span className="help" id="officeClock">
      {scoped.length} agent{scoped.length === 1 ? '' : 's'} · {working.length} working ·{' '}
      {need ? (
        <b style={{ color: 'var(--red)' }}>
          {need} need{need === 1 ? 's' : ''} you
        </b>
      ) : (
        'nothing needs you'
      )}
      {working.length ? (
        <span title="Estimated time to completion for every agent in this view">
          {' '}
          · all done about {minsText(seconds)}, around {clockText(finish)}
          {held ? ` (not counting ${held} waiting on you)` : ''}
        </span>
      ) : null}
    </span>
  );
}

function ProjectMenu({ office, close }: { office: Snapshot; close: () => void }) {
  const current = useOfficeUi((state) => state.project);
  const set = useOfficeUi((state) => state.set);
  const items = [{ id: 'all', name: 'All projects', color: '#A99CFF' }, ...office.projects];
  return (
    <div className="menu" role="menu">
      {items.map((project) => {
        const count =
          project.id === 'all'
            ? office.agents.length
            : office.agents.filter((agent) => agent.projectId === project.id).length;
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
              {count} agent{count === 1 ? '' : 's'}
            </span>
          </button>
        );
      })}
      <div className="msep" />
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

  const project = office.projects.find((item) => item.id === filters.project);
  const provider = providers[filters.provider as ProviderName];
  const modelLabel =
    filters.model !== 'all' ? filters.model : provider ? `All ${provider.label}` : 'All models';
  const inProject = office.agents.filter(
    (agent) => filters.project === 'all' || agent.projectId === filters.project,
  );
  const need = scoped.filter(needsYou).length;
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
    <div className="obar2">
      <span className="help" style={{ fontWeight: 700 }}>
        Show
      </span>
      <div className="ddwrap">
        <button
          type="button"
          className="dd"
          aria-haspopup="menu"
          aria-expanded={menu === 'project'}
          onClick={() => toggle('project')}
        >
          <span className="ddl">Project</span>
          <span className="pdot" style={{ background: project?.color ?? '#A99CFF' }} />
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
            {id === 'needs' && need ? <span className="badge">{need}</span> : null}
          </button>
        ))}
      </div>
      {filtered ? (
        <button type="button" className="btn ghost sm" onClick={clearFilters}>
          Clear filters
        </button>
      ) : null}
      <div className="ddwrap" style={{ marginLeft: 'auto' }}>
        <button
          type="button"
          className="btn ghost sm"
          aria-haspopup="true"
          aria-expanded={menu === 'key'}
          onClick={() => toggle('key')}
        >
          <Icon>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v6M12 7h.01" />
          </Icon>
          Colour key
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
              Start a Codex session in your terminal or start one here. It will walk in and take a
              desk.
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
            <button type="button" className="btn primary" disabled title={LATER}>
              Start an agent
            </button>
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
  const zoom = useOfficeUi((state) => state.zoom);
  const selected = useOfficeUi((state) => state.selected);
  const follow = useOfficeUi((state) => state.follow);
  const spotlight = useOfficeUi((state) => state.spotlight);
  const set = useOfficeUi((state) => state.set);
  const zoomBy = (direction: number) => {
    const next = nextZoom(zoom, direction);
    set({ zoom: next, team: null, ...(next === 1 ? { pan: { x: 0, y: 0 } } : {}) });
  };
  return (
    <div className="ctools" role="toolbar" aria-label="Office view">
      <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => zoomBy(-1)}>
        <Icon>
          <path d="M5 12h14" />
        </Icon>
      </button>
      <span id="zoomPct" className="num">
        100%
      </span>
      <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => zoomBy(1)}>
        <Icon>
          <path d="M12 5v14M5 12h14" />
        </Icon>
      </button>
      <span className="csep" />
      <button
        type="button"
        title="Fit the whole office"
        aria-label="Fit the whole office"
        onClick={() => set({ zoom: 1, pan: { x: 0, y: 0 }, follow: false, team: null })}
      >
        <Icon>
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
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
    </div>
  );
}

function Stage({ office }: { office: Snapshot }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const tags = useRef<HTMLDivElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLDivElement>(null);
  const spotlight = useRef<HTMLDivElement>(null);
  const hint = useRef<HTMLSpanElement>(null);
  const scene = useRef<OfficeScene | null>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const skipClick = useRef(false);
  const set = useOfficeUi((state) => state.set);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return undefined;
    const running = new OfficeScene(element, (current) => {
      if (!tags.current || !board.current || !readout.current || !spotlight.current) return;
      renderOverlays(
        {
          tags: tags.current,
          board: board.current,
          readout: readout.current,
          spotlight: spotlight.current,
          hint: hint.current,
          zoom: document.getElementById('zoomPct'),
        },
        current,
        useOfficeStore.getState().office?.agents ?? [],
      );
    });
    scene.current = running;
    running.start();

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const { zoom, set: update } = useOfficeUi.getState();
      update({ zoom: nextZoom(zoom, event.deltaY < 0 ? 1 : -1), team: null });
    };
    const onMove = (event: MouseEvent) => {
      const current = drag.current;
      const { zoom, follow, pan, set: update } = useOfficeUi.getState();
      if (!current) return;
      const dx = event.clientX - current.x;
      const dy = event.clientY - current.y;
      if (!current.moved && Math.hypot(dx, dy) < 5) return;
      if (zoom <= 1 && !follow) return;
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
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      running.stop();
      element.removeEventListener('wheel', onWheel);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const select = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (skipClick.current || !scene.current) return;
    const box = event.currentTarget.getBoundingClientRect();
    const hit = scene.current.hit({ x: event.clientX - box.left, y: event.clientY - box.top });
    if (hit) set({ selected: hit.id });
    else set({ selected: null, follow: false });
  };

  return (
    <div className="ofloor">
      <div className="stage" id="stage">
        <canvas
          id="floor"
          ref={canvas}
          width="960"
          height="576"
          aria-label="Office floor. Click an agent to inspect it."
          onClick={select}
          onMouseDown={(event) => {
            if (event.button === 0) {
              drag.current = { x: event.clientX, y: event.clientY, moved: false };
            }
          }}
        />
        <div className="ovl">
          <div ref={tags} />
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
        <div className="board" ref={board} aria-label="Notice board" />
        <CanvasTools />
        <div className="readout" ref={readout} aria-live="off" />
        <span className="stagehint" ref={hint}>
          Click an agent to see its live steps. Drag to move around when zoomed in.
        </span>
        <FloorMessage office={office} />
      </div>
    </div>
  );
}

export function Office() {
  const office = useOfficeStore((state) => state.office);
  const filters = useFilters();
  const selectedId = useOfficeUi((state) => state.selected);
  if (!office) return null;

  const selected = office.agents.find((agent) => agent.id === selectedId);
  const lead = filters.team ? office.agents.find((agent) => agent.id === filters.team) : undefined;
  const project = office.projects.find((item) => item.id === filters.project);
  const scoped = office.agents.filter((agent) => inScope(agent, filters, office.agents));

  return (
    <section data-screen="office" style={{ height: '100%' }}>
      <div className="office">
        <div className="ocol">
          <div className="ohead">
            <div className="ohtitle">
              <h1>{lead ? `${lead.name}'s office` : (project?.name ?? 'All projects')}</h1>
              <Summary scoped={scoped} />
            </div>
            <div className="ohact">
              <button type="button" className="btn" disabled title={LATER}>
                <Icon>
                  <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
                </Icon>
                Auto approve
              </button>
              <button type="button" className="btn" disabled title={LATER}>
                <Icon>
                  <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
                </Icon>
                New project
              </button>
              <button type="button" className="btn primary" disabled title={LATER}>
                <Icon>
                  <path d="M12 5v14M5 12h14" />
                </Icon>
                Start agent
              </button>
            </div>
          </div>
          <FilterBar office={office} scoped={scoped} />
          {lead ? <TeamBanner lead={lead} agents={office.agents} /> : null}
          <Stage office={office} />
        </div>
        {selected ? <AgentPanel key={selected.id} office={office} agent={selected} /> : null}
      </div>
    </section>
  );
}
