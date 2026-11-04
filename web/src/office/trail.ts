// SPDX-License-Identifier: Apache-2.0
import type { Event, LiveAgent } from '../gen/models.ts';

export interface TrailStep {
  kind: string;
  title: string;
  detail?: string;
  branch?: { label: string; kind: string; steps: TrailStep[] };
}

const FAILED = /\d+ failed|failed/i;

function stepFor(event: Event): TrailStep | null {
  const [head = '', tail] = event.summary.split(/\s{2}/);
  switch (event.tool) {
    case 'read_file':
      return { kind: 'read_file', title: `Read ${event.summary}` };
    case 'edit_file':
      return { kind: 'edit_file', title: `Edit ${head}`, ...(tail ? { detail: tail } : {}) };
    case 'run_shell':
      return { kind: 'run_shell', title: head };
    case 'web_search':
      return { kind: 'web_search', title: `Looked up ${event.summary}` };
    case 'think':
      return { kind: 'think', title: event.summary };
    case 'approval':
      return { kind: 'approval', title: event.summary };
    case 'instruction':
      return { kind: 'instruction', title: event.summary };
    case 'interrupt':
      return { kind: 'interrupt', title: event.summary };
    case 'spawn_agent':
      return { kind: 'spawn_agent', title: event.summary };
    case 'retry':
      return { kind: 'retry', title: event.summary };
    case 'finish':
      return { kind: 'ok', title: event.summary };
    default:
      return null;
  }
}

function outcomeOf(event: Event): TrailStep | null {
  const result = event.summary.split('→')[1]?.trim();
  if (event.tool !== 'run_shell' || !result) return null;
  return { kind: FAILED.test(result) ? 'bad' : 'ok', title: `Result: ${result}` };
}

/** Steps taken after a failure, up to the next command, show as a branch off that failure. */
function foldRetries(steps: TrailStep[]): TrailStep[] {
  const folded: TrailStep[] = [];
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!;
    if (step.kind !== 'bad') {
      folded.push(step);
      continue;
    }
    const retried: TrailStep[] = [];
    while (index + 1 < steps.length) {
      const next = steps[index + 1]!;
      if (next.kind === 'run_shell' || next.kind === 'approval') break;
      retried.push(next);
      index++;
    }
    folded.push(
      retried.length
        ? { ...step, branch: { label: 'Retried', kind: 'retry', steps: retried } }
        : step,
    );
  }
  return folded;
}

/**
 * How an agent got here, built from its real events so the trail never invents history. The server
 * keeps the newest events in each agent's feed, so a long session shows its most recent steps.
 */
export function buildTrail(agent: LiveAgent, subagents: LiveAgent[]): TrailStep[] {
  const steps: TrailStep[] = [{ kind: 'goal', title: agent.task }];
  const events = [...(agent.feed ?? [])].reverse();
  const worked: TrailStep[] = [];
  for (const event of events) {
    const step = stepFor(event);
    if (!step) continue;
    worked.push(step);
    const outcome = outcomeOf(event);
    if (outcome) worked.push(outcome);
  }
  steps.push(...foldRetries(worked));

  const helpers = subagents.map((helper) => ({
    kind: 'spawn_agent',
    title: `${helper.name} on ${helper.model}`,
    detail: helper.task,
  }));
  if (helpers.length) {
    steps.push({
      kind: 'spawn_agent',
      title: 'Handed work to a subagent',
      branch: { label: 'Subagent took over', kind: 'spawn_agent', steps: helpers },
    });
  }
  steps.push({ kind: 'now', title: agent.bubble });
  return steps;
}

/** Each kind of step used, in first-seen order, for the legend. */
export function trailKinds(steps: TrailStep[]): string[] {
  const kinds = new Set<string>();
  const visit = (step: TrailStep) => {
    kinds.add(step.kind);
    step.branch?.steps.forEach(visit);
  };
  steps.forEach(visit);
  return [...kinds];
}
