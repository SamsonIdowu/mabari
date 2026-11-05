// SPDX-License-Identifier: Apache-2.0
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import {
  agoText,
  clockText,
  dateText,
  etaShort,
  isOpen,
  minsText,
  projectStatus,
  STATE_CHIPS,
  stateLabel,
} from '../format.ts';
import type { LiveAgent, Project } from '../gen/models.ts';
import { openAgent, useOfficeUi, type ProjectsTab } from '../office/uiStore.ts';
import { Icon } from '../shell/Icon.tsx';
import { PageHead } from './parts.tsx';
import { ProjectChat } from './ProjectChat.tsx';
import { ProjectDialog } from './ProjectDialog.tsx';

const CHECK = 'M5 12.5l4.5 4.5L19 7.5';

function Check() {
  return (
    <Icon>
      <path d={CHECK} />
    </Icon>
  );
}

function AgentRow({ agent, sub }: { agent: LiveAgent; sub: boolean }) {
  const eta = etaShort(agent);
  return (
    <a
      className={`subrow p-${agent.provider}`}
      href="#office"
      onClick={(event) => {
        event.preventDefault();
        openAgent(agent, useOfficeStore.getState().office?.agents ?? []);
      }}
      style={{
        ['--ac' as string]: agent.hue,
        textDecoration: 'none',
        ...(sub ? { marginLeft: 24, width: 'calc(100% - 24px)' } : {}),
      }}
    >
      {sub ? (
        <span className="help" aria-hidden="true">
          ↳
        </span>
      ) : null}
      <span className="idot" />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        <b>{agent.name}</b> <span className="help mono">{agent.model}</span>
      </span>
      <span className="pdot" />
      <span className={`chip ${STATE_CHIPS[agent.state] ?? ''}`}>{stateLabel(agent.state)}</span>
      {eta ? <span className="help num">{eta}</span> : null}
    </a>
  );
}

function AgentRows({ agents }: { agents: LiveAgent[] }) {
  const leads = agents.filter(
    (agent) => !agent.leadId || !agents.some((other) => other.id === agent.leadId),
  );
  if (agents.length === 0) {
    return <p className="help">No agents yet. Start one and choose this project.</p>;
  }
  return leads.flatMap((lead) => [
    <AgentRow key={lead.id} agent={lead} sub={false} />,
    ...agents
      .filter((agent) => agent.leadId === lead.id)
      .map((agent) => <AgentRow key={agent.id} agent={agent} sub />),
  ]);
}

/**
 * A card's list. The card is a fixed height, so a long list scrolls, and a row cut in half at the
 * bottom says nothing about the rest. This counts the rows not fully in view and says so, and the
 * count follows the scrolling.
 */
function CardList({
  label,
  gap,
  noun,
  children,
}: {
  label: string;
  gap: number;
  noun: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(0);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    const count = () => {
      const edge = element.getBoundingClientRect().bottom;
      const rows = [...element.querySelectorAll(':scope > :not(.flabel)')].map((row) =>
        row.getBoundingClientRect(),
      );
      // Rows wholly out of view are counted. A row half in view fades out instead, so it reads as
      // the start of more rather than as a mistake.
      setHidden(rows.filter((row) => row.top >= edge - 1).length);
      setCut(rows.some((row) => row.bottom > edge + 1));
    };
    count();
    element.addEventListener('scroll', count, { passive: true });
    const observer = new ResizeObserver(count);
    observer.observe(element);
    return () => {
      element.removeEventListener('scroll', count);
      observer.disconnect();
    };
  });
  return (
    <>
      <div
        className={cut ? 'scroll fades' : 'scroll'}
        style={{ gap }}
        tabIndex={0}
        aria-label={label}
        ref={box}
      >
        {children}
      </div>
      {hidden ? (
        <button
          type="button"
          className="btn ghost sm morerows"
          aria-label={`${hidden} more ${noun}, show them`}
          onClick={() =>
            box.current?.scrollBy({ top: box.current.clientHeight * 0.8, behavior: 'smooth' })
          }
        >
          +{hidden} more
        </button>
      ) : null}
    </>
  );
}

function Counters(props: { values: [string, string][] }) {
  return (
    <div className="counters">
      {props.values.map(([value, label]) => (
        <div className="cnt" key={label}>
          <b className="num">{value}</b>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

function CardMeta({ project }: { project: Project }) {
  const files = project.files?.length ?? 0;
  // The folder has its own line, with Claude Code next to it.
  if (!files && !project.instructions) return null;
  return (
    <p className="help" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      {files ? (
        <span>
          {files} file{files === 1 ? '' : 's'}
        </span>
      ) : null}
      {project.instructions ? <span>Has instructions</span> : null}
    </p>
  );
}

function CompletedBody({ project }: { project: Project }) {
  const done = project.done;
  const [now] = useState(() => Date.now());
  if (!done) return null;
  return (
    <>
      <p className="donebanner">
        <Check />
        <span>
          <b>Completed {agoText(done.at, now)}</b>
          <br />
          <span className="help">{dateText(done.at)}</span>
        </span>
      </p>
      <Counters
        values={[
          // How many worked on it, when it was completed. Who is on the floor now can be fewer.
          [String(done.agents), 'Agents involved'],
          [minsText(done.mins * 60), 'Time taken'],
          [`$${done.cost.toFixed(2)}`, 'Cost'],
        ]}
      />
      <CardMeta project={project} />
      <CardList label="What got done" gap={8} noun="tasks">
        <span className="flabel">What got done</span>
        {done.tasks.length ? (
          done.tasks.map((task) => (
            <div className="doneitem" key={task}>
              <Check />
              <span>{task}</span>
            </div>
          ))
        ) : (
          <p className="help">No tasks recorded.</p>
        )}
      </CardList>
    </>
  );
}

function OpenBody({ project, agents }: { project: Project; agents: LiveAgent[] }) {
  const working = agents.filter((agent) => agent.working).length;
  const spend = agents.reduce((total, agent) => total + agent.cost, 0);
  const waiting = agents.some((agent) => agent.state === 'approval' || agent.state === 'error');
  const { estimate } = project;
  return (
    <>
      <Counters
        values={[
          [String(agents.length), 'Agents'],
          [String(working), 'Working'],
          [`$${spend.toFixed(2)}`, 'Est. cost'],
        ]}
      />
      <CardMeta project={project} />
      {project.status === 'ready' ? (
        <p className="donebanner soft">
          <Check />
          <span>
            <b>Every task here is finished.</b>
            <br />
            <span className="help">
              Mark the project as complete when you are happy with the work.
            </span>
          </span>
        </p>
      ) : (
        <p className="help">
          {estimate ? (
            <>
              Done around <b style={{ color: 'var(--fg)' }}>{clockText(estimate.finishAt)}</b>
            </>
          ) : waiting ? (
            'Waiting on you before it can finish'
          ) : (
            'Nothing in progress'
          )}
        </p>
      )}
      <CardList label="Agents on this project" gap={6} noun="agents">
        <AgentRows agents={agents} />
      </CardList>
    </>
  );
}

const toast = (text: string) => useOfficeStore.getState().toast(text);

/** The project's folder, and Claude Code opened there, or a way to attach one. */
function FolderLine({ project, edit }: { project: Project; edit: () => void }) {
  const folder = project.repository?.path;
  const open = () =>
    api
      .openProjectClaude(project.id)
      .then(({ notice }) => toast(notice))
      .catch((error: Error) => toast(error.message));
  return folder ? (
    <p className="help pfolder" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <span
        className="mono"
        title={folder}
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {folder}
        {project.repository?.branch ? ` · ${project.repository.branch}` : ''}
      </span>
      <button type="button" className="btn sm" onClick={() => void open()}>
        Open Claude Code here
      </button>
    </p>
  ) : (
    <p className="help pfolder" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <span style={{ flex: 1 }}>No folder yet.</span>
      <button type="button" className="btn sm" onClick={edit}>
        Attach a folder
      </button>
    </p>
  );
}

function ProjectCard({ project, agents }: { project: Project; agents: LiveAgent[] }) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const remove = () =>
    api
      .deleteProject(project.id)
      .then(() => toast(`${project.name} is deleted. Its agents stay, with no project.`))
      .catch((error: Error) => toast(error.message));
  const done = !isOpen(project);
  const status = projectStatus(project.status);
  const percent = Math.round(project.progress * 100);
  const colour = done ? 'var(--ok)' : project.color;
  const canComplete = project.status === 'ready' || project.status === 'idle';
  return (
    <article className={done ? 'card eqcard pdone' : 'card eqcard'} style={{ height: 470 }}>
      <div className="acchead" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {done ? (
            <span className="donetick" aria-hidden="true">
              <Check />
            </span>
          ) : (
            <span className="pdot" style={{ background: project.color }} />
          )}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {project.name}
          </span>
        </h2>
        <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span className={`chip ${status.chip}`}>
            {done || project.status === 'ready' ? <Check /> : <i />}
            {status.label}
          </span>
          <button
            type="button"
            className="btn ghost sm"
            aria-label={`Edit ${project.name}`}
            title="Edit the project"
            onClick={() => setEditing(true)}
          >
            <Icon>
              <path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />
            </Icon>
          </button>
          <button
            type="button"
            className="btn ghost sm"
            aria-label={`Delete ${project.name}`}
            title="Delete the project"
            onClick={() => setDeleting(true)}
          >
            <Icon>
              <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
            </Icon>
          </button>
        </span>
      </div>
      {deleting ? (
        <div className="banner red" style={{ padding: '8px 10px' }}>
          <span className="grow">
            Delete {project.name}? Its agents and files stay; only the project goes.
          </span>
          <button type="button" className="btn sm" onClick={() => setDeleting(false)}>
            Keep
          </button>
          <button type="button" className="btn sm danger" onClick={() => void remove()}>
            Delete
          </button>
        </div>
      ) : null}
      <FolderLine project={project} edit={() => setEditing(true)} />
      <div className="pbarwrap">
        <div
          className="pbar"
          role="progressbar"
          aria-label="Project progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <i style={{ width: `${percent}%`, background: colour }} />
        </div>
        <b className="num">{percent}%</b>
      </div>
      {done ? <CompletedBody project={project} /> : <OpenBody project={project} agents={agents} />}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {canComplete ? (
          <button
            type="button"
            className="btn sm ok"
            onClick={() => {
              api
                .completeProject(project.id)
                .catch((error: Error) => useOfficeStore.getState().toast(error.message));
            }}
          >
            <Check />
            Mark as complete
          </button>
        ) : null}
        {done ? null : (
          <button
            type="button"
            className={canComplete ? 'btn sm' : 'btn sm primary'}
            onClick={() => useOfficeUi.getState().set({ projectChat: project.id })}
          >
            Chat
          </button>
        )}
        <a
          className="btn sm"
          href="#office"
          onClick={() => useOfficeUi.getState().set({ project: project.id, team: null })}
        >
          Open in office
        </a>
        {done ? (
          <button
            type="button"
            className="btn sm"
            onClick={() => void api.reopenProject(project.id)}
          >
            Reopen
          </button>
        ) : (
          <button
            type="button"
            className="btn sm"
            onClick={() => useOfficeUi.getState().set({ newAgent: { project: project.id } })}
          >
            New agent here
          </button>
        )}
      </div>
      {editing ? <ProjectDialog project={project} close={() => setEditing(false)} /> : null}
    </article>
  );
}

function AllProjectsCard(props: { agents: LiveAgent[]; done: number; total: number }) {
  const { agents } = props;
  const working = agents.filter((agent) => agent.estimate);
  const spend = agents.reduce((total, agent) => total + agent.cost, 0);
  const longest = Math.max(0, ...working.map((agent) => agent.estimate?.secondsLeft ?? 0));
  const finish = Math.max(0, ...working.map((agent) => agent.estimate?.finishAt ?? 0));
  return (
    <article className="card eqcard" style={{ height: 470 }}>
      <div className="acchead" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span className="pdot" style={{ background: '#8E8E93' }} />
          <span>All projects</span>
        </h2>
        <span className="chip">
          {props.done} of {props.total} completed
        </span>
      </div>
      <Counters
        values={[
          [String(agents.length), 'Agents'],
          [String(working.length), 'Working'],
          [`$${spend.toFixed(2)}`, 'Est. cost'],
        ]}
      />
      <p className="help">
        {longest ? (
          <>
            Done around <b style={{ color: 'var(--fg)' }}>{clockText(finish)}</b>
          </>
        ) : (
          'Nothing in progress'
        )}
      </p>
      <CardList label="Agents on every project" gap={6} noun="agents">
        <AgentRows agents={agents} />
      </CardList>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <a
          className="btn sm primary"
          href="#office"
          onClick={() => useOfficeUi.getState().set({ project: 'all', team: null })}
        >
          Open in office
        </a>
      </div>
    </article>
  );
}

type Filter = ProjectsTab;

export function Projects() {
  const office = useOfficeStore((state) => state.office);
  // Kept in the store, which remembers it across screens and reloads.
  const filter = useOfficeUi((state) => state.projectsTab);
  const setFilter = (projectsTab: Filter) => useOfficeUi.getState().set({ projectsTab });
  const chatting = useOfficeUi((state) => state.projectChat);
  if (!office) return null;
  const chat = office.projects.find((project) => project.id === chatting);

  const projects = office.projects;
  const done = projects.filter((project) => !isOpen(project)).length;
  const open = projects.length - done;
  const shown = projects
    .filter((project) => filter === 'all' || (filter === 'done') === !isOpen(project))
    .sort((a, b) => Number(!isOpen(a)) - Number(!isOpen(b)));
  const tabs: [Filter, string, number][] = [
    ['all', 'All', projects.length],
    ['open', 'Open', open],
    ['done', 'Completed', done],
  ];

  return (
    <section data-screen="projects">
      <div className="page">
        <PageHead
          title="Projects"
          description="Agents grouped by the work they do. A green tick means the project is completed. Open a project to see only its agents on the floor."
        >
          <button
            type="button"
            className="btn primary"
            title="Describe a project and let the planner pick a team"
            onClick={() => useOfficeUi.getState().set({ newProject: true })}
          >
            <Icon>
              <path d="M12 5v14M5 12h14" />
            </Icon>
            New project
          </button>
        </PageHead>
        <div className="projbar">
          <div className="seg" role="group" aria-label="Show projects">
            {tabs.map(([id, label, count]) => (
              <button
                type="button"
                key={id}
                className={filter === id ? 'on' : ''}
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
              >
                {id === 'done' ? <Check /> : null}
                {label} <span className="n num">{count}</span>
              </button>
            ))}
          </div>
        </div>
        {projects.length === 0 ? (
          <div className="card" id="noProjects" style={{ textAlign: 'center', padding: 48 }}>
            <h2>No projects yet</h2>
            <p className="help">
              Describe what you want built and the planner proposes a team. Attach a folder or a Git
              URL if you have one, or start from scratch.
            </p>
            <p>
              <button
                type="button"
                className="btn primary"
                onClick={() => useOfficeUi.getState().set({ newProject: true })}
              >
                Start a new project
              </button>
            </p>
          </div>
        ) : filter !== 'all' && shown.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: 48 }}>
            <h2>No completed projects yet</h2>
            <p className="help">
              When every task in a project is finished, mark it as complete and it shows here.
            </p>
          </div>
        ) : (
          <div className="grid3">
            {filter === 'all' ? (
              <AllProjectsCard agents={office.agents} done={done} total={projects.length} />
            ) : null}
            {shown.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                agents={office.agents.filter((agent) => agent.projectId === project.id)}
              />
            ))}
          </div>
        )}
      </div>
      {chat ? (
        <ProjectChat
          key={chat.id}
          project={chat}
          close={() => useOfficeUi.getState().set({ projectChat: null })}
        />
      ) : null}
    </section>
  );
}
