// SPDX-License-Identifier: Apache-2.0
// Pause everyone and Continue everyone: who is in the view, what the person is told before they
// confirm, and which agents the last pause stopped, so Continue everyone carries on those and no
// others. What actually happens to each agent is decided by the server, which answers with it.
import { create } from 'zustand';
import type { GroupReply } from '../data/api.ts';
import type { LiveAgent, Snapshot } from '../gen/models.ts';
import { providers, type ProviderName } from '../shared/tokens.ts';
import { agentsHere } from './floorList.ts';
import { matches, type OfficeFilters } from './uiStore.ts';

/**
 * The agents Pause everyone would pause: those the floor shows now, by every filter, that are
 * working. The server's `working` flag leaves out anyone waiting on an approval or an answer, who
 * is never asked to pause.
 */
export function pausable(agents: LiveAgent[], filters: OfficeFilters): LiveAgent[] {
  return agentsHere(agents, filters).filter((agent) => matches(agent, filters) && agent.working);
}

/** Agents in the view that wait on you for an approval or an answer: a pause leaves them as they are. */
export function waitingOnYou(agents: LiveAgent[], filters: OfficeFilters): LiveAgent[] {
  return agentsHere(agents, filters).filter(
    (agent) => matches(agent, filters) && (agent.state === 'approval' || Boolean(agent.question)),
  );
}

/** Which part of the office the view is, for the confirmation: a project, a team, or all of it. */
export function viewScope(
  office: Pick<Snapshot, 'projects' | 'agents'>,
  filters: OfficeFilters,
): string {
  if (filters.team) {
    const lead = office.agents.find((agent) => agent.id === filters.team);
    if (lead) return `${lead.name}'s office`;
  }
  if (filters.project === 'all') return 'all projects';
  return office.projects.find((project) => project.id === filters.project)?.name ?? 'this project';
}

/** The Models filter, when it narrows the view: "OpenAI agents only", or the one model. */
export function modelScope(filters: Pick<OfficeFilters, 'provider' | 'model'>): string | null {
  if (filters.model !== 'all') return `${filters.model} only`;
  const provider = providers[filters.provider as ProviderName];
  return provider ? `${provider.label} agents only` : null;
}

function listed(names: string[]): string {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

/**
 * What Pause everyone can only ask for, in plain words, for the agents it is about to pause. The
 * demo's agents stop at once and need no note. Each connector's Interrupt differs, so each says
 * what it does (see the connectors' Interrupt in internal/connectors). The server's reply says
 * what really happened to each agent.
 */
export function pauseNotes(agents: Pick<LiveAgent, 'name' | 'source' | 'session'>[]): string[] {
  const named = (source: string) => agents.filter((agent) => agent.source === source);
  const notes: string[] = [];
  const claude = named('claude');
  // Mabari runs its own sessions, so it can carry them on. One started elsewhere is the person's.
  const here = claude.filter((agent) => agent.session?.status !== 'elsewhere');
  const away = claude.filter((agent) => agent.session?.status === 'elsewhere');
  if (here.length) {
    notes.push(
      `${listed(here.map((agent) => agent.name))} ${here.length === 1 ? 'is' : 'are'} in Claude Code, ` +
        'which stops at its next step. Continue everyone carries on from where it stopped.',
    );
  }
  if (away.length) {
    notes.push(
      `${listed(away.map((agent) => agent.name))} ${away.length === 1 ? 'is' : 'are'} in Claude Code, ` +
        "which stops at its next step. That session runs outside Mabari, which can't restart it: type in it to carry on.",
    );
  }
  const codex = named('codex').map((agent) => agent.name);
  if (codex.length) {
    notes.push(
      `${listed(codex)} ${codex.length === 1 ? 'is' : 'are'} in Codex, which ends its turn. ` +
        'Continue starts a new turn from where it stopped.',
    );
  }
  const hub = named('hub').map((agent) => agent.name);
  if (hub.length) {
    notes.push(
      `${listed(hub)} ${hub.length === 1 ? 'is a hub app' : 'are hub apps'}, so Mabari can only ask. ` +
        'It queues "Please pause." and the app decides.',
    );
  }
  return notes;
}

/** The names in the confirmation: all of them up to a few, then how many more. */
export function namesShown(names: string[], limit = 8): string {
  if (names.length <= limit) return listed(names);
  return `${names.slice(0, limit).join(', ')} and ${names.length - limit} more`;
}

/**
 * The agents the last Pause everyone stopped, kept so Continue everyone carries on those and not
 * ones paused by hand. `stopped` paused at once. `asked` were only asked, so they may be still
 * working, or about to stop at their next step.
 */
export interface PauseGroup {
  stopped: string[];
  asked: string[];
}

export const NO_GROUP: PauseGroup = { stopped: [], asked: [] };

/** Who the server paused or asked, from its answer. Nothing is kept when it did neither. */
export function groupFrom(reply: Pick<GroupReply, 'results'>): PauseGroup {
  const ids = (outcome: string) =>
    reply.results.filter((result) => result.outcome === outcome).map((result) => result.id);
  return { stopped: ids('paused'), asked: ids('asked') };
}

/**
 * The ids in the group that still count: an agent is still stopped while it is paused, and one
 * that was only asked also while it is still working, since it has until its next step. Agents
 * that were continued by hand, finished, or left are dropped, so the button goes back to Pause
 * everyone once nothing of the pause is left.
 */
export function stillStopped(
  group: PauseGroup,
  agents: Pick<LiveAgent, 'id' | 'state' | 'working'>[],
): string[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const asked = new Set(group.asked);
  const kept = [...group.stopped, ...group.asked].filter((id) => {
    const agent = byId.get(id);
    return agent !== undefined && (agent.state === 'paused' || (asked.has(id) && agent.working));
  });
  return [...new Set(kept)];
}

/** The group with only the agents that still count, as stillStopped found them. */
export function keepOnly(group: PauseGroup, live: readonly string[]): PauseGroup {
  const keep = new Set(live);
  return {
    stopped: group.stopped.filter((id) => keep.has(id)),
    asked: group.asked.filter((id) => keep.has(id)),
  };
}

const KEY = 'mabari.pausedGroup';

/** Reads a saved group, keeping only lists of ids. */
export function parseGroup(raw: string | null): PauseGroup {
  if (!raw) return NO_GROUP;
  try {
    const data = JSON.parse(raw) as Record<string, unknown> | null;
    const ids = (value: unknown) =>
      Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
    return { stopped: ids(data?.stopped), asked: ids(data?.asked) };
  } catch {
    return NO_GROUP;
  }
}

function load(): PauseGroup {
  try {
    return parseGroup(localStorage.getItem(KEY));
  } catch {
    return NO_GROUP;
  }
}

function save(group: PauseGroup) {
  try {
    if (group.stopped.length || group.asked.length)
      localStorage.setItem(KEY, JSON.stringify(group));
    else localStorage.removeItem(KEY);
  } catch {
    // A private window can refuse storage. The group still holds until the page reloads.
  }
}

interface PauseStore {
  group: PauseGroup;
  /** Keeps what a pause stopped, so a reload still offers Continue everyone. */
  remember: (group: PauseGroup) => void;
  forget: () => void;
}

export const usePauseGroup = create<PauseStore>((set) => ({
  group: typeof localStorage === 'undefined' ? NO_GROUP : load(),
  remember: (group) => {
    save(group);
    set({ group });
  },
  forget: () => {
    save(NO_GROUP);
    set({ group: NO_GROUP });
  },
}));
