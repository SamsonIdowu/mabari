// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { agoText, etaShort, filterLog, minsText } from './format.ts';
import type { AgentState, Estimate, LogEntry } from './gen/models.ts';

const estimate = (secondsLeft: number) => ({ secondsLeft }) as Estimate;

describe('minsText', () => {
  it.each([
    [30, '1 min'],
    [600, '10 min'],
    [3600, '1 h'],
    [3900, '1 h 5 min'],
  ])('formats %i seconds', (seconds, text) => {
    expect(minsText(seconds)).toBe(text);
  });
});

describe('agoText', () => {
  const now = 1_000_000_000;
  it.each([
    [0, 'just now'],
    [5 * 60_000, '5 min ago'],
    [60 * 60_000, '1 hour ago'],
    [3 * 3_600_000, '3 hours ago'],
    [51 * 3_600_000, '2 days ago'],
  ])('formats %i ms', (age, text) => {
    expect(agoText(now - age, now)).toBe(text);
  });
});

describe('etaShort', () => {
  it('shows minutes left for working agents', () => {
    expect(etaShort({ state: 'editing', estimate: estimate(360) })).toBe('~6m');
    expect(etaShort({ state: 'editing', estimate: estimate(5) })).toBe('~1m');
  });

  it.each([
    ['approval', 'paused'],
    ['paused', 'paused'],
    ['idle', ''],
    ['done', 'done'],
    ['error', 'stopped'],
  ] as [AgentState, string][])('has fixed wording for %s', (state, short) => {
    expect(etaShort({ state, estimate: null })).toBe(short);
  });
});

describe('filterLog', () => {
  const rows = [
    { agent: 'Sage', type: 'Instruction', message: 'Add a changelog', outcome: 'Delivered' },
    { agent: 'Atlas', type: 'Approval', message: 'rm -rf ./tmp', outcome: 'Denied' },
  ] as LogEntry[];

  it('filters by type', () => {
    expect(filterLog(rows, '', 'Approval').map((row) => row.agent)).toEqual(['Atlas']);
  });

  it('searches agent, message and outcome, ignoring case', () => {
    expect(filterLog(rows, 'SAGE', 'all')).toHaveLength(1);
    expect(filterLog(rows, 'denied', 'all')).toHaveLength(1);
    expect(filterLog(rows, 'changelog', 'all')).toHaveLength(1);
  });

  it('combines both', () => {
    expect(filterLog(rows, 'sage', 'Approval')).toEqual([]);
  });
});
