// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { chatHash, chatPlace } from './chatRoute.ts';

describe('chatPlace', () => {
  it('is With you for a bare address', () => {
    expect(chatPlace('#conversations')).toEqual({ tab: 'with', agent: null, project: null });
    expect(chatPlace('')).toEqual({ tab: 'with', agent: null, project: null });
  });

  it('names an agent or a project', () => {
    expect(chatPlace('#conversations?agent=cc-1')).toEqual({
      tab: 'with',
      agent: 'cc-1',
      project: null,
    });
    expect(chatPlace('#conversations?project=p%201')).toEqual({
      tab: 'with',
      agent: null,
      project: 'p 1',
    });
  });

  it('is Between agents only when asked, and an agent or project is never between', () => {
    expect(chatPlace('#conversations?tab=between').tab).toBe('between');
    expect(chatPlace('#conversations?tab=between&agent=a').tab).toBe('with');
    expect(chatPlace('#conversations?tab=nonsense').tab).toBe('with');
  });

  it('takes the agent when an address names both', () => {
    expect(chatPlace('#conversations?agent=a&project=p')).toMatchObject({
      agent: 'a',
      project: null,
    });
  });

  it('round trips what it writes', () => {
    expect(chatPlace(chatHash.agent('cc a/1')).agent).toBe('cc a/1');
    expect(chatPlace(chatHash.project('p&q')).project).toBe('p&q');
    expect(chatPlace(chatHash.between()).tab).toBe('between');
    expect(chatPlace(chatHash.with()).tab).toBe('with');
  });
});
