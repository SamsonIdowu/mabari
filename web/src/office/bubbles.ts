// SPDX-License-Identifier: Apache-2.0
// Where speech bubbles go on a crowded floor. Every agent has a name tag under its feet and a
// bubble over its head, so in a full office the bubble of one row lands on the tags of the row
// above, and bubbles pile onto each other. A name must stay readable, so a bubble first settles
// a little nearer its agent, then drops to one line, then lifts, and if that is not enough a quiet
// one steps aside. Bubbles that need you or answer you are never hidden. This module only works
// out the boxes; overlays.ts measures the elements and applies the result.

/** A box on the floor, in pixels from its top left corner. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The pixels a bubble may settle towards its agent: the gap above a head is about 6. */
export const MAX_SETTLE = 4;
/** The pixels a bubble may lift to clear something below it. More would cut it loose from its agent. */
export const MAX_LIFT = 18;
const STEP = 2;
/** The air kept between a bubble and what it must not cover. */
export const CLEARANCE = 2;
/** The air kept between a bubble and the edge of the floor. */
export const EDGE = 4;

/**
 * Bubbles from this rank up are never hidden. Rank 3 is an approval or a question, 2 is a reply to
 * you or an agent stopped by an error, 1 is agents talking to each other, 0 is what an agent is
 * doing.
 */
export const PINNED_RANK = 2;

/**
 * The box a name tag fills. Tags and bubbles are placed by their corner and then moved by
 * `translate(-50%, ...)` and scaled with the office's zoom, in that order, so the scaled box is
 * not centred on its anchor unless the scale is 1. `x` and `y` are the tag's left and top edge
 * before the transform, `width` and `height` its size before it.
 */
export function tagBox(x: number, y: number, width: number, height: number, scale: number): Box {
  const left = x + width / 2 - scale * width;
  const top = y + 4 * scale;
  return { left, top, right: left + scale * width, bottom: top + scale * height };
}

/** The box a bubble fills: it hangs above its anchor, which is the bubble's top edge before the transform. */
export function bubbleBox(x: number, y: number, width: number, height: number, scale: number): Box {
  const left = x + width / 2 - scale * width;
  const bottom = y + height * (1 - scale);
  return { left, top: bottom - scale * height, right: left + scale * width, bottom };
}

/** Whether two boxes cover each other, with `gap` pixels of air counting as covering. */
export function overlaps(a: Box, b: Box, gap = 0): boolean {
  return (
    a.left < b.right + gap &&
    b.left < a.right + gap &&
    a.top < b.bottom + gap &&
    b.top < a.bottom + gap
  );
}

export interface BubbleItem {
  id: string;
  rank: number;
  /** Where the bubble would sit if nothing were in its way. */
  box: Box;
  /**
   * The same bubble cut to one line, which hangs from the same place so its top drops. Missing
   * when it is one line already, or when cutting it would lose what it says.
   */
  short?: Box | undefined;
  /**
   * How far it may come down towards its agent, in pixels. A bubble raised above the usual
   * place, as an agent's thought or error is, can come down by that much and a little more;
   * the default is MAX_SETTLE.
   */
  settle?: number | undefined;
  /**
   * What the bubble says, and the row of the floor its agent stands in (see `rowOf`). A quiet
   * bubble (rank 0) shows once for the same words in a row.
   */
  text?: string | undefined;
  row?: number | undefined;
}

export interface Placement {
  /** Move the bubble this many pixels up, or down when negative, to clear a tag or another bubble. */
  lift: number;
  /** Move it this many pixels sideways, to keep it on the floor. */
  shift: number;
  /** Cut it to one line. */
  short: boolean;
  hidden: boolean;
}

/** Agents whose feet are within this many pixels of the same height are in the same row. */
const ROW_HEIGHT = 40;

/** The row of the floor an agent stands in, from the height of its feet in pixels. */
export function rowOf(y: number): number {
  return Math.round(y / ROW_HEIGHT);
}

/**
 * The quiet bubbles to leave out because another says the same in the same row. Rows of desks are
 * rows of agents at the same work, and a bubble for each says "Working out what to do next" over
 * and over. The leftmost stays. Only what an agent is doing (rank 0) is thinned: what needs you,
 * answers you, reports an error or is said to another agent is never hidden for being alike.
 */
function repeats(bubbles: BubbleItem[]): Set<string> {
  const first = new Map<string, BubbleItem>();
  const hidden = new Set<string>();
  for (const bubble of bubbles) {
    if (bubble.rank !== 0 || !bubble.text || bubble.row === undefined) continue;
    const key = `${bubble.row}|${bubble.text}`;
    const kept = first.get(key);
    if (!kept) {
      first.set(key, bubble);
    } else if (bubble.box.left < kept.box.left) {
      hidden.add(kept.id);
      first.set(key, bubble);
    } else {
      hidden.add(bubble.id);
    }
  }
  return hidden;
}

/** The lifts to try, in order: where it is, then nearer its agent, never a long way. */
function settles(room: number): number[] {
  const steps = Math.floor(room / STEP);
  return [0, ...Array.from({ length: steps }, (_, index) => -(index + 1) * STEP)];
}
const LIFTS = Array.from({ length: MAX_LIFT / STEP }, (_, index) => (index + 1) * STEP);

/**
 * Where each bubble goes, given the boxes of the name tags on the floor. Higher ranks are placed
 * first, ties in the order given, so what needs you is never moved off by what is merely talking.
 * `width` is the floor's width, to keep bubbles from running off its edge.
 */
export function placeBubbles(
  bubbles: BubbleItem[],
  tags: Box[],
  width: number,
): Map<string, Placement> {
  const placed: Box[] = [];
  const result = new Map<string, Placement>();
  const alike = repeats(bubbles);
  const order = bubbles
    .map((bubble, index) => ({ bubble, index }))
    .sort((a, b) => b.bubble.rank - a.bubble.rank || a.index - b.index);
  for (const { bubble } of order) {
    // Another in the row says the same, so this one is left out, and takes no room from the rest.
    if (alike.has(bubble.id)) {
      result.set(bubble.id, { lift: 0, shift: 0, short: false, hidden: true });
      continue;
    }
    // A bubble that runs off the floor slides back in, as far as it can.
    const room = width - 2 * EDGE;
    let shift = 0;
    if (bubble.box.right - bubble.box.left <= room) {
      if (bubble.box.left < EDGE) shift = EDGE - bubble.box.left;
      else if (bubble.box.right > width - EDGE) shift = width - EDGE - bubble.box.right;
    }
    const at = (box: Box, lift: number): Box => ({
      left: box.left + shift,
      right: box.right + shift,
      top: box.top - lift,
      bottom: box.bottom - lift,
    });
    // Only what reaches where the bubble may go can stop it, which keeps a crowded floor cheap:
    // this runs for every bubble, every frame.
    const down = settles(bubble.settle ?? MAX_SETTLE);
    // The one line bubble hangs from the same place, and at a scale above 1 its bottom edge is
    // lower than the full bubble's, so what can stop it is what either reaches (REV-4).
    const boxes = bubble.short ? [bubble.box, bubble.short] : [bubble.box];
    const reach: Box = {
      left: Math.min(...boxes.map((one) => one.left)) + shift,
      right: Math.max(...boxes.map((one) => one.right)) + shift,
      top: Math.min(...boxes.map((one) => one.top)) - MAX_LIFT,
      // The lowest it may settle is the last, most negative, lift.
      bottom: Math.max(...boxes.map((one) => one.bottom)) - down[down.length - 1]!,
    };
    const nearTags = tags.filter((tag) => overlaps(reach, tag, CLEARANCE));
    const nearPlaced = placed.filter((other) => overlaps(reach, other, CLEARANCE));
    const clear = (box: Box) =>
      !nearTags.some((tag) => overlaps(box, tag, CLEARANCE)) &&
      !nearPlaced.some((other) => overlaps(box, other, CLEARANCE));
    // In order: as it is, a little nearer its agent, one line, then up.
    const tries: { box: Box; lift: number; short: boolean }[] = [
      ...down.map((lift) => ({ box: bubble.box, lift, short: false })),
      ...(bubble.short ? down.map((lift) => ({ box: bubble.short!, lift, short: true })) : []),
      ...LIFTS.map((lift) => ({ box: bubble.box, lift, short: false })),
    ];
    let chosen: Placement | null = null;
    for (const attempt of tries) {
      const moved = at(attempt.box, attempt.lift);
      if (clear(moved)) {
        chosen = { lift: attempt.lift, shift, short: attempt.short, hidden: false };
        placed.push(moved);
        break;
      }
    }
    if (!chosen) {
      const pinned = bubble.rank >= PINNED_RANK;
      chosen = { lift: 0, shift, short: false, hidden: !pinned };
      // What needs you stays where it is, even over a tag, and other bubbles keep clear of it.
      if (pinned) placed.push(at(bubble.box, 0));
    }
    result.set(bubble.id, chosen);
  }
  return result;
}
