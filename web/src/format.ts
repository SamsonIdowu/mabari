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
export function etaShort(agent: Pick<LiveAgent, 'state' | 'estimate'>): string {
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
      return `~${Math.max(1, Math.round((agent.estimate?.secondsLeft ?? 0) / 60))}m`;
  }
}

/** The long form in the panel and spotlight, from the server's estimate. */
export function etaLong(agent: Pick<LiveAgent, 'state' | 'estimate'>): string {
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

export function filterLog(log: LogEntry[], search: string, type: string): LogEntry[] {
  const query = search.toLowerCase();
  return log.filter((row) => {
    if (type !== 'all' && row.type !== type) return false;
    if (!query) return true;
    return `${row.agent} ${row.message} ${row.outcome} ${row.type}`.toLowerCase().includes(query);
  });
}
