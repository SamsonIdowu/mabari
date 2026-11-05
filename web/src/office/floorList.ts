// SPDX-License-Identifier: Apache-2.0
import { useSyncExternalStore } from 'react';
import { stateLabel } from '../format.ts';
import type { AgentDef, LiveAgent, Project } from '../gen/models.ts';
import { onFloor, restKey, restingDefs, STATE_LOCATIONS } from './layout.ts';
import { restingLook } from './resting.ts';
import {
  filesShown,
  inScope,
  matches,
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
    }
  | { kind: 'file'; id: string; def: AgentDef; name: string; color: string; detail: string };

export type FloorGroupId = 'needs' | 'working' | 'lounge';

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

/** Agents waiting on you, as the Needs me filter has them. Only approvals and errors are red. */
const needsAttention = needsYou;

/** In the lounge, as the floor seats it: idle, and not a contractor, who leaves instead. */
const inLounge = (agent: LiveAgent) => STATE_LOCATIONS[agent.state] === 'lounge' && !agent.workflow;

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

function detailOf(agent: LiveAgent): string {
  const asked = agent.question?.items[0]?.question;
  if (asked && !urgent(agent)) return `Asking you · ${asked}`;
  const queued = agent.queued?.length ?? 0;
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
  };
}

/**
 * Everyone on the floor, grouped as the floor shows them: those who need you first (approvals,
 * errors, questions and queued instructions), then those at their desks, then the lounge, where idle agents and the agent files
 * with nothing running rest. Project and team decide who is listed, as they decide who is on
 * the floor; the Models and status filters only fade entries. Empty groups are left out.
 */
export function floorGroups(
  office: {
    agents: LiveAgent[];
    defs: AgentDef[];
    projects: Pick<Project, 'id' | 'name' | 'color'>[];
  },
  filters: OfficeFilters,
): FloorGroup[] {
  const floor = onFloor(office.agents);
  const here = floor
    .filter((agent) => !agent.leaving && inScope(agent, filters, floor))
    .sort(byName);
  const needs = here.filter(needsAttention);
  const lounge = here.filter((agent) => !needsAttention(agent) && inLounge(agent));
  const working = here.filter((agent) => !needsAttention(agent) && !inLounge(agent));
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
    { id: 'needs', label: 'Needs you', entries: needs.map(entry) },
    { id: 'working', label: 'Working', entries: working.map(entry) },
    { id: 'lounge', label: 'Lounge', entries: [...lounge.map(entry), ...files] },
  ];
  return groups.filter((group) => group.entries.length);
}
