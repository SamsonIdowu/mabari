// SPDX-License-Identifier: Apache-2.0
import { useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import type { LiveAgent, Snapshot } from '../gen/models.ts';
import { Icon } from '../shell/Icon.tsx';

const TOOLS: [id: string, label: string][] = [
  ['read', 'Read files'],
  ['edit', 'Edit files'],
  ['shell', 'Run shell commands'],
  ['web', 'Browse the web'],
  ['spawn', 'Start subagents'],
];

const FOLDER = /^(~\/|~$|\/|[A-Za-z]:\\)/;

function modelsFor(agent: LiveAgent, office: Snapshot): string[] {
  if (agent.account === 'hub') return [agent.model];
  const models = office.accounts.find((item) => item.kind === agent.account)?.models ?? [];
  return models.length ? models : [agent.model];
}

function DialogFrame(props: {
  id: string;
  hue: string;
  wide?: boolean;
  title: ReactNode;
  help: string;
  close: () => void;
  onSubmit: (event: FormEvent) => void;
  children: ReactNode;
}) {
  return (
    <div className="scrim">
      <form
        className={props.wide ? 'dialog wide' : 'dialog'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={props.id}
        autoComplete="off"
        style={{ boxShadow: `var(--shadow),inset 0 4px 0 ${props.hue}` }}
        onSubmit={props.onSubmit}
      >
        <div className="dhd">
          <div>
            <h2
              id={props.id}
              style={{ fontSize: 20, display: 'flex', alignItems: 'center', gap: 8 }}
            >
              {props.title}
            </h2>
            <p className="help" style={{ marginTop: 2 }}>
              {props.help}
            </p>
          </div>
          <button type="button" className="btn ghost sm" aria-label="Close" onClick={props.close}>
            <Icon>
              <path d="M6 6l12 12M18 6 6 18" />
            </Icon>
          </button>
        </div>
        {props.children}
      </form>
    </div>
  );
}

const fail = (message: string) => (
  <p role="alert" style={{ color: 'var(--red)', fontWeight: 700 }} className="help">
    {message}
  </p>
);

export function AgentSettingsDialog(props: {
  agent: LiveAgent;
  office: Snapshot;
  lead: LiveAgent | undefined;
  close: () => void;
}) {
  const { agent, office, lead, close } = props;
  const [model, setModel] = useState(agent.model);
  const [subModel, setSubModel] = useState(agent.subModel);
  const [project, setProject] = useState(agent.projectId ?? '');
  const [cap, setCap] = useState(String(agent.dailyCostCap ?? 10));
  const [folder, setFolder] = useState(agent.folder);
  const [tools, setTools] = useState(agent.allowedTools ?? []);
  const [error, setError] = useState('');
  const models = modelsFor(agent, office);
  const claude = agent.account === 'claude_code';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = folder.trim();
    if (!FOLDER.test(trimmed)) {
      setError("That doesn't look like a folder path. Start it with ~/ or /.");
      return;
    }
    api
      .updateAgent(agent.id, {
        model,
        folder: trimmed,
        dailyCostCap: Number(cap),
        allowedTools: tools,
        ...(lead ? {} : { subModel, ...(project ? { projectId: project } : {}) }),
      })
      .then(() => {
        useOfficeStore.getState().toast(`${agent.name}'s settings saved`);
        close();
      })
      .catch((failure: Error) => setError(failure.message));
  };

  return (
    <DialogFrame
      id="asTitle"
      hue={agent.hue}
      wide
      title={
        <>
          <span className="idot" style={{ ['--ac' as string]: agent.hue }} />
          {agent.name}: agent settings
        </>
      }
      help={
        lead
          ? `This is a subagent. Its model normally comes from ${lead.name}'s settings.`
          : `Subagents started in ${agent.name}'s office take their model from here.`
      }
      close={close}
      onSubmit={submit}
    >
      <div className="grid2" style={{ gap: 16 }}>
        <div className="field">
          <label htmlFor="asModel">Model</label>
          <select
            className="in"
            id="asModel"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            {models.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
          <span className="help">
            {claude
              ? 'Claude Code switches model at its next checkpoint.'
              : agent.account === 'hub'
                ? 'Custom agents report their own model.'
                : 'Used from the next step.'}
          </span>
        </div>
        <div className="field">
          <label htmlFor="asSub">Subagents use</label>
          <select
            className="in"
            id="asSub"
            disabled={!!lead}
            value={subModel}
            onChange={(event) => setSubModel(event.target.value)}
          >
            <option value="inherit">Same model as {agent.name}</option>
            {models.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
          <span className="help">A smaller model keeps helpers fast and cheap.</span>
        </div>
        <div className="field">
          <label htmlFor="asProj">Project</label>
          <select
            className="in"
            id="asProj"
            disabled={!!lead}
            value={project}
            onChange={(event) => setProject(event.target.value)}
          >
            {office.projects.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <span className="help">
            {lead ? "Subagents follow their lead's project." : 'Its subagents move with it.'}
          </span>
        </div>
        <div className="field">
          <label htmlFor="asCap">Daily cost cap</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="muted">$</span>
            <input
              className="in num"
              id="asCap"
              type="number"
              min="0"
              step="1"
              value={cap}
              onChange={(event) => setCap(event.target.value)}
            />
          </div>
        </div>
      </div>
      <div className="field">
        <label htmlFor="asDir">Working folder</label>
        <input
          className="in mono"
          id="asDir"
          value={folder}
          placeholder="~/code/my-project"
          onChange={(event) => setFolder(event.target.value)}
        />
        {claude ? (
          <span className="help">
            Claude Code uses the new folder when its next session starts.
          </span>
        ) : null}
      </div>
      <div className="field">
        <span className="flabel">Allowed tools</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px' }}>
          {TOOLS.map(([id, label]) => (
            <label
              key={id}
              style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 600 }}
            >
              <input
                type="checkbox"
                checked={tools.includes(id)}
                style={{ accentColor: 'var(--accent)', width: 16, height: 16 }}
                onChange={(event) =>
                  setTools(
                    event.target.checked ? [...tools, id] : tools.filter((tool) => tool !== id),
                  )
                }
              />
              {label}
            </label>
          ))}
        </div>
      </div>
      {error ? fail(error) : null}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="btn primary">
          Save settings
        </button>
      </div>
    </DialogFrame>
  );
}

export function AddSubagentDialog(props: {
  lead: LiveAgent;
  office: Snapshot;
  count: number;
  close: () => void;
}) {
  const { lead, office, count, close } = props;
  const [name, setName] = useState(`${lead.name} ${['scout', 'runner', 'checker'][count % 3]}`);
  const [task, setTask] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState('');
  const project = office.projects.find((item) => item.id === lead.projectId);
  const derived = lead.subModel && lead.subModel !== 'inherit' ? lead.subModel : lead.model;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    api
      .addSubagent(lead.id, { name, task, model })
      .then((helper) => {
        useOfficeStore
          .getState()
          .toast(`${helper.name} joined ${lead.name}'s office on ${helper.model}`);
        close();
      })
      .catch((failure: Error) => setError(failure.message));
  };

  return (
    <DialogFrame
      id="subTitle"
      hue={lead.hue}
      title={<>Add a subagent to {lead.name}&apos;s office</>}
      help={`It sits at the closest free desk, works under ${lead.name} and joins the ${project?.name ?? 'No project'} project.`}
      close={close}
      onSubmit={submit}
    >
      <div className="field">
        <label htmlFor="subName">Name</label>
        <input
          className="in"
          id="subName"
          maxLength={24}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="subTask">Task</label>
        <textarea
          className="in"
          id="subTask"
          autoFocus
          placeholder={`For example: write the test fixtures while ${lead.name} finishes the refactor`}
          value={task}
          onChange={(event) => setTask(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="subModel">Model</label>
        <select
          className="in"
          id="subModel"
          value={model}
          onChange={(event) => setModel(event.target.value)}
        >
          <option value="">
            From {lead.name}&apos;s agent settings ({derived})
          </option>
          {modelsFor(lead, office).map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </div>
      {error ? fail(error) : null}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="btn primary">
          Add subagent
        </button>
      </div>
    </DialogFrame>
  );
}
