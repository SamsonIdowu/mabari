// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { mascotPose } from './drawMascot.ts';

describe('mascotPose', () => {
  it.each([
    ['approval', 'ask'],
    ['error', 'error'],
    ['done', 'done'],
    ['thinking', 'think'],
    ['spawning', 'think'],
    ['idle', 'idle'],
    ['paused', 'idle'],
    ['editing', 'work'],
    ['running', 'work'],
    ['reading', 'work'],
    ['browsing', 'work'],
    [undefined, 'idle'],
  ])('shows %s as %s', (state, pose) => {
    expect(mascotPose(state)).toBe(pose);
  });
});
