// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';
import type { Answer, MessageMode, TeamLine } from '../data/api.ts';
import type { LiveAgent } from '../gen/models.ts';
import { nextZoom } from './camera.ts';

export type StatusFilter = 'all' | 'needs' | 'active';

export interface OfficeFilters {
  project: string;
  provider: string;
  model: string;
  status: StatusFilter;
  team: string | null;
}

interface OfficeUi extends OfficeFilters {
  selected: string | null;
  zoom: number;
  pan: { x: number; y: number };
  follow: boolean;
  spotlight: boolean;
  fullscreen: boolean;
  /**
   * The list of everyone on the floor, beside it: shown or hidden by choice, or null to show it
   * when the window is wide enough. In full screen it is hidden unless `floorListFull` is set.
   */
  floorList: boolean | null;
  floorListFull: boolean;
  /** The auto approve banner, shown briefly after it is turned on. */
  autoBanner: boolean;
  /** The Create a new agent dialog, with the desk or project it was opened for. */
  newAgent: { desk?: number; project?: string } | null;
  /** The free desk someone clicked, to put an agent file's agent at it with a task. */
  startAtDesk: number | null;
  /** The New project chat. */
  newProject: boolean;
  /** The project whose chat is open on the Projects page. */
  projectChat: string | null;
  /** Full screen's panel of Mabari's latest updates. */
  mabariUpdates: boolean;
  mode: MessageMode;
  /** "auto", "selected", "everyone" or an agent id. */
  target: string;
  panelTab: 'live' | 'trail' | 'chats';
  highlight: string | null;
  /** The approval whose card is open. It closes if that approval is settled or replaced. */
  reviewing: string | null;
  /** The card was opened by voice, so it says a click is still needed. */
  spokenApproval: boolean;
  autoDialog: boolean;
  answers: Record<string, Answer>;
  teamAnswer: { question: string; lines: TeamLine[] } | null;
  /** The open conversation: "all" or a thread key, the two names sorted and joined by "|". */
  thread: string;
  /** The Conversations page's project tab. */
  threadProject: string;
  zoomBy: (direction: number) => void;
  fit: () => void;
  set: (patch: Partial<OfficeUiFields>) => void;
  clearFilters: () => void;
  /** Forgets what the office was showing, after a wipe or a demo load replaced it. */
  resetOffice: () => void;
}

type OfficeUiFields = Omit<OfficeUi, 'set' | 'clearFilters' | 'resetOffice'>;

const NO_FILTERS: OfficeFilters = {
  project: 'all',
  provider: 'all',
  model: 'all',
  status: 'all',
  team: null,
};

/** What a fresh office shows. Layout choices such as spotlight and full screen are kept. */
const FRESH_VIEW = {
  ...NO_FILTERS,
  selected: null,
  zoom: 1,
  pan: { x: 0, y: 0 },
  follow: false,
  autoBanner: false,
  newAgent: null,
  startAtDesk: null,
  newProject: false,
  projectChat: null,
  mabariUpdates: false,
  target: 'auto',
  panelTab: 'live',
  highlight: null,
  reviewing: null,
  spokenApproval: false,
  autoDialog: false,
  answers: {},
  teamAnswer: null,
  thread: 'all',
  threadProject: 'all',
} satisfies Partial<OfficeUiFields>;

export const useOfficeUi = create<OfficeUi>((set) => ({
  ...FRESH_VIEW,
  spotlight: true,
  fullscreen: false,
  floorList: null,
  floorListFull: false,
  mode: 'instruct',
  zoomBy: (direction) =>
    set((state) => {
      const zoom = nextZoom(state.zoom, direction);
      // The scene keeps the pan inside the office, so a wide office stays where it was.
      return { zoom, team: null, follow: false };
    }),
  fit: () => set({ zoom: 1, pan: { x: 0, y: 0 }, follow: false, team: null }),
  set: (patch) => set(patch),
  clearFilters: () => set(NO_FILTERS),
  resetOffice: () => set(FRESH_VIEW),
}));

/**
 * Opens an agent from anywhere, as the prototype does: the floor widens only if the agent is out of
 * view, and messages typed next go to that agent.
 */
export function openAgent(agent: LiveAgent, agents: LiveAgent[]): void {
  const ui = useOfficeUi.getState();
  const widen = inScope(agent, ui, agents) ? {} : { project: 'all', team: null };
  ui.set({ ...widen, selected: agent.id, target: 'selected' });
  window.location.hash = '#office';
}

/**
 * What clicking an agent on the floor does, from the canvas or the list beside it: opens its
 * panel, sends what is typed next to it, and opens its approval for review if it is waiting.
 */
export function selectAgent(agent: Pick<LiveAgent, 'id' | 'state' | 'approval'>): void {
  useOfficeUi.getState().set({
    selected: agent.id,
    target: 'selected',
    reviewing: agent.state === 'approval' ? (agent.approval?.id ?? null) : null,
  });
}

/** Agent files resting in the lounge belong to no project or team, so a filter on either hides them. */
export function filesShown(filters: Pick<OfficeFilters, 'project' | 'team'>): boolean {
  return !filters.team && filters.project === 'all';
}

/** The key of the conversation between two agents, by name. */
export function threadKey(first: string, second: string): string {
  return [first, second].sort().join('|');
}

/** Opens one conversation on the Conversations page, across every project. */
export function openThread(key: string): void {
  useOfficeUi.getState().set({ thread: key, threadProject: 'all' });
  window.location.hash = '#conversations';
}

const working = (agent: LiveAgent) => agent.working;

export function needsYou(agent: LiveAgent): boolean {
  return (
    agent.state === 'approval' ||
    agent.state === 'error' ||
    Boolean(agent.question) ||
    (agent.queued?.length ?? 0) > 0
  );
}

/** Project and team decide who is on the floor. Hidden agents keep working. */
export function inScope(agent: LiveAgent, filters: OfficeFilters, agents: LiveAgent[]): boolean {
  if (filters.team) {
    const lead = agents.find((item) => item.id === filters.team);
    if (!lead || (agent.id !== lead.id && agent.leadId !== lead.id)) return false;
  }
  return filters.project === 'all' || agent.projectId === filters.project;
}

/** The other filters only fade agents, so the room stays readable. */
export function matches(agent: LiveAgent, filters: OfficeFilters): boolean {
  if (filters.provider !== 'all' && agent.provider !== filters.provider) return false;
  if (filters.model !== 'all' && agent.model !== filters.model) return false;
  if (filters.status === 'needs') return needsYou(agent);
  if (filters.status === 'active') return working(agent);
  return true;
}
