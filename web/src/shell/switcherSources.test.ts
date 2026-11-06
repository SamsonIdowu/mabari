// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import type { LiveAgent, Snapshot } from '../gen/models.ts';
import {
  flatten,
  registeredSources,
  search,
  type SwitcherContext,
  type SwitcherControls,
} from './switcher.ts';
import { actionsSource, agentsSource, projectsSource, screensSource } from './switcherSources.ts';

const agent = (overrides: Partial<LiveAgent> = {}) =>
  ({
    id: 'a',
    name: 'Ada',
    projectId: 'shop',
    provider: 'claude',
    model: 'claude-sonnet-4-5',
    state: 'editing',
    task: 'Fix the login page',
    error: '',
    hue: '#7FA8FF',
    leadId: null,
    desk: 0,
    defId: '',
    workflow: false,
    leaving: false,
    working: true,
    queued: [],
    approval: null,
    question: null,
    ...overrides,
  }) as LiveAgent;

const office = (agents: LiveAgent[]) =>
  ({
    agents,
    projects: [
      { id: 'shop', name: 'Checkout revamp', color: '#FF6B9A', status: 'active' },
      { id: 'docs', name: 'Docs site', color: '#48DBFB', status: 'idle' },
      { id: 'old', name: 'Landing page', color: '#7BED9F', status: 'done' },
    ],
  }) as unknown as Snapshot;

const controls = (): SwitcherControls => ({
  quietOn: false,
  theme: 'dark',
  toggleQuiet: vi.fn(),
  toggleTheme: vi.fn(),
  newAgent: vi.fn(),
  newProject: vi.fn(),
});

const contextFor = (agents: LiveAgent[] | null, extra = controls()): SwitcherContext => ({
  office: agents ? office(agents) : null,
  openAgent: vi.fn(),
  controls: extra,
});

describe('agents', () => {
  const agents = [
    agent({ id: 'w', name: 'Wren', state: 'editing' }),
    agent({ id: 'z', name: 'Zed', state: 'idle', working: false, projectId: null }),
    agent({ id: 'p', name: 'Pax', state: 'approval', working: false }),
    agent({ id: 'e', name: 'Ezra', state: 'error', working: false, error: 'Tests failed' }),
    agent({ id: 'q', name: 'Quin', question: {} as LiveAgent['question'], working: false }),
    agent({ id: 'b', name: 'Bo', state: 'thinking', queued: [{} as LiveAgent['queued'][number]] }),
    agent({ id: 'gone', name: 'Gone', leaving: true }),
    agent({ id: 'seatless', name: 'Seatless', desk: -1, workflow: true }),
  ];

  it('lists those who need you first, as the floor list does, then queued, working, and the rest', () => {
    const labels = agentsSource.results(contextFor(agents)).sort((a, b) => a.order - b.order);
    expect(labels.map((item) => item.label).slice(0, 5)).toEqual([
      'Pax',
      'Ezra',
      'Quin',
      'Bo',
      'Wren',
    ]);
    expect(labels.at(-1)?.label).toBe('Zed');
  });

  it('leaves out an agent that is leaving or has no seat, as the floor does', () => {
    const labels = agentsSource.results(contextFor(agents)).map((item) => item.label);
    expect(labels).not.toContain('Gone');
    expect(labels).not.toContain('Seatless');
    expect(labels).toHaveLength(6);
  });

  it('shows name, state and project, and links to the agent as every other page does', () => {
    const pax = agentsSource.results(contextFor(agents)).find((item) => item.label === 'Pax');
    expect(pax).toMatchObject({
      id: 'agent:p',
      detail: 'Checkout revamp',
      chip: { text: 'Needs approval', tone: 'red' },
      href: '#office?agent=p',
      color: '#7FA8FF',
    });
    const zed = agentsSource.results(contextFor(agents)).find((item) => item.label === 'Zed');
    expect(zed?.detail).toBe('No project');
  });

  it('shows a question calmly, outlined and never red', () => {
    const quin = agentsSource.results(contextFor(agents)).find((item) => item.label === 'Quin');
    expect(quin?.chip).toEqual({ text: 'Asking you', tone: 'ask' });
    const ezra = agentsSource.results(contextFor(agents)).find((item) => item.label === 'Ezra');
    expect(ezra?.chip?.tone).toBe('red');
  });

  it('opens the agent through the page, which widens the floor if it is out of view', () => {
    const context = contextFor(agents);
    agentsSource
      .results(context)
      .find((item) => item.label === 'Wren')
      ?.run?.();
    expect(context.openAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(context.openAgent).mock.calls[0]?.[0].id).toBe('w');
  });

  it('is found by state and by what the agent is doing, not only its name', () => {
    const found = (query: string) =>
      flatten(search(contextFor(agents), query, [agentsSource])).map((item) => item.label);
    expect(found('approval')).toEqual(['Pax']);
    expect(found('login')).toContain('Wren');
    expect(found('checkout')).toContain('Pax');
    expect(found('no project')).toEqual(['Zed']);
  });

  it('offers nothing before the office has loaded', () => {
    expect(agentsSource.results(contextFor(null))).toEqual([]);
    expect(projectsSource.results(contextFor(null))).toEqual([]);
  });
});

describe('projects', () => {
  it('opens an open project in its chat, and a finished one on the page that lists it', () => {
    const projects = projectsSource.results(contextFor([agent(), agent({ id: 'b', name: 'Bo' })]));
    expect(projects.map((item) => [item.label, item.href])).toEqual([
      ['Checkout revamp', '#projects?chat=shop'],
      ['Docs site', '#projects?chat=docs'],
      ['Landing page', '#projects'],
    ]);
    expect(projects[0]?.detail).toBe('2 agents · In progress');
    expect(projects[1]?.detail).toBe('0 agents · Waiting for work');
    expect(projects[2]?.order).toBeGreaterThan(projects[0]?.order ?? 0);
  });
});

describe('screens', () => {
  const screens = screensSource.results(contextFor(null));

  it('lists every screen in the rail with its link', () => {
    const link = (label: string) => screens.find((item) => item.label === label)?.href;
    expect(link('Home')).toBe('#home');
    expect(link('Agents')).toBe('#office');
    expect(link('Projects')).toBe('#projects');
    expect(link('Agent builder')).toBe('#builder');
    expect(link('Conversations')).toBe('#conversations');
    expect(link('Accounts')).toBe('#accounts');
    expect(link('Activity log')).toBe('#activity');
    expect(link('Settings')).toBe('#preferences');
  });

  it('is found by the name in the rail as well as the name a screen reader reads', () => {
    const found = (query: string) =>
      flatten(search(contextFor(null), query, [screensSource])).map((item) => item.label);
    expect(found('chats')).toEqual(['Conversations']);
    expect(found('log')).toContain('Activity log');
    expect(found('prefer')).toContain('Settings');
  });

  it('adds no route: every link is one the address already understands', () => {
    for (const item of screens) expect(item.href).toMatch(/^#[a-z]+$/);
  });
});

describe('actions', () => {
  it('lists the plain ones, each running what the matching button runs', () => {
    const mine = controls();
    const actions = actionsSource.results(contextFor(null, mine));
    expect(actions.map((item) => item.label)).toEqual([
      'New agent',
      'New project',
      'Quiet mode',
      'Switch theme',
    ]);
    for (const item of actions) {
      expect(item.href).toBeUndefined();
      item.run?.();
    }
    expect(mine.newAgent).toHaveBeenCalledOnce();
    expect(mine.newProject).toHaveBeenCalledOnce();
    expect(mine.toggleQuiet).toHaveBeenCalledOnce();
    expect(mine.toggleTheme).toHaveBeenCalledOnce();
  });

  it('says what quiet mode and the theme are now', () => {
    const on = actionsSource.results(
      contextFor(null, { ...controls(), quietOn: true, theme: 'light' }),
    );
    expect(on.find((item) => item.label === 'Quiet mode')?.chip?.text).toBe('On');
    expect(on.find((item) => item.label === 'Switch theme')?.detail).toBe(
      'Switch to the dark theme',
    );
    const off = actionsSource.results(contextFor(null));
    expect(off.find((item) => item.label === 'Quiet mode')?.chip?.text).toBe('Off');
    expect(off.find((item) => item.label === 'Switch theme')?.detail).toBe(
      'Switch to the light theme',
    );
  });

  it('has no risky action: nothing that approves, denies, wipes, stops or pauses', () => {
    const everything = registeredSources().flatMap((source) =>
      source.results(contextFor([agent()], controls())),
    );
    const risky = /approve|allow|deny|auto approve|wipe|stop|pause|interrupt|delete|disconnect/i;
    for (const item of everything.filter((entry) => entry.run && !entry.href)) {
      expect(`${item.label} ${item.detail ?? ''}`, item.id).not.toMatch(risky);
    }
  });
});

describe('what ships', () => {
  it('registers agents, projects, screens and actions, in that order', () => {
    expect(registeredSources().map((source) => source.id)).toEqual([
      'agents',
      'projects',
      'screens',
      'actions',
    ]);
  });

  it('searches all of them at once, with those needing you first among agents', () => {
    const context = contextFor([
      agent({ id: 'x', name: 'Xenia', state: 'editing' }),
      agent({ id: 'y', name: 'Xavier', state: 'approval', working: false }),
    ]);
    const groups = search(context, 'x');
    expect(groups.map((group) => group.heading)).toEqual(['Agents']);
    expect(groups[0]?.results.map((item) => item.label)).toEqual(['Xavier', 'Xenia']);
    expect(search(context, 'theme').map((group) => group.heading)).toEqual(['Actions']);
    expect(
      search(context, 'new').flatMap((group) => group.results.map((item) => item.label)),
    ).toEqual(['New agent', 'New project']);
  });
});
