// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { Instruction, LiveAgent, Project } from '../gen/models.ts';
import { projectChat, removable } from './projectChat.ts';

function instruction(id: string, time: number, extra: Partial<Instruction> = {}): Instruction {
  return {
    id,
    agentId: null,
    text: `message ${id}`,
    mode: 'instruct',
    status: 'delivered',
    time,
    logId: '',
    reply: '',
    repliedAt: 0,
    ...extra,
  };
}

const project = { id: 'p1', name: 'Shop', opening: [instruction('o1', 40)] } as unknown as Project;

function agent(id: string, projectId: string | null, extra: Partial<LiveAgent>): LiveAgent {
  return {
    id,
    name: id === 'a1' ? 'Shop' : 'Other',
    provider: 'claude',
    account: 'claude_code',
    projectId,
    queued: [],
    asked: [],
    ...extra,
  } as LiveAgent;
}

describe('projectChat', () => {
  it("lists what was sent to the project's agents, oldest first, with each reply", () => {
    const items = projectChat(project, [
      agent('a1', 'p1', {
        asked: [
          instruction('s1', 10, { reply: 'Done: 3 issues.', repliedAt: 20 }),
          instruction('s2', 30),
        ],
        queued: [instruction('q1', 50, { status: 'waiting_for_checkpoint' })],
      }),
      agent('a2', 'other', { asked: [instruction('x1', 5)] }),
    ]);
    expect(items.map((item) => [item.id, item.status, item.to])).toEqual([
      ['s1', 'replied', 'Shop'],
      ['s2', 'sent', 'Shop'],
      ['o1', 'opening', 'Claude Code'],
      ['q1', 'queued', 'Shop'],
    ]);
    expect(items[0]?.reply).toBe('Done: 3 issues.');
    expect(items[0]?.ai).toBe('Claude');
    expect(items.filter(removable).map((item) => item.id)).toEqual(['o1', 'q1']);
  });

  it('copes with a project saved before prompts could wait for Claude Code', () => {
    const old = { id: 'p1', name: 'Shop' } as unknown as Project;
    expect(projectChat(old, [])).toEqual([]);
  });
});
