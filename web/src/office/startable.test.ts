// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { AgentDef } from '../gen/models.ts';
import { startable } from './startable.ts';

const def = (overrides: Partial<AgentDef>) =>
  ({
    id: 'x',
    name: 'x',
    scope: 'account',
    projectId: '',
    enabled: true,
    system: false,
    ...overrides,
  }) as AgentDef;

describe('startable', () => {
  it('offers the agent files that are on, account ones first, and never Mabari', () => {
    const list = startable([
      def({ id: 'project:p1:zed', name: 'zed', scope: 'project', projectId: 'p1' }),
      def({ id: 'account:mabari', name: 'mabari', system: true }),
      def({ id: 'account:off', name: 'off', enabled: false }),
      def({ id: 'account:beta', name: 'beta' }),
      def({ id: 'account:alpha', name: 'alpha' }),
    ]);
    expect(list.map((item) => item.id)).toEqual([
      'account:alpha',
      'account:beta',
      'project:p1:zed',
    ]);
  });

  it("leaves out a completed project's agent files", () => {
    const list = startable(
      [def({ id: 'project:p1:zed', name: 'zed', scope: 'project', projectId: 'p1' })],
      [{ id: 'p1', status: 'done' }],
    );
    expect(list).toEqual([]);
  });
});
