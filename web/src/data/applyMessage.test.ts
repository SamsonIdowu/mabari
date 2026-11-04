// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type {
  Event,
  LiveAgent,
  LogEntry,
  Project,
  ServerMessage,
  Snapshot,
} from '../gen/models.ts';
import { applyMessage } from './applyMessage.ts';

const agent = (overrides: Partial<LiveAgent> = {}) =>
  ({ id: 'a', name: 'Scout', feed: [], queued: [], ...overrides }) as LiveAgent;

const event = (id: string): Event => ({
  id,
  agentId: 'a',
  time: 1,
  tool: 't',
  summary: '',
  raw: null,
});

const snapshot = (overrides: Partial<Snapshot> = {}) =>
  ({
    seq: 1,
    agents: [],
    projects: [],
    accounts: [],
    messages: [],
    log: [],
    ...overrides,
  }) as unknown as Snapshot;

const message = (fields: Partial<ServerMessage>): ServerMessage =>
  ({ seq: 2, type: 'toast', ...fields }) as ServerMessage;

describe('applyMessage', () => {
  it('advances the sequence number on any message', () => {
    expect(applyMessage(snapshot(), message({ type: 'toast', text: 'Hi' })).seq).toBe(2);
  });

  it('adds a new agent', () => {
    const next = applyMessage(snapshot(), message({ type: 'agent', agent: agent() }));
    expect(next.agents).toHaveLength(1);
  });

  it('keeps the feed when an agent changes, because updates leave it out', () => {
    const state = snapshot({ agents: [agent({ feed: [event('e1')] })] });
    const update = { ...agent({ task: 'New' }), feed: null } as unknown as LiveAgent;
    const next = applyMessage(state, message({ type: 'agent', agent: update }));
    expect(next.agents[0]?.task).toBe('New');
    expect(next.agents[0]?.feed).toHaveLength(1);
  });

  it('puts new events first and limits the feed', () => {
    const feed = Array.from({ length: 40 }, (_, index) => event(`e${index}`));
    const state = snapshot({ agents: [agent({ feed })] });
    const next = applyMessage(state, message({ type: 'event', event: event('new') }));
    expect(next.agents[0]?.feed).toHaveLength(40);
    expect(next.agents[0]?.feed[0]?.id).toBe('new');
  });

  it('removes agents and projects by id', () => {
    const state = snapshot({ agents: [agent()], projects: [{ id: 'p' } as Project] });
    expect(applyMessage(state, message({ type: 'agent.remove', id: 'a' })).agents).toEqual([]);
    expect(applyMessage(state, message({ type: 'agent.remove', id: 'p' })).projects).toEqual([]);
  });

  it('updates a log row in place and adds new rows first', () => {
    const row = { id: '1', outcome: 'Waiting' } as LogEntry;
    const state = snapshot({ log: [row] });
    const updated = { ...row, outcome: 'Delivered' };
    expect(applyMessage(state, message({ type: 'log', log: updated })).log).toEqual([updated]);
    const added = { id: '2' } as LogEntry;
    expect(applyMessage(state, message({ type: 'log', log: added })).log[0]).toBe(added);
  });

  it('leaves the snapshot it was given alone', () => {
    const state = snapshot({ agents: [agent()] });
    const before = JSON.stringify(state);
    applyMessage(state, message({ type: 'event', event: event('new') }));
    expect(JSON.stringify(state)).toBe(before);
  });

  it('skips a message the snapshot already holds', () => {
    const state = snapshot({ seq: 5, agents: [agent()] });
    expect(applyMessage(state, message({ seq: 5, type: 'event', event: event('old') }))).toBe(
      state,
    );
    expect(applyMessage(state, message({ seq: 3, type: 'event', event: event('old') }))).toBe(
      state,
    );
    const next = applyMessage(state, message({ seq: 6, type: 'event', event: event('new') }));
    expect(next.seq).toBe(6);
    expect(next.agents[0]?.feed?.map((item) => item.id)).toEqual(['new']);
  });
});
