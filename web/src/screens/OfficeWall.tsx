// SPDX-License-Identifier: Apache-2.0
// The fixed bar along the top of the office floor, which never zooms or pans: noise filters on the
// left; project panels, a live clock and the approval bell on the right. Also the Mabari updates
// button and panel that full screen adds to the header.
import { useEffect, useState } from 'react';
import type { LiveAgent, Snapshot } from '../gen/models.ts';
import { isQuiet, LAYERS, useLayers } from '../office/layers.ts';
import { counted, inScope, needsTone, needsYou, useOfficeUi } from '../office/uiStore.ts';
import { useVee } from '../office/veeStore.ts';
import { toggleFullscreen } from '../office/fullscreen.ts';
import { Icon } from '../shell/Icon.tsx';
import { MabariHead } from '../shell/MabariHead.tsx';

const PANELS = 4;

function NoiseFilters() {
  const layers = useLayers((state) => state.layers);
  const toggle = useLayers((state) => state.toggle);
  const quiet = useLayers((state) => state.quiet);
  const on = isQuiet(layers);
  return (
    <div className="layers" id="layerCtl" role="group" aria-label="What to show on agents">
      <button
        type="button"
        className="lbtn quiet"
        aria-pressed={on}
        aria-label="Quiet mode"
        title={
          on
            ? 'Quiet mode on: only what needs you. Click to show everything'
            : 'Quiet mode: hide everything except what needs you'
        }
        onClick={quiet}
      >
        <Icon>
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="3" />
        </Icon>
      </button>
      <span className="lsep" />
      {LAYERS.map(([layer, label, icon]) => (
        <button
          type="button"
          key={layer}
          className="lbtn"
          aria-pressed={layers[layer]}
          aria-label={label}
          title={`${layers[layer] ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
          onClick={() => toggle(layer)}
        >
          <Icon>
            <path d={icon} />
          </Icon>
        </button>
      ))}
    </div>
  );
}

function ProjectPanels({ office }: { office: Snapshot }) {
  const current = useOfficeUi((state) => state.project);
  const set = useOfficeUi((state) => state.set);
  const slots = Array.from({ length: PANELS }, (_, index) => office.projects[index]);
  return (
    <div id="projWins" role="group" aria-label="Projects">
      {slots.map((project, index) => {
        if (!project) {
          return (
            <button
              type="button"
              key={`empty-${index}`}
              className="pwin empty"
              title="New project"
              aria-label="New project"
              onClick={() => set({ newProject: true })}
            >
              +
            </button>
          );
        }
        const agents = counted(office.agents).filter((agent) => agent.projectId === project.id);
        const working = agents.filter((agent) => agent.working).length;
        // The same "needs you" as the badge and the header: an approval, an error or a question.
        const needing = agents.filter(needsYou);
        const need = needing.length;
        const percent = Math.round(project.progress * 100);
        const done = project.status === 'done';
        const on = current === project.id;
        return (
          <button
            type="button"
            key={project.id}
            className={`pwin${on ? ' on' : ''}${done ? ' done' : ''}`}
            style={{ ['--pc' as string]: project.color }}
            aria-pressed={on}
            title={`${project.name}: ${done ? 'completed' : `${percent}% done, ${working} working${need ? `, ${need} need you` : ''}`}. Click to ${on ? 'show every project' : 'show only this project'}`}
            onClick={() => set({ project: on ? 'all' : project.id, team: null })}
          >
            <span className="pwn">{project.name}</span>
            <span className="pws">
              <span className="pwb">
                <i style={{ width: `${done ? 100 : percent}%` }} />
              </span>
              {done ? '✓' : `${percent}%`}
              {need ? (
                <b className={needsTone(needing) === 'red' ? undefined : 'calm'}>{need}</b>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Ticks once a second, for the clock. */
function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function hand(angle: number, length: number) {
  return {
    x2: (16 + Math.sin(angle) * length).toFixed(2),
    y2: (16 - Math.cos(angle) * length).toFixed(2),
  };
}

function WallClock() {
  const now = useClock();
  const minutes = now.getMinutes() + now.getSeconds() / 60;
  const hours = (now.getHours() % 12) + minutes / 60;
  const turn = Math.PI * 2;
  return (
    <div
      className="wclock"
      id="wClock"
      title={now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
    >
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r="14" className="wcf" />
        <circle cx="16" cy="16" r="11.5" className="wcp" />
        <line x1="16" y1="16" {...hand((hours / 12) * turn, 5.5)} className="wch" />
        <line x1="16" y1="16" {...hand((minutes / 60) * turn, 8.5)} className="wcm" />
        <line x1="16" y1="16" {...hand((now.getSeconds() / 60) * turn, 9.5)} className="wcs" />
      </svg>
    </div>
  );
}

export function WallBar({ office }: { office: Snapshot }) {
  const team = useOfficeUi((state) => state.team);
  if (team) return null;
  return (
    <div className="wallbar" id="wallBar">
      <NoiseFilters />
      <span className="wbgrow" />
      <ProjectPanels office={office} />
      <WallClock />
    </div>
  );
}

/** The prototype's apSum: the command, the plan's project, or the file. */
function approvalSummary(agent: LiveAgent): string {
  const { detail, type } = agent.approval ?? { detail: { cmd: '', path: '' }, type: '' };
  if (type === 'command') return detail.cmd ?? '';
  if (type === 'plan') return `Approve the plan for ${detail.project ?? ''}`;
  return `Edit ${detail.path ?? ''}`;
}

const BELL = (
  <Icon>
    <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
    <path d="M10 20a2 2 0 0 0 4 0" />
  </Icon>
);

/**
 * The approval bell in the top right corner. With nothing waiting it is a grey bell. When an
 * approval arrives the card pops open; × minimises it back to the bell with a red count, and the
 * next new approval opens it again.
 */
export function ApprovalBell({ office }: { office: Snapshot }) {
  const ui = useOfficeUi();
  const [minimised, setMinimised] = useState(false);
  const [seen, setSeen] = useState(0);
  const waiting = office.agents.filter(
    (agent) => agent.state === 'approval' && inScope(agent, ui, office.agents),
  );
  // A new approval opens the card again, even after it was minimised.
  if (waiting.length !== seen) {
    if (waiting.length > seen) setMinimised(false);
    setSeen(waiting.length);
  }
  if (ui.team) return null;
  const mini = !waiting.length || minimised;
  const count = waiting.length;
  return (
    <div
      className={mini ? 'board is-mini' : 'board'}
      id="board"
      aria-label="Approvals"
      style={mini ? undefined : { width: 'min(280px, calc(100% - 28px))' }}
    >
      {mini ? (
        <button
          type="button"
          className={count ? 'bmini has' : 'bmini'}
          aria-label={
            count ? `${count} approval${count === 1 ? '' : 's'} waiting` : 'Nothing needs approval'
          }
          title={count ? 'Show approvals' : 'Nothing needs approval'}
          onClick={() => {
            setMinimised(false);
            useOfficeUi.getState().set({ mabariUpdates: false });
          }}
        >
          {BELL}
          {count ? <span className="bcount">{count}</span> : null}
        </button>
      ) : (
        <>
          <h4>
            <span>Needs approval</span>
            <span className="bhr">
              <span className="badge">{count}</span>
              <button
                type="button"
                className="bx"
                aria-label="Minimise"
                onClick={() => setMinimised(true)}
              >
                ×
              </button>
            </span>
          </h4>
          {waiting.map((agent) => (
            <button
              type="button"
              className="bitem"
              key={agent.id}
              onClick={() => ui.set({ reviewing: agent.approval?.id ?? null })}
            >
              <i />
              <span>
                <b>{agent.name}</b>: {approvalSummary(agent).replace(/-/g, '‑')}
              </span>
              {office.settings.autoApprove.on && agent.approval?.riskLevel === 'high'
                ? 'Risky · '
                : ''}
              Review
            </button>
          ))}
        </>
      )}
    </div>
  );
}

/** Full screen's Mabari button: Mabari's head with a red count of updates you haven't seen. */
export function MabariUpdatesButton() {
  const unread = useVee((state) => state.unread);
  const open = useOfficeUi((state) => state.mabariUpdates);
  const set = useOfficeUi((state) => state.set);
  return (
    <button
      type="button"
      className="btn fsonly fsmb"
      title="Mabari's updates"
      aria-label="Mabari's updates"
      aria-expanded={open}
      onClick={() => {
        set({ mabariUpdates: !open });
        if (!open) useVee.setState({ unread: 0 });
      }}
    >
      <MabariHead size={20} />
      <span className="sr">Mabari</span>
      {unread ? <span className="bcount">{unread > 9 ? '9+' : unread}</span> : null}
    </button>
  );
}

const timeOf = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function MabariUpdates() {
  const open = useOfficeUi((state) => state.mabariUpdates);
  const updates = useVee((state) => state.updates);
  const set = useOfficeUi((state) => state.set);
  if (!open) return null;
  const latest = updates.slice(-6).reverse();
  return (
    <div className="fsmbpop" id="fsMbPop" role="dialog" aria-label="Mabari's updates">
      <h4>
        <MabariHead size={22} />
        Mabari
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn ghost sm"
          aria-label="Close"
          onClick={() => set({ mabariUpdates: false })}
        >
          ×
        </button>
      </h4>
      {latest.length ? (
        latest.map((update) => (
          <div className="fsmbitem" key={update.id}>
            <small>{timeOf(update.at)}</small>
            {update.text}
          </div>
        ))
      ) : (
        <p className="help">
          No updates yet. Mabari reports replies, finished tasks and approvals here.
        </p>
      )}
      <button
        type="button"
        className="btn sm"
        onClick={() => {
          set({ mabariUpdates: false });
          if (useOfficeUi.getState().fullscreen) toggleFullscreen();
          window.location.hash = '#home';
        }}
      >
        Open the chat with Mabari
      </button>
    </div>
  );
}
