// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { Message } from '../gen/models.ts';
import { kindColor, Talk } from './talk.ts';

const message = (id: string, kind = 'handoff'): Message =>
  ({ id, fromAgent: 'a', toAgents: ['b'], kind, text: 'x', time: 0 }) as Message;

const where = (id: string) => (id === 'a' ? { x: 0, y: 0 } : id === 'b' ? { x: 100, y: 0 } : null);

describe('Talk', () => {
  it('flies an envelope only for messages sent after the floor opened', () => {
    const talk = new Talk();
    talk.update([message('1'), message('2')], where, 0);
    expect(talk.flying).toBe(0);
    talk.update([message('1'), message('2'), message('3')], where, 10);
    talk.update([message('1'), message('2'), message('3')], where, 20);
    expect(talk.flying).toBe(1);
  });

  it('skips agents that are not on the floor', () => {
    const talk = new Talk();
    talk.update([], where, 0);
    talk.update([{ ...message('9'), toAgents: ['gone'] }], where, 10);
    expect(talk.flying).toBe(0);
  });

  it('uses the prototype colours', () => {
    expect(kindColor('answer')).toBe('#4FB3FF');
    expect(kindColor('broadcast')).toBe('#8E8E93');
  });
});
