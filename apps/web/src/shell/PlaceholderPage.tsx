import type { Route } from '../routes.ts';

/** Headings and descriptions copied from the prototype. Stage 2 replaces these bodies. */
const pages: Record<Route, { title: string; description?: string }> = {
  welcome: {
    title: 'See your AI agents at work, in a little office.',
    description:
      'Mabari shows every agent session as a character at a desk. Watch what each one is doing, ask questions without interrupting, and send instructions by typing or by voice.',
  },
  office: { title: 'Office' },
  projects: {
    title: 'Projects',
    description:
      'Agents grouped by the work they do. Open a project to see only its agents on the floor. Subagents are listed under the agent whose office they work in.',
  },
  conversations: {
    title: 'Conversations',
    description:
      'What agents say to each other: questions, answers, handoffs, reviews and subagent reports. Pick a pair to read their thread.',
  },
  accounts: {
    title: 'Accounts',
    description:
      'Connect the places your agents come from. Each connection shows its status and the models it gives you.',
  },
  activity: {
    title: 'Activity log',
    description:
      'Every instruction you sent, every question you asked and every approval you gave.',
  },
  preferences: { title: 'Settings', description: 'Everything here stays on this computer.' },
  components: {
    title: 'Component sheet',
    description:
      'The building blocks of Mabari. Switch the theme in the side rail to see both versions.',
  },
  states: {
    title: 'Status screens',
    description:
      'What people see when something is missing or wrong. Each one names the problem and the one action that fixes it.',
  },
};

export function PlaceholderPage({ route }: { route: Route }) {
  const { title, description } = pages[route];
  return (
    <section data-screen={route}>
      <div className="page">
        <div className="phead">
          <div>
            <h1>{title}</h1>
            {description ? <p>{description}</p> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
