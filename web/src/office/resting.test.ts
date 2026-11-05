// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { AgentDef } from '../gen/models.ts';
import { identityHues } from '../shared/tokens.ts';
import { restingLook, stableHash } from './resting.ts';

const def = (overrides: Partial<AgentDef> = {}) =>
  ({
    id: 'account:reviewer',
    kind: 'claude',
    name: 'reviewer',
    color: '',
    ...overrides,
  }) as AgentDef;

describe('restingLook', () => {
  it("uses the file's own colour, and the AI's shirt colour", () => {
    expect(restingLook(def({ color: '#4FB3FF' }))).toMatchObject({
      hue: '#4FB3FF',
      provider: 'claude',
    });
    expect(restingLook(def({ kind: 'codex' })).provider).toBe('openai');
    expect(restingLook(def({ kind: '' })).provider).toBe('claude');
  });

  it('picks a stable colour, skin and hair from the id when the file has no colour', () => {
    const look = restingLook(def({ color: 'blue' }));
    expect(identityHues).toContain(look.hue);
    expect(restingLook(def({ color: 'blue' }))).toEqual(look);
    expect(stableHash('account:reviewer')).toBe(stableHash('account:reviewer'));
    expect(stableHash('a')).not.toBe(stableHash('b'));
  });
});
