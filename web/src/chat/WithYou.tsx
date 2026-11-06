// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../data/api.ts';
import { useConversations } from '../data/conversation.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import { STATE_CHIPS, stateLabel } from '../format.ts';
import type { LiveAgent, Project, Snapshot } from '../gen/models.ts';
import { useOfficeUi } from '../office/uiStore.ts';
import { Cast } from '../shell/Cast.tsx';
import { hashWith } from '../routes.ts';
import { chatEntries, entryMatches, type ChatEntry } from './chatList.ts';
import { chatHash, chatPlace, useChatHash } from './chatRoute.ts';
import { Composer, type ComposerHandle } from './Composer.tsx';
import { historyOf } from './composerModel.ts';
import { splitUserText } from './threadModel.ts';
import { ThreadView } from './ThreadView.tsx';

const WIDE = '(min-width: 981px)';

/** Whether the list and the thread fit side by side, which they do from 981 pixels. */
function useWide(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(WIDE);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => window.matchMedia(WIDE).matches,
  );
}

function Row({ entry, on }: { entry: ChatEntry; on: boolean }) {
  const href = entry.kind === 'agent' ? chatHash.agent(entry.id) : chatHash.project(entry.id);
  return (
    <a
      href={href}
      className={`wyrow ${entry.tone}${on ? ' on' : ''}`}
      aria-current={on ? 'true' : undefined}
      data-entry={`${entry.kind}:${entry.id}`}
    >
      <span
        className={entry.kind === 'agent' ? 'idot' : 'pdot'}
        style={
          entry.kind === 'agent' ? { ['--ac' as string]: entry.color } : { background: entry.color }
        }
        aria-hidden="true"
      />
      <span className="wymain">
        <span className="wyname">{entry.name}</span>
        <span className="wydet">{entry.detail}</span>
      </span>
      {entry.tone === 'red' ? <span className="chip red">Needs you</span> : null}
      {entry.tone !== 'red' && entry.needs ? <span className="chip">Asking you</span> : null}
    </a>
  );
}

function List({ office, selected }: { office: Snapshot; selected: string }) {
  const [search, setSearch] = useState('');
  const entries = useMemo(() => chatEntries(office), [office]);
  const agents = entries.agents.filter((entry) => entryMatches(entry, search));
  const projects = entries.projects.filter((entry) => entryMatches(entry, search));
  // Counted by agent, as the badge and Home count: a project only holds some of the same agents.
  const needs = entries.agents.filter((entry) => entry.needs).length;
  return (
    <div className="card wylist">
      <div className="cardhd">
        <label className="sr" htmlFor="chatQ">
          Search agents and projects
        </label>
        <input
          className="in"
          id="chatQ"
          placeholder="Search agents and projects"
          style={{ minHeight: 36 }}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <nav className="wybody" aria-label="Who to talk to">
        <p className="help wyhint" role="status">
          {needs
            ? `${needs} need${needs === 1 ? 's' : ''} you, listed first.`
            : 'Nobody needs you right now.'}
        </p>
        {agents.length ? (
          <section aria-labelledby="chAgents">
            <h2 className="mhead" id="chAgents">
              <span>Agents</span>
              <span className="num">{agents.length}</span>
            </h2>
            {agents.map((entry) => (
              <Row key={entry.id} entry={entry} on={selected === `agent:${entry.id}`} />
            ))}
          </section>
        ) : null}
        {projects.length ? (
          <section aria-labelledby="chProjects">
            <h2 className="mhead" id="chProjects">
              <span>Projects</span>
              <span className="num">{projects.length}</span>
            </h2>
            {projects.map((entry) => (
              <Row key={entry.id} entry={entry} on={selected === `project:${entry.id}`} />
            ))}
          </section>
        ) : null}
        {!agents.length && !projects.length ? (
          <div className="emptycast">
            {search ? null : <Cast who={0} act="wave" />}
            <p className="help wyempty">
              {search
                ? 'Nothing matches.'
                : 'Nobody to talk to yet. Start an agent or a project from the Agents page.'}
            </p>
          </div>
        ) : null}
      </nav>
    </div>
  );
}

function AgentHeader({ agent, office }: { agent: LiveAgent; office: Snapshot }) {
  const project = office.projects.find((item) => item.id === agent.projectId);
  const chip = STATE_CHIPS[agent.state];
  return (
    <div className="cardhd wyhead">
      <div className="wytitle">
        <a className="btn ghost sm wyback" href={chatHash.with()}>
          All chats
        </a>
        <span className="idot" style={{ ['--ac' as string]: agent.hue }} aria-hidden="true" />
        <h2>{agent.name}</h2>
        {agent.question ? (
          <span className="chip">Asking you</span>
        ) : (
          <span className={`chip ${chip ?? ''}`}>
            {chip ? <i /> : null}
            {stateLabel(agent.state)}
          </span>
        )}
        <span className="help mono">{agent.model}</span>
        {project ? (
          <span className="help">
            <span className="pdot" style={{ background: project.color }} /> {project.name}
          </span>
        ) : null}
      </div>
      <div className="wytools">
        <a className="btn sm" href={hashWith('office', 'agent', agent.id)}>
          Open in office
        </a>
      </div>
    </div>
  );
}

function ProjectHeader({ project, agents }: { project: Project; agents: LiveAgent[] }) {
  const toast = useOfficeStore((state) => state.toast);
  const folder = project.repository?.path ?? '';
  const live = agents.filter((agent) => agent.projectId === project.id && !agent.leadId);
  const who = live.length
    ? `${live.map((agent) => agent.name).join(', ')} ${live.length === 1 ? 'works' : 'work'} here`
    : 'Nobody works here yet';
  return (
    <div className="cardhd wyhead">
      <div className="wytitle">
        <a className="btn ghost sm wyback" href={chatHash.with()}>
          All chats
        </a>
        <span className="pdot" style={{ background: project.color }} aria-hidden="true" />
        <h2>{project.name}</h2>
        <span className="help">{who}</span>
        {folder ? (
          <span className="help mono" title={folder}>
            {folder}
          </span>
        ) : (
          <span className="help">No folder yet</span>
        )}
      </div>
      <div className="wytools">
        {folder ? (
          <button
            type="button"
            className="btn sm"
            onClick={() =>
              void api
                .openProjectClaude(project.id)
                .then(({ notice }) => toast(notice))
                .catch((error: Error) => toast(error.message))
            }
          >
            Open Claude Code
          </button>
        ) : null}
        <a
          className="btn sm"
          href="#office"
          onClick={() => useOfficeUi.getState().set({ project: project.id, team: null })}
        >
          Open in office
        </a>
      </div>
    </div>
  );
}

/** What was sent in a thread before, for the Up arrow: the person's own words, oldest first. */
function useHistory(agents: LiveAgent[]): string[] {
  const threads = useConversations((state) => state.threads);
  return useMemo(() => {
    const sent: { time: number; text: string }[] = [];
    for (const agent of agents) {
      for (const item of threads[agent.id]?.items ?? []) {
        if (item.kind === 'user' && item.from !== 'session') {
          const body = splitUserText(item.text).body;
          if (body) sent.push({ time: item.time, text: body });
        }
      }
      for (const queued of agent.queued ?? [])
        sent.push({ time: queued.time, text: splitUserText(queued.text).body });
    }
    return historyOf(sent.sort((a, b) => a.time - b.time).map((entry) => entry.text));
  }, [agents, threads]);
}

function AgentChat({ agent, office }: { agent: LiveAgent; office: Snapshot }) {
  const composer = useRef<ComposerHandle>(null);
  const agents = useMemo(() => [agent], [agent]);
  const history = useHistory(agents);
  return (
    <>
      <AgentHeader agent={agent} office={office} />
      <ThreadView
        mode="agent"
        label={`Messages with ${agent.name}`}
        agents={agents}
        composer={composer}
        empty={`Nothing said yet. Tell ${agent.name} what to do below.`}
      />
      <Composer
        ref={composer}
        key={agent.id}
        target={{ kind: 'agent', agent }}
        office={office}
        history={history}
      />
    </>
  );
}

function ProjectChat({ project, office }: { project: Project; office: Snapshot }) {
  const composer = useRef<ComposerHandle>(null);
  const here = useMemo(
    () => office.agents.filter((agent) => agent.projectId === project.id && !agent.leadId),
    [office.agents, project.id],
  );
  const history = useHistory(here);
  const folder = project.repository?.path ?? '';
  return (
    <>
      <ProjectHeader project={project} agents={office.agents} />
      <ThreadView
        mode="project"
        label={`Messages with ${project.name}`}
        agents={here}
        project={project}
        composer={composer}
        empty={
          folder
            ? `Nothing sent yet. Tell ${project.name} what to do in ${folder}, or run a /command.`
            : 'Nothing sent yet. Attach a folder so Claude Code can open here.'
        }
      />
      <Composer
        ref={composer}
        key={project.id}
        target={{ kind: 'project', project, agents: here }}
        office={office}
        history={history}
      />
    </>
  );
}

/**
 * With you: the agents and projects on the left, in the order of who needs you, and the thread
 * beside them. The address says which is open, so a link opens it and Back closes it.
 */
export function WithYou({ office }: { office: Snapshot }) {
  const hash = useChatHash();
  const place = chatPlace(hash);
  const wide = useWide();
  const entries = useMemo(() => chatEntries(office), [office]);
  // On a wide screen the thread beside the list is the first in the list until another is picked.
  const fallback =
    wide && !place.agent && !place.project ? (entries.agents[0] ?? entries.projects[0]) : undefined;
  const agent = office.agents.find(
    (item) => item.id === (place.agent ?? (fallback?.kind === 'agent' ? fallback.id : '')),
  );
  const project = office.projects.find(
    (item) => item.id === (place.project ?? (fallback?.kind === 'project' ? fallback.id : '')),
  );
  const open = agent ?? project;
  const selected = agent ? `agent:${agent.id}` : project ? `project:${project.id}` : '';
  const stale = (place.agent && !agent) || (place.project && !project);

  // A link to someone who has left shows the list, and the address drops it.
  useEffect(() => {
    if (stale) window.history.replaceState(window.history.state, '', chatHash.with());
  }, [stale]);

  return (
    <div className={`convwrap wywrap${open ? ' open' : ''}`}>
      <List office={office} selected={selected} />
      <div className="card wycard">
        {agent ? (
          <AgentChat agent={agent} office={office} key={agent.id} />
        ) : project ? (
          <ProjectChat project={project} office={office} key={project.id} />
        ) : (
          <div className="emptycast">
            <Cast who={0} act="wave" />
            <p className="help">Pick an agent or a project to talk to.</p>
          </div>
        )}
      </div>
    </div>
  );
}
