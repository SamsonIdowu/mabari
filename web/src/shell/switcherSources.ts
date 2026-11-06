// SPDX-License-Identifier: Apache-2.0
// The kinds of result the quick switcher ships with: agents, projects, screens and plain actions.
// Each is a SwitcherSource (see switcher.ts), and a new kind is one more, registered the same way.
import { STATE_CHIPS, projectStatus, stateLabel } from '../format.ts';
import type { LiveAgent } from '../gen/models.ts';
import { groupOf, type FloorGroupId } from '../office/floorList.ts';
import { counted, urgent } from '../office/uiStore.ts';
import { hashWith } from '../routes.ts';
import { navGroups } from './navItems.tsx';
import {
  registerSource,
  type ChipTone,
  type SwitcherContext,
  type SwitcherResult,
  type SwitcherSource,
} from './switcher.ts';

/** The floor list's groups, in its order: who needs you, then queued, working, interrupted, done, and resting. */
const GROUP_ORDER: FloorGroupId[] = ['needs', 'queued', 'working', 'interrupted', 'done', 'lounge'];

const chipTone = (state: LiveAgent['state']): ChipTone => {
  const tone = STATE_CHIPS[state];
  return tone === 'red' || tone === 'amber' || tone === 'ok' ? tone : '';
};

/**
 * Every agent on the floor, with its state and project, those that need you first (the floor
 * list's own order, so the two always agree). An open question is shown calmly, outlined, never red.
 */
export const agentsSource: SwitcherSource = {
  id: 'agents',
  heading: 'Agents',
  position: 10,
  results: ({ office, openAgent }) => {
    if (!office) return [];
    return counted(office.agents).map((agent): SwitcherResult => {
      const project = office.projects.find((item) => item.id === agent.projectId)?.name;
      const asking = Boolean(agent.question) && !urgent(agent);
      const state = asking ? 'Asking you' : stateLabel(agent.state);
      return {
        id: `agent:${agent.id}`,
        label: agent.name,
        detail: project ?? 'No project',
        keywords: `${state} ${agent.task} ${agent.model}`,
        color: agent.hue,
        glyph: 'square',
        chip: { text: state, tone: asking ? 'ask' : chipTone(agent.state) },
        href: hashWith('office', 'agent', agent.id),
        run: () => openAgent(agent),
        order: GROUP_ORDER.indexOf(groupOf(agent)),
      };
    });
  },
};

/**
 * Every project. An open project opens its chat on the Projects page, which the address already
 * names (`#projects?chat=`). A completed one has no chat, so it opens the page it is listed on.
 */
export const projectsSource: SwitcherSource = {
  id: 'projects',
  heading: 'Projects',
  position: 20,
  results: ({ office }) => {
    if (!office) return [];
    const here = counted(office.agents);
    return office.projects.map((project): SwitcherResult => {
      const people = here.filter((agent) => agent.projectId === project.id).length;
      const done = project.status === 'done';
      return {
        id: `project:${project.id}`,
        label: project.name,
        detail: `${people} agent${people === 1 ? '' : 's'} · ${projectStatus(project.status).label}`,
        color: project.color,
        glyph: 'dot',
        href: done ? '#projects' : hashWith('projects', 'chat', project.id),
        order: done ? 1 : 0,
      };
    });
  },
};

/** What a rail link's tooltip says after its name, as a line to read: "The live office floor". */
function describe(title: string | undefined): string | undefined {
  const said = title?.includes(': ') ? title.slice(title.indexOf(': ') + 2) : undefined;
  return said ? said.charAt(0).toUpperCase() + said.slice(1) : undefined;
}

/** Every screen in the rail, by the name a screen reader gives it, and its label there as another way to find it. */
export const screensSource: SwitcherSource = {
  id: 'screens',
  heading: 'Screens',
  position: 30,
  results: () =>
    navGroups
      .flatMap((group) => group.items)
      .map((item, index): SwitcherResult => {
        const detail = describe(item.title);
        return {
          id: `screen:${item.route}`,
          label: item.name ?? item.label,
          ...(detail ? { detail } : {}),
          keywords: `${item.label} ${item.route}`,
          href: `#${item.route}`,
          order: index,
        };
      }),
};

/**
 * The plain actions, each what the matching button elsewhere does. None of them is risky, so none
 * can approve, deny, turn on auto approve, wipe, stop or pause anything.
 */
export const actionsSource: SwitcherSource = {
  id: 'actions',
  heading: 'Actions',
  position: 40,
  results: ({ controls }: SwitcherContext) => [
    {
      id: 'action:new-agent',
      label: 'New agent',
      detail: 'Make a new agent and give it a desk',
      run: controls.newAgent,
      order: 0,
    },
    {
      id: 'action:new-project',
      label: 'New project',
      detail: 'Describe a project and let the planner pick a team',
      run: controls.newProject,
      order: 1,
    },
    {
      id: 'action:quiet-mode',
      label: 'Quiet mode',
      detail: 'Hide everything on the floor but what needs you',
      chip: { text: controls.quietOn ? 'On' : 'Off', tone: '' },
      run: controls.toggleQuiet,
      order: 2,
    },
    {
      id: 'action:switch-theme',
      label: 'Switch theme',
      detail: controls.theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme',
      run: controls.toggleTheme,
      order: 3,
    },
  ],
};

for (const source of [agentsSource, projectsSource, screensSource, actionsSource]) {
  registerSource(source);
}
