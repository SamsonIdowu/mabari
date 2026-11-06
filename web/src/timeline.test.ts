// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { Timeline, TimelineLane } from './gen/models.ts';
import {
  axisFor,
  blockBox,
  blockTitle,
  dayName,
  kindLabel,
  kindPhrase,
  laneText,
  markerTitle,
  neighbourDay,
  percent,
  summaryText,
} from './timeline.ts';

const HOUR = 3_600_000;
// Times are written in this computer's own zone, as the page shows them.
const at = (hours: number, minutes = 0) => new Date(2026, 10, 6, hours, minutes).getTime();

const lane = (patch: Partial<TimelineLane> = {}): TimelineLane => ({
  agentId: 'a1',
  agent: 'Atlas',
  provider: 'claude',
  present: true,
  blocks: [],
  markers: [],
  ...patch,
});

const day = (lanes: TimelineLane[], now = at(11)): Timeline => ({
  day: '2026-11-06',
  start: at(0),
  end: at(24),
  now,
  lanes,
});

describe('the axis', () => {
  it('is null when nothing happened', () => {
    expect(axisFor(day([]))).toBeNull();
    expect(axisFor(day([lane()]))).toBeNull();
  });

  it('runs from the hour of the first thing to the hour after the last, and up to now on today', () => {
    const timeline = day([
      lane({ blocks: [{ kind: 'working', from: at(9, 20), to: at(9, 50), open: false }] }),
      lane({
        agentId: 'a2',
        blocks: [{ kind: 'error', from: at(10, 5), to: at(10, 40), open: false }],
      }),
    ]);
    const axis = axisFor(timeline);
    expect(axis?.start).toBe(at(9));
    // Now is 11:00, which is later than the last block.
    expect(axis?.end).toBe(at(11));
  });

  it('does not stretch past the last thing on a day that is over', () => {
    const timeline = {
      ...day([
        lane({ blocks: [{ kind: 'working', from: at(9, 20), to: at(10, 10), open: false }] }),
      ]),
      now: at(24) + 5 * HOUR,
    };
    expect(axisFor(timeline)).toMatchObject({ start: at(9), end: at(11) });
  });

  it('is at least an hour, so a few seconds of work is not the whole width', () => {
    const timeline = day(
      [lane({ blocks: [{ kind: 'working', from: at(9, 41), to: at(9, 42), open: false }] })],
      at(9, 42),
    );
    expect(axisFor(timeline)).toMatchObject({ start: at(9), end: at(10) });
  });

  it('stays inside the day', () => {
    const timeline = day(
      [lane({ blocks: [{ kind: 'working', from: at(23, 30), to: at(24), open: false }] })],
      at(24) + HOUR,
    );
    expect(axisFor(timeline)).toMatchObject({ start: at(23), end: at(24) });
  });

  it('counts a marker with no block as something that happened', () => {
    const timeline = day(
      [
        lane({
          markers: [{ kind: 'instruction', time: at(8, 30), text: 'x', outcome: 'Delivered' }],
        }),
      ],
      at(8, 45),
    );
    expect(axisFor(timeline)).toMatchObject({ start: at(8), end: at(9) });
  });

  it('puts a tick at each step, with its time', () => {
    const timeline = day(
      [lane({ blocks: [{ kind: 'working', from: at(9), to: at(12), open: false }] })],
      at(12),
    );
    const axis = axisFor(timeline);
    expect(axis?.ticks.map((tick) => tick.label)).toEqual(['09:00', '10:00', '11:00', '12:00']);
    // A short day is ticked every half hour, a long one every few hours.
    const short = axisFor(
      day([lane({ blocks: [{ kind: 'working', from: at(9), to: at(10), open: false }] })], at(10)),
    );
    expect(short?.ticks.map((tick) => tick.label)).toEqual(['09:00', '09:30', '10:00']);
    const long = axisFor(
      day([lane({ blocks: [{ kind: 'working', from: at(1), to: at(21), open: false }] })], at(21)),
    );
    expect(long?.ticks.map((tick) => tick.label)).toEqual([
      '01:00',
      '04:00',
      '07:00',
      '10:00',
      '13:00',
      '16:00',
      '19:00',
    ]);
  });
});

describe('where things fall on the axis', () => {
  const axis = { start: at(9), end: at(11), ticks: [] };
  it('is a percentage of the axis, kept inside it', () => {
    expect(percent(axis, at(9))).toBe(0);
    expect(percent(axis, at(10))).toBe(50);
    expect(percent(axis, at(11))).toBe(100);
    expect(percent(axis, at(8))).toBe(0);
    expect(percent(axis, at(12))).toBe(100);
  });
  it('gives a block its left edge and width', () => {
    expect(blockBox(axis, { from: at(9, 30), to: at(10, 30) })).toEqual({ left: 25, width: 50 });
    expect(blockBox(axis, { from: at(10), to: at(10) }).width).toBe(0);
  });
});

describe('what the chart says in words', () => {
  it('names each kind of block', () => {
    expect(kindPhrase('working')).toBe('working');
    expect(kindPhrase('approval')).toBe('waiting for your approval');
    expect(kindPhrase('question')).toBe('waiting for your answer');
    expect(kindPhrase('error')).toBe('stopped by an error');
    expect(kindLabel('approval')).toBe('Waiting for your approval');
  });

  const atlas = lane({
    blocks: [
      { kind: 'working', from: at(9), to: at(9, 30), open: false },
      { kind: 'approval', from: at(9, 30), to: at(9, 50), open: false },
      { kind: 'working', from: at(9, 50), to: at(11), open: true },
    ],
    markers: [
      { kind: 'instruction', time: at(9, 10), text: 'Use the money helper', outcome: 'Delivered' },
      { kind: 'approval', time: at(9, 30), text: 'npm run db:migrate', outcome: 'Allowed' },
    ],
  });

  it('reads a row as a sentence, its blocks first and then its markers', () => {
    expect(laneText(atlas)).toBe(
      'Atlas: working from 09:00 to 09:30; waiting for your approval from 09:30 to 09:50; ' +
        'working from 09:50 to now. ' +
        'instruction at 09:10: Use the money helper, delivered; approval at 09:30: npm run db:migrate, allowed.',
    );
  });

  it('says so when a row has nothing drawn, and leaves out markers it has none of', () => {
    expect(laneText(lane())).toBe('Atlas: nothing drawn.');
    expect(
      laneText(lane({ blocks: [{ kind: 'error', from: at(9), to: at(10), open: false }] })),
    ).toBe('Atlas: stopped by an error from 09:00 to 10:00.');
  });

  it('words the tooltips', () => {
    expect(blockTitle(atlas, atlas.blocks[2]!)).toBe('Atlas was working from 09:50 to now');
    expect(markerTitle(atlas, atlas.markers[1]!)).toBe(
      'Atlas: approval at 09:30: npm run db:migrate, allowed',
    );
  });

  it('opens with how many agents, and says when nothing happened', () => {
    expect(summaryText(day([atlas, lane({ agentId: 'a2' })]), true)).toMatch(
      /^Timeline for today: 2 agents\. /,
    );
    expect(summaryText(day([atlas]), false)).toMatch(/^Timeline for 2026-11-06: 1 agent\. /);
    expect(summaryText(day([]), true)).toBe('Nothing has happened yet today.');
    expect(summaryText(day([]), false)).toBe('Nothing has happened on 2026-11-06.');
  });
});

describe('days', () => {
  it('steps to the day before and after, over months and years', () => {
    expect(neighbourDay('2026-11-06', -1)).toBe('2026-11-05');
    expect(neighbourDay('2026-11-06', 1)).toBe('2026-11-07');
    expect(neighbourDay('2026-11-01', -1)).toBe('2026-10-31');
    expect(neighbourDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(neighbourDay('2024-03-01', -1)).toBe('2024-02-29');
  });
  it('names a day for the heading', () => {
    expect(dayName('2026-11-06')).toBe('Fri 6 Nov');
    expect(dayName('2026-11-05')).toBe('Thu 5 Nov');
  });
});
