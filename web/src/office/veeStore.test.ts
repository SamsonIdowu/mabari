// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type VeeResult } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import type { Instruction, LiveAgent, Snapshot } from '../gen/models.ts';
import { useVee, VEE_HELLO } from './veeStore.ts';

const asked = (reply = ''): Instruction => ({
  id: 'ins-1',
  agentId: 'a1',
  text: 'update the README',
  mode: 'instruct',
  status: 'delivered',
  time: 1,
  logId: '',
  reply,
  repliedAt: reply ? 2 : 0,
});

function office(reply = ''): Snapshot {
  const agent = {
    id: 'a1',
    name: 'Ledger',
    queued: [],
    asked: [asked(reply)],
  } as unknown as LiveAgent;
  return { seq: 1, agents: [agent], settings: { spokenReplies: false } } as unknown as Snapshot;
}

const dispatched: VeeResult = {
  reply: {
    ...VEE_HELLO,
    text: "On it, sent to Ledger (Claude). I'll read you the reply the moment it lands.",
    relay: { agentId: 'a1', instructionId: 'ins-1', agent: 'Ledger', ai: 'Claude' },
  },
  message: null,
};

describe('Mabari relays replies', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {});
    vi.useFakeTimers();
    useVee.getState().reset();
    useOfficeStore.setState({ office: office() });
    vi.spyOn(api, 'vee').mockResolvedValue(dispatched);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('acknowledges at once, then posts the reply the moment it arrives', async () => {
    useVee.getState().setOnHome(true);
    await useVee.getState().hear('update the README');
    expect(useVee.getState().said.text).toContain('On it, sent to Ledger (Claude).');
    expect(useVee.getState().relays).toHaveLength(1);
    useOfficeStore.setState({ office: office('Updated the install steps.') });
    await vi.advanceTimersByTimeAsync(1000);
    expect(useVee.getState().said.text).toBe('Ledger (Claude) replied: Updated the install steps.');
    expect(useVee.getState().relays).toHaveLength(0);
    expect(useVee.getState().unread).toBe(0);
  });

  it('counts the reply on Home when you are elsewhere, and clears it when you come back', async () => {
    useVee.getState().setOnHome(false);
    await useVee.getState().hear('update the README');
    useOfficeStore.setState({ office: office('Done.') });
    await vi.advanceTimersByTimeAsync(1000);
    expect(useVee.getState().unread).toBe(1);
    useVee.getState().setOnHome(true);
    expect(useVee.getState().unread).toBe(0);
  });

  it('relays a reply that was already there, after the acknowledgement', async () => {
    useOfficeStore.setState({ office: office('Got it.') });
    await useVee.getState().hear('update the README');
    expect(useVee.getState().said.text).toContain('On it');
    await vi.advanceTimersByTimeAsync(1000);
    expect(useVee.getState().said.text).toBe('Ledger (Claude) replied: Got it.');
  });

  it("keeps one update from Mabari's rounds per project, so replies aren't crowded out", () => {
    const store = useVee.getState();
    store.report('shop', 'Shop: 2 working.');
    store.report('docs', 'Docs: 1 working.');
    store.report('shop', 'Shop: 3 working.');
    const rounds = useVee.getState().updates.filter((update) => update.about !== undefined);
    expect(rounds.map((update) => update.text)).toEqual(['Docs: 1 working.', 'Shop: 3 working.']);
  });
});
