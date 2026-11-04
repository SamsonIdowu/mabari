// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { Message } from '../gen/models.ts';
import { chipFor, kindColor, latestFor, SHOW_MS } from './talk.ts';

const message = (id: string, time: number, kind = 'question', from = 'a', to = 'b'): Message =>
  ({ id, fromAgent: from, toAgents: [to], kind, text: 'x', time }) as Message;

const names: Record<string, string> = { a: 'Sage', b: 'Ledger', c: 'Atlas' };
const nameOf = (id: string) => names[id] ?? id;

describe('floor messages', () => {
  it('chips the sender with "To" and the receiver with "From", in the kind colour', () => {
    const messages = [message('1', 1000)];
    expect(chipFor('a', messages, 2000, nameOf)).toEqual({
      text: '↗ To Ledger · Question',
      color: '#48DBFB',
      incoming: false,
    });
    expect(chipFor('b', messages, 2000, nameOf)).toEqual({
      text: '✉ From Sage · Question',
      color: '#48DBFB',
      incoming: true,
    });
    expect(chipFor('c', messages, 2000, nameOf)).toBeNull();
  });

  it('shows the newest message and fades after about 4 seconds', () => {
    const messages = [message('1', 1000), message('2', 2000, 'answer', 'b', 'a')];
    expect(latestFor('a', messages, 2500)?.id).toBe('2');
    expect(latestFor('a', messages, 2000 + SHOW_MS + 1)).toBeNull();
  });

  it('uses the prototype colours', () => {
    expect(kindColor('answer')).toBe('#4FB3FF');
    expect(kindColor('broadcast')).toBe('#8E8E93');
  });
});
