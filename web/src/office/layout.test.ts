// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { deskSeat, DESKS, pathTo, spotFor } from './layout.ts';

describe('desks', () => {
  it('has sixteen desks in a four by four grid', () => {
    expect(DESKS).toHaveLength(16);
    expect(DESKS[0]).toEqual({ x: 8, y: 4 });
    expect(DESKS[5]).toEqual({ x: 13, y: 8 });
  });

  it('seats an agent in front of its desk', () => {
    expect(deskSeat(0)).toEqual({ x: 288, y: 182 });
  });
});

describe('spotFor', () => {
  it('sends agents to the room for their state', () => {
    expect(spotFor('editing', 0, 1)).toEqual(deskSeat(0));
    expect(spotFor('reading', 0, 1)).toEqual({ x: 120, y: 118 });
    expect(spotFor('running', 0, 1)).toEqual({ x: 1042, y: 136 });
    expect(spotFor('browsing', 0, 1)).toEqual({ x: 90, y: 568 });
    expect(spotFor('spawning', 0, 1)).toEqual({ x: 1078, y: 362 });
    expect(spotFor('idle', 0, 1)).toEqual({ x: 1046, y: 520 });
  });

  it('wraps round when a room has more agents than spots', () => {
    expect(spotFor('reading', 0, 3)).toEqual(spotFor('reading', 0, 0));
  });
});

describe('pathTo', () => {
  it('has nowhere to go when already there', () => {
    expect(pathTo({ x: 10, y: 10 }, { x: 10.5, y: 10.5 })).toEqual([]);
  });

  it('walks along a corridor for short moves', () => {
    expect(pathTo({ x: 100, y: 200 }, { x: 300, y: 220 })).toEqual([
      { x: 100, y: 200 },
      { x: 300, y: 200 },
      { x: 300, y: 220 },
    ]);
  });

  it('uses the gap in the wall to reach the rooms on the right', () => {
    expect(pathTo({ x: 300, y: 200 }, { x: 1046, y: 520 })[0]).toEqual({ x: 912, y: 200 });
  });

  it('stays on the right side when moving between right hand rooms', () => {
    expect(pathTo({ x: 1000, y: 136 }, { x: 1046, y: 520 })).toEqual([
      { x: 1000, y: 520 },
      { x: 1046, y: 520 },
    ]);
  });
});
