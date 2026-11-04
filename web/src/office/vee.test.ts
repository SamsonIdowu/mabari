// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { GESTURE_LABELS, IDLE_GESTURES, POKE_GESTURES, VEE_GESTURES, veeFrame } from './vee.ts';

const still = { x: 0, y: 0 };

describe('veeFrame', () => {
  it('follows the pointer when idle', () => {
    const { pose, rig } = veeFrame('idle', { x: 1, y: 0.5 }, null, 0);
    expect(pose).toBe('idle');
    expect(rig.look).toEqual({ x: 1, y: 0.5 });
    expect(rig.turn).toBeCloseTo(0.55);
  });

  it('looks up while thinking and moves the mouth while talking', () => {
    expect(veeFrame('think', still, null, 0).pose).toBe('think');
    expect(veeFrame('talk', still, null, 200).rig.talk).toBeGreaterThan(0);
  });

  it('plays a gesture over the state and stops when it ends', () => {
    const wave = { name: 'wave', start: 0, dur: 1700 };
    expect(veeFrame('idle', still, wave, 500).pose).toBe('wave');
    expect(veeFrame('idle', still, wave, 1700).pose).toBe('idle');
  });

  it('keeps talking through a gesture', () => {
    const nod = { name: 'nod', start: 0, dur: 1100 };
    const frame = veeFrame('talk', still, nod, 200);
    expect(frame.rig.talk).toBeGreaterThan(0);
    expect(frame.rig.eyes).toBe('lid');
  });

  it('ignores an unknown gesture', () => {
    expect(veeFrame('idle', still, { name: 'nope', start: 0, dur: 100 }, 10).pose).toBe('idle');
  });
});

describe('the gesture library', () => {
  it('has every gesture the menu, the idle loop and a poke can ask for', () => {
    const names = [...GESTURE_LABELS.map(([name]) => name), ...IDLE_GESTURES, ...POKE_GESTURES];
    for (const name of names) expect(VEE_GESTURES[name], name).toBeDefined();
  });

  it.each(Object.entries(VEE_GESTURES))('%s stays finite the whole way through', (_, gesture) => {
    for (let p = 0; p <= 1; p += 0.05) {
      const { rig } = gesture.f(p);
      for (const value of Object.values(rig)) {
        if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
      }
    }
  });
});
