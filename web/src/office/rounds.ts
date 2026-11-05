// SPDX-License-Identifier: Apache-2.0
// Mabari, the office manager, does the rounds: it walks from one agent at work to the next,
// project by project, checking in, and tells you how each project is doing in its updates. This
// module only decides who is next and what the update says; scene.ts walks it there. The numbers
// in an update are the server's (a project's progress and estimate), only put into words here.
import { minsText } from '../format.ts';
import type { LiveAgent, Project } from '../gen/models.ts';
import { STATE_LOCATIONS } from './layout.ts';

type Visitable = Pick<LiveAgent, 'id' | 'projectId' | 'desk' | 'state' | 'leaving' | 'working'>;

/** How long Mabari stays by an agent's desk. */
export const VISIT_MS = 3500;
/** The least time between two updates about the same project. */
export const REPORT_GAP_MS = 2 * 60 * 1000;

/** The agents Mabari visits, in order: project by project, and desk by desk within one. */
export function onRound<T extends Visitable>(agents: T[]): T[] {
  return agents
    .filter(
      (agent) =>
        agent.working &&
        !agent.leaving &&
        agent.desk >= 0 &&
        STATE_LOCATIONS[agent.state] === 'desk',
    )
    .sort((a, b) => (a.projectId ?? '￿').localeCompare(b.projectId ?? '￿') || a.desk - b.desk);
}

/** Who Mabari visits after `last`: the next on the round, back to the first after the end. */
export function nextVisit<T extends Visitable>(round: T[], last: string | null): T | null {
  if (!round.length) return null;
  const at = round.findIndex((agent) => agent.id === last);
  return round[(at + 1) % round.length]!;
}

/** What Mabari says about a project after checking in there, from the server's numbers. */
export function projectUpdate(
  project: Pick<Project, 'name' | 'progress' | 'estimate'> | null,
  agents: Pick<LiveAgent, 'projectId' | 'working' | 'state'>[],
  projectId: string | null,
): string {
  const here = agents.filter((agent) => (agent.projectId ?? null) === projectId);
  const working = here.filter((agent) => agent.working).length;
  const need = here.filter((agent) => agent.state === 'approval' || agent.state === 'error').length;
  const parts = [`${working} working`];
  if (need) parts.push(`${need} need${need === 1 ? 's' : ''} you`);
  if (project) {
    parts.push(`${Math.round(project.progress * 100)}% done`);
    if (project.estimate) parts.push(`about ${minsText(project.estimate.secondsLeft)} left`);
  }
  return `${project ? project.name : 'Outside any project'}: ${parts.join(', ')}.`;
}

/**
 * What Mabari last said about each project, by project id ("" for none), and when. It outlives
 * the office's scene, so coming back to the office doesn't say it all again.
 */
export const lastSaid = new Map<string, { text: string; at: number }>();

/** Whether an update about a project is worth saying: it changed, and not too soon after the last. */
export function worthSaying(
  text: string,
  last: { text: string; at: number } | undefined,
  now: number,
): boolean {
  if (!last) return true;
  return text !== last.text && now - last.at >= REPORT_GAP_MS;
}
