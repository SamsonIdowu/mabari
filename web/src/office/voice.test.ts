// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { LiveAgent } from '../gen/models.ts';
import { detect } from './voice.ts';

const agent = (name: string) => ({ id: name, name }) as unknown as LiveAgent;
const team = [agent('Atlas'), agent('Atlas scribe'), agent('Scout'), agent('Ledger')];

describe('detect', () => {
  it.each([
    ['Scout, add the pricing pages to your comparison', 'Scout', 'instruct'],
    ['What is Ledger working on right now', 'Ledger', 'query'],
    ['Ledger, how is it going', 'Ledger', 'query'],
    ['Sage, also update the API docs', null, 'instruct'],
    ['is scout finished?', 'Scout', 'query'],
    ['Atlas scribe, draft the notes', 'Atlas scribe', 'instruct'],
    ['Tidy the readme', null, 'instruct'],
  ])('%s', (text, name, mode) => {
    const heard = detect(text, team, null);
    expect(heard.agent?.name ?? null).toBe(name);
    expect(heard.mode).toBe(mode);
  });

  it('falls back to the selected agent', () => {
    expect(detect('Tidy the readme', team, team[3]!).agent?.name).toBe('Ledger');
  });

  it('does not find a name inside another word', () => {
    expect(detect('Check the scouting report', team, null).agent).toBeNull();
  });

  it.each([
    ['Atlas, go ahead and allow the migration', true],
    ['approve that', true],
    ['Atlas, add the migration', false],
    ['Scout, reallow nothing', false],
  ])('%s', (text, approval) => {
    expect(detect(text, team, null).approval).toBe(approval);
  });
});
