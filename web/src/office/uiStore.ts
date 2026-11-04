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
  /** The auto approve banner, shown briefly after it is turned on. */
  autoBanner: boolean;
  /** The Create a new agent dialog, with the desk or project it was opened for. */
  newAgent: { desk?: number; project?: string } | null;
  /** The New project chat. */
  newProject: boolean;
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
  newProject: false,
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
  mode: 'instruct',
  zoomBy: (direction) =>
    set((state) => {
      const zoom = nextZoom(state.zoom, direction);
      return { zoom, team: null, follow: false, ...(zoom <= 1 ? { pan: { x: 0, y: 0 } } : {}) };
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

/** The key of the conversation between two agents, by name. */
export function threadKey(first: string, second: string): string {
  return [first, second].sort().join('|');
}

/** Opens one conversation on the Conversations page, across every project. */
export function openThread(key: string): void {
  useOfficeUi.getState().set({ thread: key, threadProject: 'all' });
  window.location.hash = '#conversations';
}

const working = (agent: LiveAgent) => agent.estimate !== null;

export function needsYou(agent: LiveAgent): boolean {
  return agent.state === 'approval' || agent.state === 'error' || (agent.queued?.length ?? 0) > 0;
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
