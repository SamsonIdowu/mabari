// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { LiveAgent } from '../gen/models.ts';
import { approvalAnnouncement, approvalSummary } from './approvalText.ts';

type Waiting = Pick<LiveAgent, 'name' | 'state' | 'approval'>;

function agent(name: string, state: string, type: string, detail: object): Waiting {
  return {
    name,
    state: state as LiveAgent['state'],
    approval: { type, detail } as LiveAgent['approval'],
  };
}

describe('approvalSummary', () => {
  it('names the command, the plan or the file', () => {
    expect(approvalSummary(agent('Atlas', 'approval', 'command', { cmd: 'npm test' }))).toBe(
      'npm test',
    );
    expect(approvalSummary(agent('Atlas', 'approval', 'plan', { project: 'Shop' }))).toBe(
      'Approve the plan for Shop',
    );
    expect(approvalSummary(agent('Atlas', 'approval', 'edit', { path: 'src/a.ts' }))).toBe(
      'Edit src/a.ts',
    );
  });
});

describe('approvalAnnouncement', () => {
  it('says nothing when no approval is waiting', () => {
    expect(approvalAnnouncement([])).toBe('');
    expect(approvalAnnouncement([agent('Atlas', 'working', 'command', { cmd: 'x' })])).toBe('');
  });

  it('names one waiting approval and what it is for', () => {
    expect(
      approvalAnnouncement([agent('Atlas', 'approval', 'command', { cmd: 'npm run db:migrate' })]),
    ).toBe('1 approval waiting: Atlas, npm run db:migrate');
  });

  it('counts several, and says how many more when the list is cut', () => {
    const many = ['Atlas', 'Mori', 'Sage', 'Bolt', 'Ledger'].map((name) =>
      agent(name, 'approval', 'command', { cmd: 'ls' }),
    );
    expect(approvalAnnouncement(many.slice(0, 2))).toBe('2 approvals waiting: Atlas, ls; Mori, ls');
    expect(approvalAnnouncement(many)).toBe(
      '5 approvals waiting: Atlas, ls; Mori, ls; Sage, ls; and 2 more',
    );
  });
});
