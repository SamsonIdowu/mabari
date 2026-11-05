// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveAgent, ServerMessage, Snapshot } from '../gen/models.ts';
import { useOfficeStore } from './officeStore.ts';

const agent = (name: string) => ({ id: name, name, feed: [], queued: [] }) as unknown as LiveAgent;

const snapshot = (seq: number) =>
  ({ seq, agents: [], projects: [], accounts: [], messages: [], log: [] }) as unknown as Snapshot;

const change = (seq: number, name: string): ServerMessage =>
  ({ seq, type: 'agent', agent: agent(name) }) as ServerMessage;

const toast = (seq: number, text: string): ServerMessage =>
  ({ seq, type: 'toast', text }) as ServerMessage;

beforeEach(() => {
  vi.useFakeTimers();
  useOfficeStore.setState({ office: snapshot(1), toasts: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('applyAll', () => {
  it('applies every message in order and tells the screens once', () => {
    const seen: (Snapshot | null)[] = [];
    const stop = useOfficeStore.subscribe((state) => seen.push(state.office));
    const messages = [change(2, 'Atlas'), change(3, 'Mori'), change(4, 'Atlas')];
    useOfficeStore.getState().applyAll(messages);
    stop();
    expect(seen).toHaveLength(1);
    const office = useOfficeStore.getState().office!;
    expect(office.seq).toBe(4);
    expect(office.agents.map((item) => item.name)).toEqual(['Atlas', 'Mori']);
  });

  it('leaves out a message the office already holds, and a toast with it', () => {
    const seen: unknown[] = [];
    const stop = useOfficeStore.subscribe((state) => seen.push(state));
    useOfficeStore.getState().applyAll([toast(1, 'old'), change(1, 'Old')]);
    stop();
    expect(seen).toHaveLength(0);
    expect(useOfficeStore.getState().office!.agents).toEqual([]);
    expect(useOfficeStore.getState().toasts).toEqual([]);
  });

  it('shows a toast once, and applies the messages around it', () => {
    useOfficeStore.getState().applyAll([change(2, 'Atlas'), toast(3, 'Atlas is ready')]);
    expect(useOfficeStore.getState().toasts.map((item) => item.text)).toEqual(['Atlas is ready']);
    expect(useOfficeStore.getState().office!.seq).toBe(3);
  });

  it('does nothing before the first snapshot', () => {
    useOfficeStore.setState({ office: null });
    useOfficeStore.getState().applyAll([change(2, 'Atlas')]);
    expect(useOfficeStore.getState().office).toBeNull();
  });

  it('apply is the same thing for one message', () => {
    useOfficeStore.getState().apply(change(2, 'Atlas'));
    expect(useOfficeStore.getState().office!.agents.map((item) => item.name)).toEqual(['Atlas']);
  });
});
