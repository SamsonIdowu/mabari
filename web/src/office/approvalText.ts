// SPDX-License-Identifier: Apache-2.0
import type { LiveAgent } from '../gen/models.ts';

/** The prototype's apSum: the command, the plan's project, or the file. */
export function approvalSummary(agent: Pick<LiveAgent, 'approval'>): string {
  const { detail, type } = agent.approval ?? { detail: { cmd: '', path: '' }, type: '' };
  if (type === 'command') return detail.cmd ?? '';
  if (type === 'plan') return `Approve the plan for ${detail.project ?? ''}`;
  return `Edit ${detail.path ?? ''}`;
}

const NAMED = 3;

/**
 * What a screen reader says when approvals are waiting, such as "1 approval waiting: Atlas, npm
 * run db:migrate". Empty when nothing waits, so it says nothing then.
 */
export function approvalAnnouncement(
  agents: Pick<LiveAgent, 'name' | 'state' | 'approval'>[],
): string {
  const waiting = agents.filter((agent) => agent.state === 'approval' && agent.approval);
  if (!waiting.length) return '';
  const count = waiting.length;
  const named = waiting.map((agent) => `${agent.name}, ${approvalSummary(agent)}`);
  const shown = named.slice(0, NAMED).join('; ');
  const more = count > NAMED ? `; and ${count - NAMED} more` : '';
  return `${count} approval${count === 1 ? '' : 's'} waiting: ${shown}${more}`;
}
