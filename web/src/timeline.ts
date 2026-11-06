// SPDX-License-Identifier: Apache-2.0
import { clockText } from './format.ts';
import type { Timeline, TimelineBlock, TimelineLane, TimelineMarker } from './gen/models.ts';

// The page only lays out what the server worked out about the day: where on the axis a block goes,
// and how the lane reads aloud. Nothing here decides who worked when.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The stretch of the day the chart covers, and where its ticks fall, all in milliseconds. */
export interface Axis {
  start: number;
  end: number;
  ticks: { at: number; label: string }[];
}

/** What a block says, as a person would: the phrase after the agent's name. */
export function kindPhrase(kind: string): string {
  switch (kind) {
    case 'working':
      return 'working';
    case 'approval':
      return 'waiting for your approval';
    case 'question':
      return 'waiting for your answer';
    case 'error':
      return 'stopped by an error';
    default:
      return kind;
  }
}

/** The legend's words for each kind of block. */
export function kindLabel(kind: string): string {
  const phrase = kindPhrase(kind);
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

function hourFloor(time: number): number {
  const date = new Date(time);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

function hourCeil(time: number): number {
  const floor = hourFloor(time);
  return floor === time ? time : floor + HOUR;
}

/** How far apart the ticks are, so the axis never has more than about a dozen. */
function tickStep(span: number): number {
  if (span <= 2 * HOUR) return 30 * MINUTE;
  if (span <= 6 * HOUR) return HOUR;
  if (span <= 12 * HOUR) return 2 * HOUR;
  return 3 * HOUR;
}

/**
 * The part of the day worth drawing: from the hour the first thing happened to the hour after the
 * last, and up to now on today, at least an hour, so a quiet day isn't stretched across the page.
 * It is null when nothing happened.
 */
export function axisFor(timeline: Timeline): Axis | null {
  const times: number[] = [];
  for (const lane of timeline.lanes) {
    for (const block of lane.blocks) times.push(block.from, block.to);
    for (const marker of lane.markers) times.push(marker.time);
  }
  if (!times.length) return null;
  const live = timeline.now >= timeline.start && timeline.now < timeline.end;
  const first = Math.min(...times);
  const last = Math.max(...times, live ? timeline.now : 0);
  const start = Math.max(timeline.start, hourFloor(first));
  const end = Math.min(timeline.end, Math.max(hourCeil(last), start + HOUR));
  const ticks: Axis['ticks'] = [];
  const step = tickStep(end - start);
  for (let at = start; at <= end; at += step) ticks.push({ at, label: clockText(at) });
  return { start, end, ticks };
}

/** Where a moment falls on the axis, as a percentage, kept inside it. */
export function percent(axis: Axis, at: number): number {
  const span = axis.end - axis.start;
  return Math.min(100, Math.max(0, ((at - axis.start) / span) * 100));
}

/** The left edge and width of a block, as percentages of the axis. */
export function blockBox(axis: Axis, block: Pick<TimelineBlock, 'from' | 'to'>) {
  const left = percent(axis, block.from);
  return { left, width: Math.max(0, percent(axis, block.to) - left) };
}

function markerWords(marker: TimelineMarker): string {
  const what = marker.kind === 'approval' ? 'approval' : 'instruction';
  const text = marker.text ? `: ${marker.text}` : '';
  return `${what} at ${clockText(marker.time)}${text}, ${marker.outcome.toLowerCase()}`;
}

/** One agent's row read aloud: its blocks, then its markers. */
export function laneText(lane: TimelineLane): string {
  const blocks = lane.blocks.map(
    (block) =>
      `${kindPhrase(block.kind)} from ${clockText(block.from)} to ${block.open ? 'now' : clockText(block.to)}`,
  );
  const parts = [`${lane.agent}: ${blocks.length ? blocks.join('; ') : 'nothing drawn'}`];
  if (lane.markers.length) parts.push(lane.markers.map(markerWords).join('; '));
  return `${parts.join('. ')}.`;
}

/** What a block's tooltip says. */
export function blockTitle(lane: TimelineLane, block: TimelineBlock): string {
  const end = block.open ? 'now' : clockText(block.to);
  return `${lane.agent} was ${kindPhrase(block.kind)} from ${clockText(block.from)} to ${end}`;
}

/** What a marker's tooltip says. */
export function markerTitle(lane: TimelineLane, marker: TimelineMarker): string {
  return `${lane.agent}: ${markerWords(marker)}`;
}

/** The sentence before the chart, for a screen reader: how many agents, and for which day. */
export function summaryText(timeline: Timeline, today: boolean): string {
  const count = timeline.lanes.length;
  const day = today ? 'today' : timeline.day;
  if (!count) return `Nothing has happened ${today ? 'yet today' : `on ${timeline.day}`}.`;
  return `Timeline for ${day}: ${count} agent${count === 1 ? '' : 's'}. Each agent's row says when it worked, waited for you or stopped with an error, and when you gave it instructions or it asked for approval. Choose an agent's name to open it.`;
}

/** The day a day name is the neighbour of, such as `2026-11-05` before `2026-11-06`. */
export function neighbourDay(day: string, step: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const moved = new Date(year, month - 1, date + step);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${moved.getFullYear()}-${pad(moved.getMonth() + 1)}-${pad(moved.getDate())}`;
}

const WEEKDAYS = 'Sun Mon Tue Wed Thu Fri Sat'.split(' ');
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

/** A day for the heading: "Thu 5 Nov". */
export function dayName(day: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const at = new Date(year, month - 1, date);
  return `${WEEKDAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]}`;
}
