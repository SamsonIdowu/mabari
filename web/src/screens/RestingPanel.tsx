// SPDX-License-Identifier: Apache-2.0
// An agent file resting in the lounge, opened like any agent on the floor: who it is, what it
// does, and a box to give it a task, which sits it down at a desk to start.
import { useState, type FormEvent } from 'react';
import { api } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import type { AgentDef, Snapshot } from '../gen/models.ts';
import { openDef } from '../office/builderStore.tsx';
import { restingLook } from '../office/resting.ts';
import { startable } from '../office/startable.ts';
import { useOfficeUi } from '../office/uiStore.ts';
import { providers } from '../shared/tokens.ts';
import { Icon } from '../shell/Icon.tsx';

function StartTask({ office, def }: { office: Snapshot; def: AgentDef }) {
  const toast = useOfficeStore((state) => state.toast);
  const set = useOfficeUi((state) => state.set);
  const open = office.projects.filter((project) => project.status !== 'done');
  // A real Claude agent opens in a project's folder; in the demo, any project, or none, will do.
  const anywhere = office.demo;
  const choices = anywhere ? open : open.filter((project) => project.repository?.path);
  const own = def.scope === 'project';
  const [chosen, setChosen] = useState(choices[0]?.id ?? '');
  const projectId = own ? def.projectId : chosen;
  const [task, setTask] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const noFolder = !anywhere && !own && !choices.length;
  const canStart = startable([def], office.projects).length > 0;
  const projectName = (id: string) => office.projects.find((item) => item.id === id)?.name ?? '';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!task.trim()) {
      setError(`Say what ${def.name} should do.`);
      return;
    }
    setBusy(true);
    setError('');
    api
      .startAtDesk(def.id, projectId, task.trim())
      .then((result) => {
        // With no window to open, the panel stays, saying how to start it by hand.
        if (!result.opened && !result.agentId) {
          setNotice(result.notice);
          return;
        }
        toast(result.notice);
        // The agent it became takes over the panel once it is on the floor.
        set({ selected: result.agentId || null, follow: false });
      })
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : String(failure)),
      )
      .finally(() => setBusy(false));
  };

  if (!canStart) {
    return (
      <p className="help">
        {def.enabled
          ? 'Its project is completed, so it stays resting.'
          : 'It is turned off in the Builder.'}
      </p>
    );
  }
  return (
    <form className="restform" onSubmit={submit} aria-label={`Give ${def.name} a task`}>
      <div className="field">
        <label htmlFor="rsProject">Project</label>
        <select
          className="in"
          id="rsProject"
          value={projectId}
          disabled={own}
          onChange={(event) => setChosen(event.target.value)}
        >
          {own ? <option value={def.projectId}>{projectName(def.projectId)}</option> : null}
          {!own && anywhere ? <option value="">No project</option> : null}
          {!own
            ? choices.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))
            : null}
        </select>
        {noFolder ? (
          <span className="help">
            Attach a folder to a project first, on the Projects page: the agent works in it.
          </span>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor="rsTask">What should it do?</label>
        <textarea
          className="in"
          id="rsTask"
          placeholder="For example: review the checkout changes and list anything risky."
          value={task}
          onChange={(event) => setTask(event.target.value)}
        />
      </div>
      {error ? (
        <p role="alert" style={{ color: 'var(--red)', fontWeight: 700 }} className="help">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="help" style={{ fontWeight: 700 }}>
          {notice}
        </p>
      ) : null}
      <button type="submit" className="btn primary" disabled={busy || noFolder}>
        {busy ? 'Starting…' : 'Start at a desk'}
      </button>
    </form>
  );
}

/**
 * The panel for an agent file resting in the lounge, opened from the floor or the list beside it
 * as any agent's panel is. Nothing is running, so it says what the agent is and offers a task.
 */
export function RestingPanel({ office, def }: { office: Snapshot; def: AgentDef }) {
  const set = useOfficeUi((state) => state.set);
  const look = restingLook(def);
  const provider = providers[look.provider];
  const project = office.projects.find((item) => item.id === def.projectId);
  return (
    <aside className="panel" aria-label="Agent details">
      <div
        className={`phd ${provider.cssClass}`}
        style={{ ['--ac' as string]: look.hue, boxShadow: `inset 0 4px 0 ${look.hue}` }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <h2 style={{ fontSize: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="idot" />
              {def.name}
            </h2>
            <div className="meta">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span className="pdot" />
                <b>{provider.label}</b>
              </span>
              {def.model ? <span className="mono">{def.model}</span> : null}
              <span className="chip">Resting</span>
            </div>
          </div>
          <span style={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
            <button
              type="button"
              className="btn ghost sm"
              aria-label="Edit in the Builder"
              title="Edit in the Builder"
              onClick={() => openDef(def.id)}
            >
              <Icon>
                <path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />
              </Icon>
            </button>
            <button
              type="button"
              className="btn ghost sm"
              aria-label="Close panel"
              onClick={() => set({ selected: null, follow: false })}
            >
              <Icon>
                <path d="M6 6l12 12M18 6 6 18" />
              </Icon>
            </button>
          </span>
        </div>
        <div className="meta">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {def.scope === 'project' ? 'Project' : 'Account agent'}
            {def.scope === 'project' ? (
              <>
                <span className="pdot" style={{ background: project?.color ?? '#9AA0AE' }} />
                <b>{project?.name ?? 'its project'}</b>
              </>
            ) : null}
          </span>
          <span>
            Runs <b className="num">{def.runs}</b>
          </span>
        </div>
      </div>
      <div className="pbody">
        <div className="sect">
          <h3>What it does</h3>
          <p style={{ fontWeight: 700, fontSize: 15 }}>
            {def.description || 'No description yet.'}
          </p>
        </div>
        {def.tools.length ? (
          <div className="sect">
            <h3>Tools</h3>
            <p className="help mono">{def.tools.join(', ')}</p>
          </div>
        ) : null}
        <div className="sect">
          <h3>Give it a task</h3>
          <p className="help">
            It is resting in the lounge, with nothing running. Give it a task and it sits down at a
            desk to start.
          </p>
          <StartTask office={office} def={def} key={def.id} />
        </div>
      </div>
    </aside>
  );
}
