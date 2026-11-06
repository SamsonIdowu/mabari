// SPDX-License-Identifier: Apache-2.0
// The list on the left of the Chats screen: the agents and the open projects, each group in the
// order of who needs you. It uses the one meaning of "needs you" from the first UX round.
import { isOpen, stateLabel } from '../format.ts';
import type { LiveAgent, Project, Snapshot } from '../gen/models.ts';
import { counted, hasQueued, needsYou, urgent } from '../office/uiStore.ts';

export interface ChatEntry {
  kind: 'agent' | 'project';
  id: string;
  name: string;
  color: string;
  /** Only an approval or an error is red. A question, or a queued instruction, is quieter. */
  tone: 'red' | 'amber' | 'calm';
  /** The state in words, such as "Needs approval" or "Working". */
  label: string;
  /** A second line: what it is doing, or who works there. */
  detail: string;
  needs: number;
}

const clip = (text: string, limit: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

/** Lower comes first: what needs you, then what is working, then what is waiting, then the rest. */
function rank(agent: Pick<LiveAgent, 'state' | 'question' | 'working' | 'queued'>): number {
  if (urgent(agent)) return 0;
  if (agent.question) return 1;
  if (agent.state === 'paused') return 2;
  if (agent.working) return 3;
  if (hasQueued(agent)) return 4;
  return 5;
}

function agentEntry(agent: LiveAgent): ChatEntry {
  const queued = agent.queued?.length ?? 0;
  const label = agent.question ? 'Asking you' : stateLabel(agent.state);
  const doing = agent.state === 'error' ? agent.error : agent.task;
  const extra = queued ? ` · ${queued} queued` : '';
  return {
    kind: 'agent',
    id: agent.id,
    name: agent.name,
    color: agent.hue,
    tone: urgent(agent) ? 'red' : queued ? 'amber' : 'calm',
    label,
    detail: `${label}${doing ? `: ${clip(doing, 60)}` : ''}${extra}`,
    needs: needsYou(agent) ? 1 : 0,
  };
}

function projectEntry(project: Project, agents: LiveAgent[]): ChatEntry {
  const here = agents.filter((agent) => agent.projectId === project.id && !agent.leadId);
  const needs = here.filter(needsYou).length;
  const working = here.filter((agent) => agent.working).length;
  const who = here.length === 1 ? '1 agent' : `${here.length} agents`;
  const label = needs
    ? `${needs} need${needs === 1 ? 's' : ''} you`
    : working
      ? `${working} working`
      : 'Quiet';
  return {
    kind: 'project',
    id: project.id,
    name: project.name,
    color: project.color,
    tone: here.some(urgent) ? 'red' : here.some(hasQueued) ? 'amber' : 'calm',
    label,
    detail: here.length ? `${who} · ${label}` : 'Nobody works here yet',
    needs,
  };
}

export interface ChatEntries {
  agents: ChatEntry[];
  projects: ChatEntry[];
}

/** Everyone Mabari can talk to, in the order they need you. */
export function chatEntries(office: Pick<Snapshot, 'agents' | 'projects'>): ChatEntries {
  const agents = counted(office.agents).filter((agent) => !agent.leadId);
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return {
    agents: [...agents].sort((a, b) => rank(a) - rank(b) || byName(a, b)).map(agentEntry),
    projects: office.projects
      .filter(isOpen)
      .map((project) => ({ project, entry: projectEntry(project, office.agents) }))
      .sort(
        (a, b) =>
          Number(b.entry.needs > 0) - Number(a.entry.needs > 0) ||
          Number(b.entry.label.endsWith('working')) - Number(a.entry.label.endsWith('working')) ||
          byName(a.entry, b.entry),
      )
      .map(({ entry }) => entry),
  };
}

/** Whether an entry matches what was typed in the search box. */
export function entryMatches(entry: ChatEntry, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  return !wanted || `${entry.name} ${entry.detail}`.toLowerCase().includes(wanted);
}
