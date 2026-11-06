// SPDX-License-Identifier: Apache-2.0
// "Tell me when it's done": what the page needs to know about the watches the server keeps. The
// server fires them and decides everything; this only finds the ones that matter to a panel or a card.
import type { LiveAgent, Project, Watch, WatchKind } from '../gen/models.ts';

/** The watch on an agent or a project, if there is one. There is at most one for each. */
export function watchOf(
  watches: Watch[] | undefined,
  kind: WatchKind,
  target: string,
): Watch | undefined {
  return (watches ?? []).find((watch) => watch.kind === kind && watch.target === target);
}

/** The watches that will tell this agent something when their own work is done, oldest first. */
export function chainsFor(watches: Watch[] | undefined, agentId: string): Watch[] {
  return (watches ?? []).filter((watch) => watch.then?.agentId === agentId);
}

/**
 * Whether there is anything to wait for on an agent. One that is done, or stopped by an error, has
 * finished already, so the switch is left off the panel: Mabari says so if you ask it in chat.
 */
export function agentWatchable(agent: Pick<LiveAgent, 'state'>): boolean {
  return agent.state !== 'done' && agent.state !== 'error';
}

/** Likewise for a project: finished, or marked complete, leaves nothing to wait for. */
export function projectWatchable(project: Pick<Project, 'status'>): boolean {
  return project.status !== 'done' && project.status !== 'ready';
}

/** Who can be told something when a watch fires: anyone in the office but the one watched. */
export function tellable(
  agents: Pick<LiveAgent, 'id' | 'name' | 'leaving'>[],
  kind: WatchKind,
  target: string,
): Pick<LiveAgent, 'id' | 'name'>[] {
  return agents.filter((agent) => !agent.leaving && !(kind === 'agent' && agent.id === target));
}
