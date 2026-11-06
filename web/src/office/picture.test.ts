// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { captionOf, pictureName } from './picture.ts';

const at = new Date(2026, 10, 6, 13, 5);

describe('the office picture', () => {
  it('is named with the day, like the log exports', () => {
    expect(pictureName(at)).toBe('mabari-office-2026-11-06.png');
    expect(pictureName(new Date(2027, 0, 3))).toBe('mabari-office-2027-01-03.png');
  });

  it('says whose it is, how many are in it and when', () => {
    expect(captionOf({ agents: 22, working: 16, shipped: 3, at })).toBe(
      'My Mabari office · 22 agents · 16 working · 3 shipped · 6 Nov 2026',
    );
  });

  it('leaves out what is not true of it, and says one agent in the singular', () => {
    expect(captionOf({ agents: 1, working: 1, shipped: 0, at })).toBe(
      'My Mabari office · 1 agent · 1 working · 6 Nov 2026',
    );
    expect(captionOf({ agents: 0, working: 0, shipped: 0, at })).toBe(
      'My Mabari office · 0 agents · 6 Nov 2026',
    );
  });

  it('carries only counts in its strip: nothing of an agent, a task or a folder can be in it', () => {
    const line = captionOf({ agents: 5, working: 2, shipped: 1, at });
    expect(line).toMatch(/^[A-Za-z0-9 ·]+$/);
  });
});
