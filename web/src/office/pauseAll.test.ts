// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { GroupReply } from '../data/api.ts';
import type { LiveAgent } from '../gen/models.ts';
import {
  groupFrom,
  modelScope,
  namesShown,
  parseGroup,
  pausable,
  pauseNotes,
  stillStopped,
  viewScope,
  waitingOnYou,
} from './pauseAll.ts';
import type { OfficeFilters } from './uiStore.ts';

const agent = (overrides: Partial<LiveAgent> = {}) =>
  ({
    id: 'a',
    name: 'Ada',
    projectId: 'docs',
    provider: 'claude',
    model: 'claude-sonnet-4-5',
    source: 'sim',
    state: 'editing',
    leadId: null,
    desk: 0,
    workflow: false,
    leaving: false,
    working: true,
    queued: [],
    approval: null,
    question: null,
    ...overrides,
  }) as LiveAgent;

const filters = (overrides: Partial<OfficeFilters> = {}): OfficeFilters => ({
  project: 'all',
  provider: 'all',
  model: 'all',
  status: 'all',
  team: null,
  ...overrides,
});

const office = {
  projects: [
    { id: 'docs', name: 'Docs site', color: '#33AA77' },
    { id: 'shop', name: 'Checkout revamp', color: '#FF6B9A' },
  ],
  agents: [agent({ id: 'lead', name: 'Atlas' })],
} as Parameters<typeof viewScope>[0];

describe('pausable', () => {
  const agents = [
    agent({ id: 'w', name: 'Wren', projectId: 'docs' }),
    agent({ id: 'x', name: 'Xan', projectId: 'shop', provider: 'openai', model: 'gpt-5' }),
    agent({ id: 'p', name: 'Pax', state: 'approval', working: false }),
    agent({ id: 'q', name: 'Quin', question: {} as LiveAgent['question'], working: false }),
    agent({ id: 'i', name: 'Ivy', state: 'idle', working: false }),
    agent({ id: 'g', name: 'Gone', leaving: true }),
  ];

  it('is every working agent in view, and never one waiting on you', () => {
    expect(pausable(agents, filters()).map((item) => item.id)).toEqual(['w', 'x']);
  });

  it('follows the project and the models filter, as the floor does', () => {
    expect(pausable(agents, filters({ project: 'shop' })).map((item) => item.id)).toEqual(['x']);
    expect(pausable(agents, filters({ provider: 'claude' })).map((item) => item.id)).toEqual(['w']);
    expect(pausable(agents, filters({ model: 'gpt-5' })).map((item) => item.id)).toEqual(['x']);
  });

  it('is nobody when the view only shows who needs you', () => {
    expect(pausable(agents, filters({ status: 'needs' }))).toEqual([]);
  });
});

describe('waitingOnYou', () => {
  it('counts approvals and questions in the view, which a pause leaves alone', () => {
    const agents = [
      agent({ id: 'p', state: 'approval', working: false, projectId: 'docs' }),
      agent({ id: 'q', question: {} as LiveAgent['question'], working: false, projectId: 'docs' }),
      agent({ id: 'e', state: 'error', working: false, projectId: 'docs' }),
      agent({ id: 'o', state: 'approval', working: false, projectId: 'shop' }),
    ];
    expect(waitingOnYou(agents, filters({ project: 'docs' })).map((item) => item.id)).toEqual([
      'p',
      'q',
    ]);
  });
});

describe('what the view is called', () => {
  it('names the project, the team, or says every project', () => {
    expect(viewScope(office, filters())).toBe('all projects');
    expect(viewScope(office, filters({ project: 'shop' }))).toBe('Checkout revamp');
    expect(viewScope(office, filters({ team: 'lead' }))).toBe("Atlas's office");
    expect(viewScope(office, filters({ project: 'gone' }))).toBe('this project');
  });

  it('says what the Models filter narrows to', () => {
    expect(modelScope(filters())).toBeNull();
    expect(modelScope(filters({ provider: 'openai' }))).toBe('OpenAI agents only');
    expect(modelScope(filters({ provider: 'claude', model: 'claude-haiku-4-5' }))).toBe(
      'claude-haiku-4-5 only',
    );
  });
});

describe('pauseNotes', () => {
  it('has nothing to say about the demo, which stops at once', () => {
    expect(pauseNotes([agent(), agent({ name: 'Bo' })])).toEqual([]);
  });

  it('says plainly what each connector can only do', () => {
    const notes = pauseNotes([
      agent({ name: 'Quill', source: 'claude' }),
      agent({ name: 'Bolt', source: 'claude' }),
      agent({ name: 'Codey', source: 'codex' }),
      agent({ name: 'Botty', source: 'hub' }),
      agent({ name: 'Demo', source: 'sim' }),
    ]);
    expect(notes).toHaveLength(3);
    expect(notes[0]).toBe(
      "Quill and Bolt are in Claude Code, which stops at its next step. Mabari can't restart a session once it has stopped: type in it to carry on.",
    );
    expect(notes[1]).toBe(
      'Codey is in Codex, which ends its turn. Continue starts a new turn from where it stopped.',
    );
    expect(notes[2]).toBe(
      'Botty is a hub app, so Mabari can only ask. It queues "Please pause." and the app decides.',
    );
  });
});

describe('namesShown', () => {
  it('lists a few and counts the rest', () => {
    expect(namesShown(['A'])).toBe('A');
    expect(namesShown(['A', 'B', 'C'])).toBe('A, B and C');
    expect(namesShown(['A', 'B', 'C', 'D', 'E'], 3)).toBe('A, B, C and 2 more');
  });
});

describe('the group a pause stopped', () => {
  const reply = (results: GroupReply['results']) => ({ results }) as Pick<GroupReply, 'results'>;

  it('keeps who stopped and who was only asked, and nobody else', () => {
    expect(
      groupFrom(
        reply([
          { id: 'a', name: 'A', outcome: 'paused', why: '' },
          { id: 'b', name: 'B', outcome: 'asked', why: 'stops at its next step' },
          { id: 'c', name: 'C', outcome: 'skipped', why: 'is already paused' },
          { id: 'd', name: 'D', outcome: 'skipped', why: 'is waiting for your approval' },
        ]),
      ),
    ).toEqual({ stopped: ['a'], asked: ['b'] });
  });

  it('counts an agent while it is paused, so one continued by hand drops out', () => {
    const group = { stopped: ['a', 'b'], asked: [] };
    const now = [
      { id: 'a', state: 'paused', working: false },
      { id: 'b', state: 'thinking', working: true },
    ] as Parameters<typeof stillStopped>[1];
    expect(stillStopped(group, now)).toEqual(['a']);
  });

  it('counts an agent only asked while it is working, and when it has stopped', () => {
    const group = { stopped: [], asked: ['c'] };
    const working = [{ id: 'c', state: 'running', working: true }] as Parameters<
      typeof stillStopped
    >[1];
    const paused = [{ id: 'c', state: 'paused', working: false }] as Parameters<
      typeof stillStopped
    >[1];
    const finished = [{ id: 'c', state: 'done', working: false }] as Parameters<
      typeof stillStopped
    >[1];
    expect(stillStopped(group, working)).toEqual(['c']);
    expect(stillStopped(group, paused)).toEqual(['c']);
    expect(stillStopped(group, finished)).toEqual([]);
  });

  it('drops agents that have left, and lists each once', () => {
    const group = { stopped: ['a', 'gone'], asked: ['a'] };
    const now = [{ id: 'a', state: 'paused', working: false }] as Parameters<
      typeof stillStopped
    >[1];
    expect(stillStopped(group, now)).toEqual(['a']);
  });

  it('is restored from what was saved, and only from lists of ids', () => {
    expect(parseGroup(null)).toEqual({ stopped: [], asked: [] });
    expect(parseGroup('not json')).toEqual({ stopped: [], asked: [] });
    expect(parseGroup('{"stopped":["a",3,null],"asked":"b"}')).toEqual({
      stopped: ['a'],
      asked: [],
    });
    expect(parseGroup('{"stopped":["a"],"asked":["b"]}')).toEqual({ stopped: ['a'], asked: ['b'] });
  });
});
