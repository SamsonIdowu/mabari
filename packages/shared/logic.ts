import type { AccountKind, AgentStateName, LiveAgent, MessageKind, Settings } from './models.ts';

export const DESK_COUNT = 16;
export const MAX_SUBAGENTS = 3;

export type Location = 'desk' | 'cabinets' | 'server' | 'library' | 'meeting' | 'pantry';

export const STATES: Record<
  AgentStateName,
  { label: string; loc: Location; chip: '' | 'red' | 'ok' | 'amber'; active: boolean }
> = {
  thinking: { label: 'Thinking', loc: 'desk', chip: '', active: true },
  reading: { label: 'Reading files', loc: 'cabinets', chip: '', active: true },
  editing: { label: 'Editing', loc: 'desk', chip: '', active: true },
  running: { label: 'Running tests', loc: 'server', chip: '', active: true },
  browsing: { label: 'Browsing', loc: 'library', chip: '', active: true },
  approval: { label: 'Needs approval', loc: 'desk', chip: 'red', active: false },
  spawning: { label: 'Starting a subagent', loc: 'meeting', chip: '', active: true },
  idle: { label: 'Idle', loc: 'pantry', chip: '', active: false },
  done: { label: 'Done', loc: 'desk', chip: 'ok', active: false },
  error: { label: 'Error', loc: 'desk', chip: 'red', active: false },
  paused: { label: 'Interrupted', loc: 'desk', chip: 'amber', active: false },
};

export const MODELS = {
  codex: ['gpt-5-codex', 'gpt-5', 'gpt-5-mini'],
  claude: ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
  anthropic: ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
  openai: ['gpt-5', 'gpt-5-mini', 'gpt-4.1'],
  hub: ['any model your app reports'],
} as const;

/** Dollars per 1,000 tokens, used for the demo office's cost counters. */
export const PRICE: Record<string, number> = {
  'claude-opus-4-1': 0.045,
  'claude-sonnet-4-5': 0.009,
  'claude-haiku-4-5': 0.002,
  'gpt-5': 0.006,
  'gpt-5-codex': 0.006,
  'gpt-5-mini': 0.0012,
  'gpt-4.1': 0.005,
};

export const MESSAGE_KINDS: Record<MessageKind, { color: string; label: string }> = {
  handoff: { color: '#1DD1A1', label: 'Handoff' },
  question: { color: '#48DBFB', label: 'Question' },
  answer: { color: '#B794F6', label: 'Answer' },
  report: { color: '#FF9F43', label: 'Report' },
  review: { color: '#FF6B9A', label: 'Review' },
  broadcast: { color: '#C8B6FF', label: 'Broadcast' },
};

export const DEFAULT_SETTINGS: Settings = {
  queryModel: 'gpt-5-mini',
  voice: 'browser',
  spoken: false,
  retentionDays: 30,
  lan: false,
  defaults: {
    claude: 'claude-sonnet-4-5',
    codex: 'gpt-5-codex',
    anthropic: 'claude-sonnet-4-5',
    openai: 'gpt-5',
  },
  autoApprove: { on: false, scope: 'safe' },
};

export const ACCOUNT_KINDS: AccountKind[] = [
  'codex',
  'claude_code',
  'anthropic_key',
  'openai_key',
  'hub',
];

export function etaText(a: Pick<LiveAgent, 'state' | 'progress' | 'rate'>): {
  short: string;
  long: string;
} {
  switch (a.state) {
    case 'approval':
      return { short: 'paused', long: 'Paused until you decide on the approval' };
    case 'idle':
      return { short: '', long: 'No task right now' };
    case 'done':
      return { short: 'done', long: 'Finished' };
    case 'error':
      return { short: 'stopped', long: 'Stopped by an error' };
    case 'paused':
      return { short: 'paused', long: 'Interrupted, waiting for your instruction' };
  }
  const seconds = (1 - a.progress) / a.rate;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return {
    short: `~${minutes}m`,
    long: seconds < 60 ? 'Under a minute left' : `About ${minutes} min left`,
  };
}

export function agentCost(a: Pick<LiveAgent, 'tokensIn' | 'tokensOut' | 'model'>): number {
  return ((a.tokensIn + a.tokensOut) / 1000) * (PRICE[a.model] ?? 0);
}

export function needsMe(a: Pick<LiveAgent, 'state'>): boolean {
  return a.state === 'approval' || a.state === 'error';
}

/** Turns "Sage, also update the docs." into "I'll also update the docs." */
export function ack(text: string): string {
  const body = text.replace(/^[A-Za-z]+,\s*/, '');
  if (body.length > 60) return "I'll do that next.";
  return `I'll ${body.charAt(0).toLowerCase()}${body.slice(1).replace(/\.$/, '')}.`;
}

/** What the agent's speech bubble says right now. */
export function bubbleFor(a: LiveAgent, now: number): string {
  if (a.reply && a.replyUntil > now) return a.reply;
  if (a.talk && a.talkUntil > now) return a.talk;
  if (a.bubble) return a.bubble;
  const last = a.feed[0];
  const lastOf = (tool: string) => (last?.tool === tool ? last : undefined);
  switch (a.state) {
    case 'thinking':
      return 'Working out what to do next';
    case 'reading':
      return `Reading ${lastOf('read_file')?.summary.split('/').pop() ?? 'files'}`;
    case 'editing': {
      const file = lastOf('edit_file')?.summary.split('  ')[0]?.split('/').pop();
      return `Editing ${file ?? 'code'}`;
    }
    case 'running':
      return `Running ${lastOf('run_shell')?.summary.split('  ')[0] ?? 'the tests'}`;
    case 'browsing':
      return `Looking up ${lastOf('web_search')?.summary ?? 'docs'}`;
    case 'approval':
      return 'Can I run this? Waiting for you';
    case 'spawning':
      return 'Bringing in a helper';
    case 'idle':
      return 'Free. Having a coffee';
    case 'done':
      return `Finished: ${a.task}`;
    case 'error':
      return a.error || 'Something went wrong';
    case 'paused':
      return 'Paused. What should I do?';
  }
}
