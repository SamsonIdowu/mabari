// SPDX-License-Identifier: Apache-2.0
import { useSyncExternalStore } from 'react';
import { stateLabel } from '../format.ts';
import type { AgentDef, LiveAgent, Project } from '../gen/models.ts';
import { onFloor, restKey, restingDefs } from './layout.ts';
import { restingLook } from './resting.ts';
import {
  areaOf,
  filesShown,
  hasQueued,
  inScope,
  matches,
  needsTone,
  needsYou,
  urgent,
  useOfficeUi,
  type OfficeFilters,
} from './uiStore.ts';
import { whereWorking } from './where.ts';

/** One line in the list beside the floor: an agent, or an agent file resting in the lounge. */
export type FloorEntry =
  | {
      kind: 'agent';
      id: string;
      agent: LiveAgent;
      name: string;
      color: string;
      /** What it is doing, in a few words. */
      detail: string;
      /** For a workflow sub-agent, the project or folder it works in. */
      where: { name: string; color: string } | null;
      /** Faded, as the floor fades it, when the Models or status filter leaves it out. */
      dim: boolean;
      /** Waiting on an approval or stopped by an error: the only red lines in the list. */
      red: boolean;
      /** An instruction is queued for it: the amber lines, in their own group. */
      amber: boolean;
      /**
       * "1 queued", for an agent that has an instruction queued but is listed in another group
       * because it needs you. The Queued group's own lines already say so.
       */
      queuedNote: string | null;
    }
  | { kind: 'file'; id: string; def: AgentDef; name: string; color: string; detail: string };

export type FloorGroupId = 'needs' | 'queued' | 'working' | 'interrupted' | 'done' | 'lounge';

export interface FloorGroup {
  id: FloorGroupId;
  label: string;
  entries: FloorEntry[];
}

/** At this window width and below the list starts hidden, as the agent panel stops sitting beside it. */
export const FLOOR_LIST_MIN_WIDTH = 1180;

/**
 * Whether the list shows: by choice, or when the window is wide enough. Full screen hides it
 * unless it was turned on there.
 */
export function floorListShown(
  choice: boolean | null,
  fullChoice: boolean,
  fullscreen: boolean,
  wide: boolean,
): boolean {
  if (fullscreen) return fullChoice;
  return choice ?? wide;
}

const onResize = (notify: () => void) => {
  window.addEventListener('resize', notify);
  return () => window.removeEventListener('resize', notify);
};
// The agent panel stops sitting beside the floor at this width and below, so the list starts
// shown only above it.
const wideWindow = () => window.innerWidth > FLOOR_LIST_MIN_WIDTH;

/** Whether the list beside the floor shows now, and a way to show or hide it. */
export function useFloorList(): { shown: boolean; toggle: () => void } {
  const choice = useOfficeUi((state) => state.floorList);
  const fullChoice = useOfficeUi((state) => state.floorListFull);
  const fullscreen = useOfficeUi((state) => state.fullscreen);
  const wide = useSyncExternalStore(onResize, wideWindow);
  const shown = floorListShown(choice, fullChoice, fullscreen, wide);
  const toggle = () =>
    useOfficeUi.getState().set(fullscreen ? { floorListFull: !shown } : { floorList: !shown });
  return { shown, toggle };
}

/** In the lounge, as the floor seats it: idle, and not a contractor, who leaves instead. */
const inLounge = (agent: LiveAgent) => areaOf(agent) === 'lounge';

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * The one group an agent is listed in, so every agent is listed once and the groups add up to the
 * floor. What needs you comes first (decision 1: an approval, an error or a question), then
 * agents with an instruction queued, then the rest by the server's working flag: working, paused
 * by you, resting in the lounge, and finished. A queued agent can be working too, and is counted
 * once, as queued: the header's "working" is the Working group (RT-1).
 */
export function groupOf(agent: LiveAgent): FloorGroupId {
  if (needsYou(agent)) return 'needs';
  if (hasQueued(agent)) return 'queued';
  if (agent.working) return 'working';
  if (agent.state === 'paused') return 'interrupted';
  if (inLounge(agent)) return 'lounge';
  // Finished, or a contractor with nothing left to do.
  return 'done';
}

/** The agents the office counts in this view: on the floor, not leaving, and in the project or team. */
export function agentsHere(agents: LiveAgent[], filters: OfficeFilters): LiveAgent[] {
  const floor = onFloor(agents);
  return floor.filter((agent) => !agent.leaving && inScope(agent, filters, floor));
}

/**
 * The numbers in the floor's header, from the same agents and the same groups as the list. Every
 * agent is counted in one group, so `working`, `need` and the Queued group are the sizes of those
 * groups and add up with the rest. `queued` also counts an agent that needs you and has an
 * instruction waiting, whose line in Needs you carries the same "queued" cue.
 */
export interface FloorCounts {
  agents: number;
  working: number;
  need: number;
  queued: number;
  /** Red when an approval or an error waits, calm when only questions do. */
  tone: 'red' | 'calm';
}

/** How many are in one part of the floor, and how many of them need you, in which colour. */
export interface AreaCount {
  count: number;
  need: number;
  tone: 'red' | 'calm';
}

/**
 * The counts on the work area and lounge buttons: who each would show, in the project or team
 * the floor shows, whichever part is chosen now. The lounge counts agent files resting there.
 */
export function areaCounts(
  office: { agents: LiveAgent[]; defs: AgentDef[] },
  filters: OfficeFilters,
): Record<'work' | 'lounge', AreaCount> {
  const everywhere = { ...filters, area: 'all' as const };
  const here = agentsHere(office.agents, everywhere);
  const files = filesShown(everywhere)
    ? restingDefs(office.defs, onFloor(office.agents)).length
    : 0;
  const count = (area: 'work' | 'lounge', extra: number): AreaCount => {
    const inArea = here.filter((agent) => areaOf(agent) === area);
    const needing = inArea.filter(needsYou);
    return { count: inArea.length + extra, need: needing.length, tone: needsTone(needing) };
  };
  return { work: count('work', 0), lounge: count('lounge', files) };
}

export function floorCounts(here: LiveAgent[]): FloorCounts {
  const inGroup = (id: FloorGroupId) => here.filter((agent) => groupOf(agent) === id);
  const needing = inGroup('needs');
  return {
    agents: here.length,
    working: inGroup('working').length,
    need: needing.length,
    queued: here.filter(hasQueued).length,
    tone: needsTone(needing),
  };
}

const queuedCount = (agent: LiveAgent) => agent.queued?.length ?? 0;

function detailOf(agent: LiveAgent): string {
  const asked = agent.question?.items[0]?.question;
  if (asked && !urgent(agent)) return `Asking you · ${asked}`;
  const queued = queuedCount(agent);
  if (queued && !urgent(agent)) return `${queued} instruction${queued === 1 ? '' : 's'} queued`;
  if (inLounge(agent)) return 'Resting';
  const label = stateLabel(agent.state);
  const what = agent.state === 'error' && agent.error ? agent.error : agent.task;
  return what ? `${label} · ${what}` : label;
}

function agentEntry(
  agent: LiveAgent,
  filters: OfficeFilters,
  projects: Pick<Project, 'id' | 'name' | 'color'>[],
): FloorEntry {
  return {
    kind: 'agent',
    id: agent.id,
    agent,
    name: agent.name,
    color: agent.hue,
    detail: detailOf(agent),
    where: agent.workflow ? whereWorking(agent, projects) : null,
    dim: !matches(agent, filters),
    red: urgent(agent),
    amber: groupOf(agent) === 'queued',
    queuedNote:
      hasQueued(agent) && groupOf(agent) !== 'queued' ? `${queuedCount(agent)} queued` : null,
  };
}

/**
 * Everyone on the floor, grouped as the floor shows them: those who need you first (approvals,
 * errors and questions), then those with an instruction queued, those working, those you
 * interrupted, those who are done, and the lounge, where idle agents and the agent files with
 * nothing running rest. Project and team decide who is listed, as they decide who is on the
 * floor; the Models and status filters only fade entries. Empty groups are left out.
 */
export function floorGroups(
  office: {
    agents: LiveAgent[];
    defs: AgentDef[];
    projects: Pick<Project, 'id' | 'name' | 'color'>[];
  },
  filters: OfficeFilters,
): FloorGroup[] {
  const here = agentsHere(office.agents, filters).sort(byName);
  const floor = onFloor(office.agents);
  const inGroup = (id: FloorGroupId) => here.filter((agent) => groupOf(agent) === id);
  const files: FloorEntry[] = filesShown(filters)
    ? restingDefs(office.defs, floor).map((def) => ({
        kind: 'file',
        id: restKey(def),
        def,
        name: def.name,
        color: restingLook(def).hue,
        detail: 'Agent file · not running',
      }))
    : [];
  const entry = (agent: LiveAgent) => agentEntry(agent, filters, office.projects);
  const groups: FloorGroup[] = [
    { id: 'needs', label: 'Needs you', entries: inGroup('needs').map(entry) },
    { id: 'queued', label: 'Queued', entries: inGroup('queued').map(entry) },
    { id: 'working', label: 'Working', entries: inGroup('working').map(entry) },
    { id: 'interrupted', label: 'Interrupted', entries: inGroup('interrupted').map(entry) },
    { id: 'done', label: 'Done', entries: inGroup('done').map(entry) },
    { id: 'lounge', label: 'Lounge', entries: [...inGroup('lounge').map(entry), ...files] },
  ];
  return groups.filter((group) => group.entries.length);
}
