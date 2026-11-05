// SPDX-License-Identifier: Apache-2.0
import type { AgentState, LiveAgent, LogEntry, Project, ProjectStatus } from './gen/models.ts';

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

const pad = (value: number) => String(value).padStart(2, '0');

export function clockText(time: number): string {
  const date = new Date(time);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function minsText(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h ${rest ? `${rest} min` : ''}`.trim();
}

export function agoText(time: number, now: number): string {
  const minutes = Math.round((now - time) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function dateText(time: number): string {
  const date = new Date(time);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} at ${clockText(time)}`;
}

/** The short form on tags and rows, from the server's estimate. */
/** Minutes left on a name tag, such as "~6m". */
export function shortMinutes(seconds: number): string {
  return `~${Math.max(1, Math.round(seconds / 60))}m`;
}

/** An agent asking you a question waits on your answer, whatever it was doing. */
type Timed = Pick<LiveAgent, 'state' | 'estimate'> & { question?: LiveAgent['question'] };

export function etaShort(agent: Timed): string {
  if (agent.question) return 'asking';
  switch (agent.state) {
    case 'approval':
    case 'paused':
      return 'paused';
    case 'idle':
      return '';
    case 'done':
      return 'done';
    case 'error':
      return 'stopped';
    default:
      return shortMinutes(agent.estimate?.secondsLeft ?? 0);
  }
}

/** The long form in the panel and spotlight, from the server's estimate. */
export function etaLong(agent: Timed): string {
  if (agent.question) return 'Waiting for your answer';
  switch (agent.state) {
    case 'approval':
      return 'Paused until you decide on the approval';
    case 'idle':
      return 'No task right now';
    case 'done':
      return 'Finished';
    case 'error':
      return 'Stopped by an error';
    case 'paused':
      return 'Interrupted, waiting for your instruction';
  }
  const seconds = agent.estimate?.secondsLeft ?? 0;
  const left = seconds < 60 ? 'Under a minute left' : `About ${minsText(seconds)} left`;
  return `${left}, done around ${clockText(agent.estimate?.finishAt ?? 0)}`;
}

/** The short model name on tags: "sonnet-4.5" for "claude-sonnet-4-5". */
export function modelLabel(model: string): string {
  const short = model.replace(/^claude-/, '').replace(/-(\d)-(\d)$/, '-$1.$2');
  return short.split(' · ')[0] ?? short;
}

export const STATE_LABELS: Record<AgentState, string> = {
  thinking: 'Thinking',
  reading: 'Reading files',
  editing: 'Editing',
  running: 'Running tests',
  browsing: 'Browsing',
  approval: 'Needs approval',
  spawning: 'Starting a subagent',
  idle: 'Idle',
  done: 'Done',
  error: 'Error',
  paused: 'Interrupted',
};

export const stateLabel = (state: AgentState): string => STATE_LABELS[state] ?? state;

export const STATE_CHIPS: Partial<Record<AgentState, string>> = {
  approval: 'red',
  done: 'ok',
  error: 'red',
  paused: 'amber',
};

const PROJECT_STATUS: Record<ProjectStatus, { label: string; chip: string }> = {
  done: { label: 'Completed', chip: 'ok' },
  new: { label: 'Not started', chip: '' },
  needs: { label: 'Needs you', chip: 'red' },
  active: { label: 'In progress', chip: 'accent' },
  ready: { label: 'All tasks finished', chip: 'ok' },
  idle: { label: 'Waiting for work', chip: '' },
};

export function projectStatus(status: ProjectStatus): { label: string; chip: string } {
  return PROJECT_STATUS[status] ?? { label: 'Waiting for work', chip: '' };
}

export function isOpen(project: Pick<Project, 'status'>): boolean {
  return project.status !== 'done';
}

export function filterLog(
  log: LogEntry[],
  search: string,
  type: string,
  agent = 'all',
): LogEntry[] {
  const query = search.toLowerCase();
  return log.filter((row) => {
    if (type !== 'all' && row.type !== type) return false;
    if (agent !== 'all' && row.agent !== agent) return false;
    if (!query) return true;
    return `${row.agent} ${row.message} ${row.outcome} ${row.type}`.toLowerCase().includes(query);
  });
}

/** What the server writes to the activity log, as the type filter names them. */
const LOG_TYPES: [string, string][] = [
  ['Instruction', 'Instructions'],
  ['Query', 'Queries'],
  ['Approval', 'Approvals'],
  ['Session', 'Sessions'],
];

/** The types the filter offers: every kind the server writes, and any other that is in the log. */
export function logTypes(log: Pick<LogEntry, 'type'>[]): [string, string][] {
  const known = new Set(LOG_TYPES.map(([type]) => type));
  const others = [...new Set(log.map((row) => row.type as string))]
    .filter((type) => !known.has(type))
    .sort();
  return [...LOG_TYPES, ...others.map((type): [string, string] => [type, type])];
}

/** The agents with something in the log, by name, for the agent filter. */
export function logAgents(log: Pick<LogEntry, 'agent'>[]): string[] {
  return [...new Set(log.map((row) => row.agent))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

/** What the log's table says when it has no rows: nothing has happened, or the filter hides it all. */
export function emptyLogText(entries: number): string {
  return entries === 0
    ? 'Nothing has happened yet. Instructions, questions, approvals and sessions show here.'
    : 'Nothing matches. Try a different word, type or agent.';
}
