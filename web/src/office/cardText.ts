// SPDX-License-Identifier: Apache-2.0
import { minsText } from '../format.ts';

/** Time worked, in plain words. A minute is the least a card says, so "0 min" never shows. */
export function workedText(seconds: number): string {
  return seconds < 60 ? '< 1 min' : minsText(seconds);
}

/** The estimated cost: a dash when nothing is counted for the agent, never "$0.00". */
export function costText(card: { cost: number; costKnown: boolean }): string {
  return card.costKnown ? `$${card.cost.toFixed(2)}` : '–';
}
