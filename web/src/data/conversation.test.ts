// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { ConversationItem, ServerMessage } from '../gen/models.ts';
import { applyToThread, emptyThread, mergePage, type Thread } from './conversation.ts';

function item(seq: number, text: string, streaming = false): ConversationItem {
  return {
    id: `i${seq}`,
    agentId: 'a1',
    seq,
    time: seq,
    kind: 'assistant',
    text,
    streaming,
    tool: null,
    from: '',
    parent: '',
    clipped: false,
  };
}

const thread = (...items: ConversationItem[]): Thread => ({ items, hasMore: false, loaded: true });
const message = (fields: Partial<ServerMessage>): ServerMessage =>
  ({ seq: 1, ...fields }) as ServerMessage;
const added = (entry: ConversationItem) => message({ type: 'conversation', item: entry });
const delta = (id: string, text: string) =>
  message({ type: 'conversation.delta', id, agentId: 'a1', text });

describe('applyToThread', () => {
  it('adds a new item at the end', () => {
    expect(
      applyToThread(thread(item(1, 'a')), added(item(2, 'b'))).items.map((i) => i.text),
    ).toEqual(['a', 'b']);
  });

  it('replaces an item by its number, as when a tool call gets its result', () => {
    const next = applyToThread(thread(item(1, 'a'), item(2, 'b')), added(item(1, 'done')));
    expect(next.items.map((i) => i.text)).toEqual(['done', 'b']);
  });

  it('keeps items in order when one arrives late', () => {
    const next = applyToThread(thread(item(1, 'a'), item(3, 'c')), added(item(2, 'b')));
    expect(next.items.map((i) => i.seq)).toEqual([1, 2, 3]);
  });

  it('builds streaming text from deltas', () => {
    let next = thread(item(1, '', true));
    next = applyToThread(next, delta('i1', 'hel'));
    next = applyToThread(next, delta('i1', 'lo'));
    expect(next.items[0]?.text).toBe('hello');
  });

  it('ignores a late delta for a finished item, which already has all of its text', () => {
    expect(applyToThread(thread(item(1, 'hello')), delta('i1', 'lo')).items[0]?.text).toBe('hello');
  });

  it('ignores a delta for an item it does not hold', () => {
    expect(applyToThread(thread(item(1, 'a')), delta('nope', 'x')).items[0]?.text).toBe('a');
  });

  it('never changes the thread it is given', () => {
    const before = thread(item(1, '', true));
    applyToThread(before, delta('i1', 'x'));
    expect(before.items[0]?.text).toBe('');
  });

  it('ignores other messages', () => {
    const before = thread(item(1, 'a'));
    expect(applyToThread(before, message({ type: 'toast', text: 'hi' }))).toBe(before);
  });
});

describe('mergePage', () => {
  it('fills an empty thread', () => {
    const next = mergePage(
      emptyThread,
      { agentId: 'a1', items: [item(1, 'a')], hasMore: true },
      false,
    );
    expect(next).toEqual({ items: [item(1, 'a')], hasMore: true, loaded: true });
  });

  it('keeps what arrived while the page was on its way', () => {
    const next = mergePage(
      thread(item(3, 'new')),
      { agentId: 'a1', items: [item(1, 'a'), item(2, 'b')], hasMore: false },
      false,
    );
    expect(next.items.map((i) => i.seq)).toEqual([1, 2, 3]);
  });

  it('keeps a finished copy over the streaming one the server stored', () => {
    const next = mergePage(
      thread(item(2, 'all of it')),
      { agentId: 'a1', items: [item(2, '', true)], hasMore: false },
      false,
    );
    expect(next.items).toEqual([item(2, 'all of it')]);
  });

  it('puts older items before what is held', () => {
    const next = mergePage(
      thread(item(4, 'd')),
      { agentId: 'a1', items: [item(2, 'b'), item(3, 'c')], hasMore: false },
      true,
    );
    expect(next.items.map((i) => i.seq)).toEqual([2, 3, 4]);
    expect(next.hasMore).toBe(false);
  });

  it('treats a page with no items as empty', () => {
    const next = mergePage(emptyThread, { agentId: 'a1', items: [], hasMore: false }, false);
    expect(next.items).toEqual([]);
    expect(next.loaded).toBe(true);
  });
});
