import { describe, expect, it } from 'vitest';
import { ack, agentCost, bubbleFor, etaText, needsMe, STATES } from './logic.ts';
import type { LiveAgent } from './models.ts';

function agent(overrides: Partial<LiveAgent> = {}): LiveAgent {
  return {
    id: 'a',
    projectId: null,
    name: 'Scout',
    provider: 'openai',
    model: 'gpt-5',
    account: 'codex',
    source: 'sim',
    leadId: null,
    subModel: 'inherit',
    desk: 0,
    folder: '~/code/shop',
    allowedTools: [],
    dailyCostCap: null,
    hue: '#FF6B9A',
    createdAt: 0,
    state: 'thinking',
    task: 'Compare libraries',
    progress: 0.5,
    rate: 0.001,
    elapsed: 0,
    tokensIn: 0,
    tokensOut: 0,
    error: '',
    files: [],
    bubble: '',
    reply: '',
    replyUntil: 0,
    talk: '',
    talkUntil: 0,
    talkColor: '',
    leaving: false,
    feed: [],
    queued: [],
    approval: null,
    ...overrides,
  };
}

describe('etaText', () => {
  it('estimates from progress and rate', () => {
    expect(etaText(agent({ progress: 0.5, rate: 0.001 }))).toEqual({
      short: '~8m',
      long: 'About 8 min left',
    });
  });

  it('says under a minute near the end', () => {
    const eta = etaText(agent({ progress: 0.99, rate: 0.001 }));
    expect(eta.short).toBe('~1m');
    expect(eta.long).toBe('Under a minute left');
  });

  it.each([
    ['approval', 'paused'],
    ['idle', ''],
    ['done', 'done'],
    ['error', 'stopped'],
    ['paused', 'paused'],
  ] as const)('has fixed wording for %s', (state, short) => {
    expect(etaText(agent({ state })).short).toBe(short);
  });
});

describe('agentCost', () => {
  it('prices tokens by model', () => {
    expect(agentCost({ tokensIn: 800, tokensOut: 200, model: 'claude-opus-4-1' })).toBeCloseTo(
      0.045,
    );
  });

  it('costs nothing for an unknown model', () => {
    expect(agentCost({ tokensIn: 800, tokensOut: 200, model: 'local' })).toBe(0);
  });
});

describe('needsMe', () => {
  it('only asks for attention on approvals and errors', () => {
    const flagged = Object.keys(STATES).filter((state) =>
      needsMe({ state: state as LiveAgent['state'] }),
    );
    expect(flagged).toEqual(['approval', 'error']);
  });
});

describe('ack', () => {
  it('drops the name and repeats the request', () => {
    expect(ack('Sage, Also update the API docs.')).toBe("I'll also update the API docs.");
  });

  it('shortens long requests', () => {
    expect(ack('x'.repeat(61))).toBe("I'll do that next.");
  });
});

describe('bubbleFor', () => {
  it('prefers a live reply, then a live talk message', () => {
    const talking = agent({ talk: 'To Ledger: hi', talkUntil: 10 });
    expect(bubbleFor(talking, 5)).toBe('To Ledger: hi');
    expect(bubbleFor({ ...talking, reply: 'Got it.', replyUntil: 10 }, 5)).toBe('Got it.');
  });

  it('ignores expired replies', () => {
    expect(bubbleFor(agent({ reply: 'Old', replyUntil: 1 }), 5)).toBe(
      'Working out what to do next',
    );
  });

  it('names the file from the latest tool call', () => {
    const feed = [
      { id: 'e', agentId: 'a', at: 0, tool: 'edit_file', summary: 'src/app.ts  +3 −1', raw: null },
    ];
    expect(bubbleFor(agent({ state: 'editing', feed }), 0)).toBe('Editing app.ts');
  });

  it('shows an agent error', () => {
    expect(bubbleFor(agent({ state: 'error', error: 'Lost connection' }), 0)).toBe(
      'Lost connection',
    );
  });
});
