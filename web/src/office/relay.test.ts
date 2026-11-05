// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { Instruction, LiveAgent, Snapshot } from '../gen/models.ts';
import {
  aiName,
  clipWords,
  promptCards,
  relayLine,
  replyFor,
  REPLIED_SHOWN_MS,
  stillWaiting,
} from './relay.ts';

const NOW = 1_800_000_000_000;

function instruction(id: string, text: string, extra: Partial<Instruction> = {}): Instruction {
  return {
    id,
    agentId: 'a1',
    text,
    mode: 'instruct',
    status: 'delivered',
    time: NOW - 5000,
    logId: '',
    reply: '',
    repliedAt: 0,
    ...extra,
  };
}

function agent(extra: Partial<LiveAgent>): LiveAgent {
  return {
    id: 'a1',
    name: 'Ledger',
    provider: 'claude',
    account: 'claude_code',
    model: 'claude-sonnet-4-5',
    queued: [],
    asked: [],
    ...extra,
  } as LiveAgent;
}

const relay = { agentId: 'a1', instructionId: 'i1', agent: 'Ledger', ai: 'Claude' };

describe('aiName', () => {
  it('names the AI as the server does', () => {
    expect(aiName({ provider: 'claude', account: 'claude_code' })).toBe('Claude');
    expect(aiName({ provider: 'openai', account: 'codex' })).toBe('ChatGPT');
    expect(aiName({ provider: 'openai', account: 'openai_key' })).toBe('OpenAI');
    expect(aiName({ provider: 'custom', account: 'hub' })).toBe('Custom AI');
  });
});

describe('relay', () => {
  it('finds the reply once the agent gives one, and only then', () => {
    const waiting = { agents: [agent({ asked: [instruction('i1', 'add tests')] })] } as Snapshot;
    expect(replyFor(waiting, relay)).toBeNull();
    expect(stillWaiting(waiting, relay)).toBe(true);
    const answered = {
      agents: [
        agent({
          asked: [instruction('i1', 'add tests', { reply: 'Added 4 tests.', repliedAt: NOW })],
        }),
      ],
    } as Snapshot;
    expect(replyFor(answered, relay)?.reply).toBe('Added 4 tests.');
  });

  it('stops waiting when the agent leaves', () => {
    expect(stillWaiting({ agents: [] } as unknown as Snapshot, relay)).toBe(false);
  });

  it('stops waiting when the instruction is taken back before delivery', () => {
    const queued = { agents: [agent({ queued: [instruction('i1', 'add tests')] })] } as Snapshot;
    expect(stillWaiting(queued, relay)).toBe(true);
    expect(stillWaiting({ agents: [agent({})] } as Snapshot, relay)).toBe(false);
  });

  it('follows a prompt Claude Code opened with to the session that took it', () => {
    const opening = { ...relay, agentId: '', agent: 'Claude Code in Shop' };
    const waiting = {
      agents: [],
      projects: [{ id: 'p1', opening: [instruction('i1', '/review')] }],
    } as unknown as Snapshot;
    expect(stillWaiting(waiting, opening)).toBe(true);
    const taken = {
      agents: [agent({ asked: [instruction('i1', '/review', { reply: 'Looks good.' })] })],
      projects: [{ id: 'p1', opening: [] }],
    } as unknown as Snapshot;
    expect(stillWaiting(taken, opening)).toBe(true);
    expect(replyFor(taken, opening)?.reply).toBe('Looks good.');
    const dropped = { agents: [], projects: [{ id: 'p1', opening: [] }] } as unknown as Snapshot;
    expect(stillWaiting(dropped, opening)).toBe(false);
  });

  it('says who replied and with which AI, and clips a long reply at a word', () => {
    expect(relayLine(relay, 'Added 4 tests.').text).toBe('Ledger (Claude) replied: Added 4 tests.');
    const long = relayLine(relay, 'word '.repeat(200));
    expect(long.clipped).toBe(true);
    expect(long.text.endsWith('word…')).toBe(true);
    expect(long.spoken.length).toBeLessThan(long.text.length);
  });

  it('leaves short text alone', () => {
    expect(clipWords('  a  short\nreply ', 50)).toBe('a short reply');
  });
});

describe('promptCards', () => {
  it('shows waiting, thinking and replied prompts, newest first, at most three', () => {
    const cards = promptCards(
      [
        agent({
          queued: [
            instruction('q1', 'later', { time: NOW - 1000, status: 'waiting_for_checkpoint' }),
          ],
          asked: [
            instruction('i1', 'first', { time: NOW - 4000 }),
            instruction('i2', 'second', { time: NOW - 3000, reply: 'Done.', repliedAt: NOW - 100 }),
            instruction('i3', 'old', {
              time: NOW - 9000,
              reply: 'Old.',
              repliedAt: NOW - REPLIED_SHOWN_MS - 1,
            }),
          ],
        }),
      ],
      NOW,
      new Set(),
    );
    expect(cards.map((card) => [card.id, card.status])).toEqual([
      ['q1', 'queued'],
      ['i2', 'replied'],
      ['i1', 'thinking'],
    ]);
    expect(cards[0]!.ai).toBe('Claude · claude-sonnet-4-5');
  });

  it('leaves out cards the person closed', () => {
    const cards = promptCards(
      [agent({ asked: [instruction('i1', 'first')] })],
      NOW,
      new Set(['i1']),
    );
    expect(cards).toEqual([]);
  });
});
