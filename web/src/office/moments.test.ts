// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  CHEER_MS,
  cheering,
  finishing,
  GLANCE_EVERY_MS,
  GLANCE_MS,
  glancing,
  hop,
  IDLE_SPELL_MS,
  idleDoing,
  JUMP_MS,
  JUMP_PX,
  jump,
  PARTY_MS,
  STRETCH_MS,
  stretching,
  TICK_MS,
  waving,
} from './moments.ts';

describe('the hop', () => {
  it('is small, lands, and hops a second time lower than the first', () => {
    const heights = Array.from({ length: 80 }, (_, step) => hop(step * 10));
    expect(Math.max(...heights)).toBeLessThanOrEqual(5);
    expect(Math.max(...heights)).toBeGreaterThan(0);
    expect(hop(0)).toBe(0);
    expect(hop(800)).toBe(0);
    expect(hop(5000)).toBe(0);
    const first = Math.max(...heights.slice(0, 40));
    const second = Math.max(...heights.slice(40));
    expect(second).toBeLessThan(first);
  });
});

describe('a task finishing', () => {
  const doneAt = 10_000;

  it('plays once from the moment it finished, and is over after that', () => {
    const at = (ms: number) => finishing(doneAt, doneAt + ms, false);
    expect(at(100)?.tick).not.toBeNull();
    expect(at(200)?.lift).toBeGreaterThan(0);
    expect(at(1000)?.confetti).toBe(true);
    // After the tick has faded the confetti may still fall, and then nothing is left.
    expect(at(TICK_MS + 10)?.tick).toBeNull();
    expect(at(TICK_MS + 10)?.confetti).toBe(TICK_MS + 10 < CHEER_MS);
    expect(at(Math.max(TICK_MS, CHEER_MS))).toBeNull();
    expect(at(60_000)).toBeNull();
  });

  it('shows nothing for an agent found already Done, which has no moment of its own', () => {
    expect(finishing(undefined, 50_000, false)).toBeNull();
    expect(finishing(0, 50_000, false)).toBeNull();
  });

  it('keeps the tick but never moves or falls with reduced motion', () => {
    const calm = finishing(doneAt, doneAt + 300, true);
    expect(calm).not.toBeNull();
    expect(calm?.lift).toBe(0);
    expect(calm?.confetti).toBe(false);
    expect(calm?.tick?.rise).toBe(1);
  });

  it('fades the tick out at the end rather than cutting it', () => {
    const early = finishing(doneAt, doneAt + 200, false)?.tick;
    const late = finishing(doneAt, doneAt + TICK_MS - 100, false)?.tick;
    expect(early?.alpha).toBe(1);
    expect(late?.alpha).toBeGreaterThan(0);
    expect(late?.alpha).toBeLessThan(1);
  });
});

describe('waving in', () => {
  it('lasts until its time, and never with reduced motion', () => {
    expect(waving(2000, 1500, false)).toBe(true);
    expect(waving(2000, 2000, false)).toBe(false);
    expect(waving(undefined, 1500, false)).toBe(false);
    expect(waving(2000, 1500, true)).toBe(false);
  });
});

describe('glancing at the camera', () => {
  it('happens for those who need you, briefly, on a beat of their own', () => {
    expect(glancing(1, 0, false, false)).toBe(false);
    // Agent 5's beat starts at 5 * 1300 = 6500 mod 6500 = 0.
    expect(glancing(5, 0, true, false)).toBe(true);
    expect(glancing(5, GLANCE_MS + 1, true, false)).toBe(false);
    expect(glancing(5, GLANCE_EVERY_MS, true, false)).toBe(true);
  });

  it('is never the same moment for everyone', () => {
    const looking = Array.from({ length: 8 }, (_, n) => glancing(n, 3000, true, false));
    expect(looking.filter(Boolean).length).toBeLessThan(8);
    // Over a whole cycle each agent looks for the same share of the time.
    for (let n = 0; n < 4; n++) {
      let frames = 0;
      for (let t = 0; t < GLANCE_EVERY_MS; t += 10) if (glancing(n, t, true, false)) frames++;
      expect(frames * 10).toBeGreaterThanOrEqual(GLANCE_MS - 10);
      expect(frames * 10).toBeLessThanOrEqual(GLANCE_MS + 10);
    }
  });

  it('stays still with reduced motion', () => {
    for (let t = 0; t < 7000; t += 100) expect(glancing(5, t, true, true)).toBe(false);
  });
});

describe('what a resting agent does', () => {
  it('differs between agents at the same moment', () => {
    const doing = new Set(Array.from({ length: 10 }, (_, n) => idleDoing(n, 0, false)));
    expect(doing.size).toBeGreaterThanOrEqual(4);
  });

  it('changes every spell, and every activity comes up', () => {
    const seen = new Set<string>();
    for (let spell = 0; spell < 20; spell++) seen.add(idleDoing(2, spell * IDLE_SPELL_MS, false));
    expect([...seen].sort()).toEqual(['book', 'coffee', 'look', 'phone', 'stretch']);
    expect(idleDoing(2, 0, false)).toBe(idleDoing(2, IDLE_SPELL_MS - 1, false));
  });

  it('keeps to what looks right held still with reduced motion', () => {
    for (let n = 0; n < 12; n++) {
      for (let spell = 0; spell < 6; spell++) {
        expect(idleDoing(n, spell * IDLE_SPELL_MS, true)).not.toBe('stretch');
      }
    }
  });

  it('stretches only for the first moment of its spell', () => {
    expect(stretching('stretch', 100)).toBe(true);
    expect(stretching('stretch', STRETCH_MS + 1)).toBe(false);
    expect(stretching('stretch', IDLE_SPELL_MS + 100)).toBe(true);
    expect(stretching('coffee', 100)).toBe(false);
  });
});

describe('cheering at a party', () => {
  const at = 10_000;

  it('starts at its moment, jumps clear of the floor again and again, and ends with the party', () => {
    expect(cheering(undefined, at, false)).toBeNull();
    expect(cheering(at, at - 1, false)).toBeNull();
    expect(cheering(at, at, false)).toEqual({ lift: 0 });
    const lifts = Array.from(
      { length: 1200 },
      (_, step) => cheering(at, at + step * 5, false)!.lift,
    );
    expect(Math.max(...lifts)).toBe(JUMP_PX);
    // It lands between jumps: more than one jump in a few seconds, each off the floor and back.
    const jumps = lifts.filter((lift, index) => lift > 0 && (lifts[index - 1] ?? 0) === 0).length;
    expect(jumps).toBeGreaterThanOrEqual(8);
    expect(cheering(at, at + PARTY_MS - 1, false)).not.toBeNull();
    expect(cheering(at, at + PARTY_MS, false)).toBeNull();
  });

  it('jumps higher than a finished task hops, and keeps to a clean arc', () => {
    expect(JUMP_PX).toBeGreaterThan(5);
    expect(jump(0)).toBe(0);
    expect(jump(JUMP_MS / 2)).toBe(JUMP_PX);
    expect(jump(JUMP_MS)).toBe(0);
  });

  it('holds the pose, still, on the floor with reduced motion, for as long as the party lasts', () => {
    for (let step = 0; step < 100; step++) {
      expect(cheering(at, at + step * 60, true)).toEqual({ lift: 0 });
    }
    expect(cheering(at, at + PARTY_MS, true)).toBeNull();
  });

  it('is a party of several seconds', () => {
    expect(PARTY_MS).toBeGreaterThanOrEqual(5000);
  });
});
