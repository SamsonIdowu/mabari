// SPDX-License-Identifier: Apache-2.0
// Clicking the free desk in the work area: pick one of the agent files, the project it works in
// and what it should do, and it sits down at that desk to start.
import { useState, type FormEvent } from 'react';
import { api } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import type { Snapshot } from '../gen/models.ts';
import { startable } from '../office/startable.ts';
import { useOfficeUi } from '../office/uiStore.ts';
import { DialogFrame } from './AgentDialogs.tsx';

function Form({ office, desk }: { office: Snapshot; desk: number }) {
  const set = useOfficeUi((state) => state.set);
  const toast = useOfficeStore((state) => state.toast);
  const defs = startable(office.defs, office.projects);
  const open = office.projects.filter((project) => project.status !== 'done');
  const withFolder = open.filter((project) => project.repository?.path);
  const [defId, setDefId] = useState(defs[0]?.id ?? '');
  const def = defs.find((item) => item.id === defId);
  // A real Claude agent opens in a project's folder; in the demo, any project, or none, will do.
  const anywhere = office.demo;
  const choices = anywhere ? open : withFolder;
  const [chosen, setChosen] = useState(choices[0]?.id ?? '');
  // A project's own agent works in that project.
  const projectId = def?.scope === 'project' ? def.projectId : chosen;
  const [task, setTask] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const noFolder = !anywhere && def?.scope !== 'project' && !withFolder.length;
  const close = () => set({ startAtDesk: null });
  const projectName = (id: string) => office.projects.find((item) => item.id === id)?.name ?? '';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!def) return;
    if (!task.trim()) {
      setError(`Say what ${def.name} should do.`);
      return;
    }
    setBusy(true);
    setError('');
    api
      .startAtDesk(def.id, projectId, task.trim())
      .then((result) => {
        // With no window to open, the dialog stays, saying how to start it by hand.
        if (!result.opened && !result.agentId) {
          setNotice(result.notice);
          return;
        }
        toast(result.notice);
        close();
      })
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : String(failure)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <DialogFrame
      id="deskDlg"
      title={<>Start work at desk {desk + 1}</>}
      help="Pick one of your agents and say what it should do. It sits down at this desk and starts."
      close={close}
      onSubmit={submit}
    >
      {defs.length ? (
        <>
          <div className="field">
            <label htmlFor="dkAgent">Agent</label>
            <select
              className="in"
              id="dkAgent"
              value={defId}
              onChange={(event) => setDefId(event.target.value)}
            >
              {defs.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ·{' '}
                  {item.scope === 'project' ? projectName(item.projectId) || 'project' : 'account'}
                </option>
              ))}
            </select>
            {def?.description ? <span className="help">{def.description}</span> : null}
          </div>
          <div className="field">
            <label htmlFor="dkProject">Project</label>
            <select
              className="in"
              id="dkProject"
              value={projectId}
              disabled={def?.scope === 'project'}
              onChange={(event) => setChosen(event.target.value)}
            >
              {def?.scope === 'project' ? (
                <option value={def.projectId}>{projectName(def.projectId)}</option>
              ) : null}
              {def?.scope !== 'project' && anywhere ? <option value="">No project</option> : null}
              {def?.scope !== 'project'
                ? choices.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))
                : null}
            </select>
            <span className="help">
              {noFolder
                ? 'Attach a folder to a project first, on the Projects page: the agent works in it.'
                : anywhere
                  ? 'It sits down and starts at once.'
                  : "It works in the project's folder. Claude Code opens there, running as this agent."}
            </span>
          </div>
          <div className="field">
            <label htmlFor="dkTask">What should it do?</label>
            <textarea
              className="in"
              id="dkTask"
              autoFocus
              placeholder="For example: review the checkout changes and list anything risky."
              value={task}
              onChange={(event) => setTask(event.target.value)}
            />
          </div>
        </>
      ) : (
        <p className="help">
          You have no agent files to start yet. Make one in the Builder, or make a new agent here.
        </p>
      )}
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
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn ghost"
          style={{ marginRight: 'auto' }}
          onClick={() => set({ startAtDesk: null, newAgent: { desk } })}
        >
          Make a new agent instead
        </button>
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={!def || busy || noFolder}>
          {busy ? 'Starting…' : 'Start'}
        </button>
      </div>
    </DialogFrame>
  );
}

/** Opened by clicking the free desk in the office. */
export function DeskDialog() {
  const office = useOfficeStore((state) => state.office);
  const desk = useOfficeUi((state) => state.startAtDesk);
  if (!office || desk === null) return null;
  return <Form key={desk} office={office} desk={desk} />;
}
