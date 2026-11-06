// SPDX-License-Identifier: Apache-2.0
// Keeping name tags apart. Every agent's tag hangs from its feet, so agents who stand close, in the
// meeting room for a party, round the door, side by side in the lounge or when the floor is drawn
// small, have tags that run into each other. A tag is for reading, so tags that meet are moved
// apart, a few pixels sideways first and down if sideways is not enough, never far from the agent
// they belong to. Tags that need you, and the one you picked, stay where they are and the others
// give way. This module only works out the moves; overlays.ts measures the tags and applies them.

import { EDGE, overlaps, type Box } from './bubbles.ts';

/** The air kept between two tags, in pixels. */
export const TAG_GAP = 4;
/**
 * The air a pair is moved to, a little more than they must keep, so that rounding the moves to
 * whole pixels can't leave them closer than TAG_GAP less a pixel.
 */
const AIR = TAG_GAP + 1.5;
/** The furthest a tag is moved sideways, so it still plainly belongs to its agent. */
export const MAX_SIDEWAYS = 120;
/** The furthest a tag is moved down. */
export const MAX_DOWN = 64;
/** How many times the tags are looked over. Each pass settles most of what is left. */
const PASSES = 48;

export interface TagItem {
  id: string;
  /** Where the tag is when nothing moves it, in pixels from the floor's top left corner. */
  box: Box;
  /** A tag that needs you or is picked: it keeps its place, and others give way. */
  fixed?: boolean;
}

/** How far a tag moves from where it hangs: right and down are positive. */
export interface Shift {
  dx: number;
  dy: number;
}

/**
 * Where each tag that needs to move goes. Tags that don't touch another are not in the result.
 * `width` is the floor's width, so no tag is pushed off its edge. The answer depends only on the
 * boxes, not on the order they are given in, so a tag doesn't flicker from one frame to the next.
 */
export function spreadTags(items: TagItem[], width: number): Map<string, Shift> {
  const result = new Map<string, Shift>();
  if (items.length < 2) return result;
  // A stable order, left to right, so the same tags always give way the same way.
  const order = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.box.left - b.item.box.left || a.item.id.localeCompare(b.item.id))
    .map(({ index }) => index);
  const count = items.length;
  const dx = new Array<number>(count).fill(0);
  const dy = new Array<number>(count).fill(0);
  const box = (index: number): Box => {
    const home = items[index]!.box;
    return {
      left: home.left + dx[index]!,
      right: home.right + dx[index]!,
      top: home.top + dy[index]!,
      bottom: home.bottom + dy[index]!,
    };
  };

  // How far tag `index` may still move along an axis, towards `dir` (-1 or 1).
  const room = (index: number, axis: 'x' | 'y', dir: number): number => {
    const home = items[index]!.box;
    if (items[index]!.fixed) return 0;
    if (axis === 'y') return dir < 0 ? 0 : Math.max(0, MAX_DOWN - dy[index]!);
    const low = Math.min(0, Math.max(-MAX_SIDEWAYS, EDGE - home.left));
    const high = Math.max(0, Math.min(MAX_SIDEWAYS, width - EDGE - home.right));
    return dir < 0 ? Math.max(0, dx[index]! - low) : Math.max(0, high - dx[index]!);
  };
  const move = (index: number, axis: 'x' | 'y', dir: number, wanted: number): number => {
    const given = Math.min(wanted, room(index, axis, dir));
    if (given <= 0) return 0;
    if (axis === 'x') dx[index]! += dir * given;
    else dy[index]! += given;
    return given;
  };

  // Pushes the pair apart along one axis, `first` towards `dir` and `second` the other way, and
  // says how much of the overlap is left.
  const separate = (
    first: number,
    second: number,
    axis: 'x' | 'y',
    dir: number,
    needed: number,
  ): number => {
    let left = needed;
    left -= move(first, axis, dir, left / 2);
    left -= move(second, axis, -dir, left > needed / 2 ? needed / 2 : left);
    // One of them was held back, so the other goes the rest of the way.
    if (left > 0.01) left -= move(first, axis, dir, left);
    if (left > 0.01) left -= move(second, axis, -dir, left);
    return left;
  };

  for (let pass = 0; pass < PASSES; pass++) {
    let touching = false;
    for (let a = 0; a < count; a++) {
      const first = order[a]!;
      const home = items[first]!.box;
      for (let b = a + 1; b < count; b++) {
        const second = order[b]!;
        // Sorted by where they hang, so nothing further along can reach this one.
        if (items[second]!.box.left - home.right > TAG_GAP + 2 * MAX_SIDEWAYS) break;
        const one = box(first);
        const two = box(second);
        if (!overlaps(one, two, TAG_GAP)) continue;
        touching = true;
        const acrossX = Math.min(one.right, two.right) - Math.max(one.left, two.left) + AIR;
        const acrossY = Math.min(one.bottom, two.bottom) - Math.max(one.top, two.top) + AIR;
        // Tags are wide and short: sideways unless the overlap is a thin slice of one above the other.
        const sideways = acrossX <= acrossY * 2;
        const centreOne = (one.left + one.right) / 2;
        const centreTwo = (two.left + two.right) / 2;
        const same = items[first]!.id.localeCompare(items[second]!.id) <= 0;
        if (sideways) {
          // The one on the left goes left. At the same spot, the earlier id does.
          const dir = centreOne < centreTwo || (centreOne === centreTwo && same) ? -1 : 1;
          const left = separate(first, second, 'x', dir, acrossX);
          if (left > 0.5) separate(first, second, 'y', one.top <= two.top ? -1 : 1, acrossY);
        } else {
          // The lower one goes down; the upper one stays, or goes down least.
          const upper = one.top <= two.top ? first : second;
          const lower = upper === first ? second : first;
          const left = separate(upper, lower, 'y', -1, acrossY);
          if (left > 0.5) {
            separate(first, second, 'x', centreOne <= centreTwo ? -1 : 1, acrossX);
          }
        }
      }
    }
    if (!touching) break;
  }

  // Whole pixels, rounded away from where the tag hung, so rounding never closes a gap.
  const whole = (value: number) => Math.sign(value) * Math.ceil(Math.abs(value) - 1e-6);
  items.forEach((item, index) => {
    const shift = { dx: whole(dx[index]!) || 0, dy: whole(dy[index]!) || 0 };
    if (shift.dx !== 0 || shift.dy !== 0) result.set(item.id, shift);
  });
  return result;
}

/** The tag's box after it has been moved. */
export function moved(box: Box, shift: Shift | undefined): Box {
  if (!shift) return box;
  return {
    left: box.left + shift.dx,
    right: box.right + shift.dx,
    top: box.top + shift.dy,
    bottom: box.bottom + shift.dy,
  };
}
