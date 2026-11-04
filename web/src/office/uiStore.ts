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
  /** Full screen without the browser's help, for when it refuses. */
  maximised: boolean;
  /** Real full screen is on. */
  fullscreen: boolean;
  mode: MessageMode;
  /** "auto", "selected", "everyone" or an agent id. */
  target: string;
  panelTab: 'live' | 'trail' | 'chats';
  highlight: string | null;
  /** The approval whose card is open. It closes if that approval is settled or replaced. */
  reviewing: string | null;
  autoDialog: boolean;
  answers: Record<string, Answer>;
  teamAnswer: { question: string; lines: TeamLine[] } | null;
  zoomBy: (direction: number) => void;
  fit: () => void;
  set: (patch: Partial<OfficeUiFields>) => void;
  clearFilters: () => void;
}

type OfficeUiFields = Omit<OfficeUi, 'set' | 'clearFilters'>;

const NO_FILTERS: OfficeFilters = {
  project: 'all',
  provider: 'all',
  model: 'all',
  status: 'all',
  team: null,
};

export const useOfficeUi = create<OfficeUi>((set) => ({
  ...NO_FILTERS,
  selected: null,
  zoom: 1,
  pan: { x: 0, y: 0 },
  follow: false,
  spotlight: true,
  maximised: false,
  fullscreen: false,
  mode: 'instruct',
  target: 'auto',
  panelTab: 'live',
  highlight: null,
  reviewing: null,
  autoDialog: false,
  answers: {},
  teamAnswer: null,
  zoomBy: (direction) =>
    set((state) => {
      const zoom = nextZoom(state.zoom, direction);
      return { zoom, team: null, follow: false, ...(zoom <= 1 ? { pan: { x: 0, y: 0 } } : {}) };
    }),
  fit: () => set({ zoom: 1, pan: { x: 0, y: 0 }, follow: false, team: null }),
  set: (patch) => set(patch),
  clearFilters: () => set(NO_FILTERS),
}));

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
