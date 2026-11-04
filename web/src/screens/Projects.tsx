// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
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
import { useOfficeUi } from '../office/uiStore.ts';
import { Icon } from '../shell/Icon.tsx';
import { LATER, PageHead } from './parts.tsx';

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
      onClick={() => useOfficeUi.getState().set({ selected: agent.id })}
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
  if (!project.repository && !files && !project.instructions) return null;
  return (
    <p className="help" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      {project.repository ? (
        <span>
          Repo <b className="mono">{project.repository.path}</b> · {project.repository.branch}
        </span>
      ) : null}
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
          [String(done.agents), 'Agents'],
          [minsText(done.mins * 60), 'Time taken'],
          [`$${done.cost.toFixed(2)}`, 'Cost'],
        ]}
      />
      <CardMeta project={project} />
      <div className="scroll" style={{ gap: 8 }}>
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
      </div>
    </>
  );
}

function OpenBody({ project, agents }: { project: Project; agents: LiveAgent[] }) {
  const working = agents.filter((agent) => agent.estimate).length;
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
              <b style={{ color: 'var(--fg)' }}>Estimated completion:</b> about{' '}
              {minsText(estimate.secondsLeft)}, around {clockText(estimate.finishAt)}
            </>
          ) : waiting ? (
            'Waiting on you before it can finish'
          ) : (
            'Nothing in progress'
          )}
        </p>
      )}
      <div className="scroll" style={{ gap: 6 }}>
        <AgentRows agents={agents} />
      </div>
    </>
  );
}

function ProjectCard({ project, agents }: { project: Project; agents: LiveAgent[] }) {
  const done = !isOpen(project);
  const status = projectStatus(project.status);
  const percent = Math.round(project.progress * 100);
  const colour = done ? 'var(--ok)' : project.color;
  const canComplete = project.status === 'ready' || project.status === 'idle';
  return (
    <article
      className={done ? 'card eqcard pdone' : 'card eqcard'}
      style={{ height: 470, boxShadow: `inset 0 4px 0 ${colour}` }}
    >
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
        <span className={`chip ${status.chip}`}>
          {done || project.status === 'ready' ? <Check /> : <i />}
          {status.label}
        </span>
      </div>
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
            onClick={() => void api.completeProject(project.id)}
          >
            <Check />
            Mark as complete
          </button>
        ) : null}
        <a
          className={done || canComplete ? 'btn sm' : 'btn sm primary'}
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
          <button type="button" className="btn sm" disabled title={LATER}>
            Start agent here
          </button>
        )}
      </div>
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
    <article className="card eqcard" style={{ height: 470, boxShadow: 'inset 0 4px 0 #A99CFF' }}>
      <div className="acchead" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span className="pdot" style={{ background: '#A99CFF' }} />
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
            <b style={{ color: 'var(--fg)' }}>Estimated completion:</b> about {minsText(longest)},
            around {clockText(finish)}
          </>
        ) : (
          'Nothing in progress'
        )}
      </p>
      <div className="scroll" style={{ gap: 6 }}>
        <AgentRows agents={agents} />
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <a className="btn sm primary" href="#office">
          Open in office
        </a>
      </div>
    </article>
  );
}

type Filter = 'all' | 'open' | 'done';

export function Projects() {
  const office = useOfficeStore((state) => state.office);
  const [filter, setFilter] = useState<Filter>('all');
  if (!office) return null;

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
          <button type="button" className="btn primary" disabled title={LATER}>
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
          <span className="help">
            {done} of {projects.length} project{projects.length === 1 ? '' : 's'} completed
          </span>
        </div>
        {filter !== 'all' && shown.length === 0 ? (
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
    </section>
  );
}
