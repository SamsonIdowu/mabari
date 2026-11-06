// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { costText, workedText } from './cardText.ts';

describe('the card as text', () => {
  it('says time worked in plain words, and never "0 min"', () => {
    expect(workedText(0)).toBe('< 1 min');
    expect(workedText(59)).toBe('< 1 min');
    expect(workedText(60)).toBe('1 min');
    expect(workedText(20 * 60)).toBe('20 min');
    expect(workedText(72 * 60)).toBe('1 h 12 min');
    expect(workedText(2 * 3600)).toBe('2 h');
  });

  it('shows a dash, not $0.00, when the agent has no cost counted', () => {
    expect(costText({ cost: 0, costKnown: false })).toBe('–');
    expect(costText({ cost: 0.9, costKnown: true })).toBe('$0.90');
    expect(costText({ cost: 12.345, costKnown: true })).toBe('$12.35');
  });
});
