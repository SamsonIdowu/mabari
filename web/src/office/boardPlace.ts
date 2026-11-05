// SPDX-License-Identifier: Apache-2.0
// Where the open "Needs approval" card sits on the floor. It starts at the top right, under the
// wall bar, and on a floor with agents resting in the lounge that is where they stand, so it hid
// their heads and speech bubbles (RT-10). Agents are what the floor is for, so the card moves down
// the right edge to the first place where it covers none of them.

/** A box in the floor's own pixels. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The card's top when nothing is in its way: under the wall bar, so every project card stays clear. */
export const BOARD_TOP = 66;
/** How much of the floor's bottom edge the card leaves alone: the readout and the tool strip. */
export const BOARD_KEEP_BOTTOM = 96;
const STEP = 6;
/** How far the card keeps from anything it would otherwise touch. */
const MARGIN = 6;

const touches = (a: Rect, b: Rect) =>
  a.left < b.right + MARGIN &&
  b.left < a.right + MARGIN &&
  a.top < b.bottom + MARGIN &&
  b.top < a.bottom + MARGIN;

/** What an agent covers on the floor: its name tag and bubble, and the character above the tag. */
export function agentFootprint(tag: Rect, scale: number): Rect {
  // The character stands on the tag's top edge, about 56 units tall at the tags' own scale.
  return { ...tag, top: tag.top - 56 * scale };
}

/**
 * The top for a card `width` by `height` against the right edge of a floor `stage` pixels across and
 * down, among `obstacles`. It keeps `current` while that covers nothing, so the card stays still. If
 * it would, it takes the first top under the wall bar that covers nothing. If every top covers
 * someone, it takes the one that covers the fewest, the highest of those: the agents it still
 * covers are in the list beside the floor.
 */
export function clearTop(options: {
  current: number;
  width: number;
  height: number;
  /** The gap between the card and the floor's right edge. */
  gap: number;
  stage: { width: number; height: number };
  obstacles: Rect[];
}): number {
  const { current, width, height, gap, stage, obstacles } = options;
  const at = (top: number): Rect => ({
    left: stage.width - gap - width,
    right: stage.width - gap,
    top,
    bottom: top + height,
  });
  const covered = (top: number) => obstacles.filter((box) => touches(at(top), box)).length;
  const lowest = Math.max(stage.height - BOARD_KEEP_BOTTOM - height, BOARD_TOP);
  if (current >= BOARD_TOP && current <= lowest && covered(current) === 0) return current;
  let best = BOARD_TOP;
  let fewest = covered(BOARD_TOP);
  for (let top = BOARD_TOP + STEP; fewest > 0 && top <= lowest; top += STEP) {
    const count = covered(top);
    if (count < fewest) {
      best = top;
      fewest = count;
    }
  }
  return best;
}
