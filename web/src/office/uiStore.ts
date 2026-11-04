// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';
import type { LiveAgent } from '../gen/models.ts';

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
