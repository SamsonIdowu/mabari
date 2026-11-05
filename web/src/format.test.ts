// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  agoText,
  clockText,
  emptyLogText,
  etaLong,
  etaShort,
  filterLog,
  logAgents,
  logTypes,
  minsText,
  modelLabel,
} from './format.ts';
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

describe('etaLong', () => {
  it('gives the time left and when it should finish', () => {
    const text = etaLong({ state: 'editing', estimate: { ...estimate(360), finishAt: 0 } });
    expect(text).toMatch(/^About 6 min left, done around \d\d:\d\d$/);
  });

  it('says so near the end', () => {
    expect(etaLong({ state: 'running', estimate: estimate(30) })).toContain('Under a minute left');
  });

  it('explains why there is no estimate', () => {
    expect(etaLong({ state: 'approval', estimate: null })).toBe(
      'Paused until you decide on the approval',
    );
  });
});

describe('modelLabel', () => {
  it.each([
    ['claude-sonnet-4-5', 'sonnet-4.5'],
    ['gpt-5-codex', 'gpt-5-codex'],
    ['qwen2.5-coder · local', 'qwen2.5-coder'],
  ])('shortens %s', (model, label) => {
    expect(modelLabel(model)).toBe(label);
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

  it('filters by agent', () => {
    expect(filterLog(rows, '', 'all', 'Atlas').map((row) => row.type)).toEqual(['Approval']);
    expect(filterLog(rows, '', 'all', 'all')).toHaveLength(2);
    expect(filterLog(rows, '', 'Instruction', 'Atlas')).toEqual([]);
  });
});

describe('the log filters', () => {
  it('offer every kind of entry the server writes, sessions included', () => {
    expect(logTypes([]).map(([id]) => id)).toEqual(['Instruction', 'Query', 'Approval', 'Session']);
  });

  it('add a kind that is in the log but not known', () => {
    const log = [{ type: 'Error' }, { type: 'Session' }, { type: 'Error' }] as LogEntry[];
    expect(logTypes(log).at(-1)).toEqual(['Error', 'Error']);
    expect(logTypes(log)).toHaveLength(5);
  });

  it('list each agent once, by name', () => {
    const log = [{ agent: 'Sage' }, { agent: 'Atlas' }, { agent: 'Sage' }, { agent: '' }];
    expect(logAgents(log as LogEntry[])).toEqual(['Atlas', 'Sage']);
  });

  it('say nothing has happened when the log is empty, and that nothing matches otherwise', () => {
    expect(emptyLogText(0)).toMatch(/^Nothing has happened yet/);
    expect(emptyLogText(4)).toMatch(/^Nothing matches/);
  });
});

describe('times', () => {
  it('use 24 hours with a leading zero, as the log and the estimates do', () => {
    expect(clockText(new Date(2026, 10, 5, 7, 5).getTime())).toBe('07:05');
    expect(clockText(new Date(2026, 10, 5, 19, 41).getTime())).toBe('19:41');
  });

  // The browser's own time format follows the language setting, so the chat and the panel said
  // 07:38 PM where the log said 19:41. Every screen uses clockText instead.
  it('are not left to the browser anywhere in the app', () => {
    const root = fileURLToPath(new URL('.', import.meta.url));
    const sources = (readdirSync(root, { recursive: true }) as string[]).filter(
      (file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file),
    );
    expect(sources.length).toBeGreaterThan(50);
    const offenders = sources.filter((file) =>
      readFileSync(join(root, file), 'utf8').includes('toLocaleTimeString'),
    );
    expect(offenders).toEqual([]);
  });
});
