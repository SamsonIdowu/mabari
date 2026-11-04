// SPDX-License-Identifier: Apache-2.0
import { useState, type FormEvent } from 'react';
import { api } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import type { AccountKind, Snapshot } from '../gen/models.ts';
import { useOfficeUi } from '../office/uiStore.ts';
import { Icon } from '../shell/Icon.tsx';
import { DialogFrame } from './AgentDialogs.tsx';
import { TOOLS } from './tools.ts';

const DEFAULT_TOOLS = ['read', 'edit'];
const DEFAULT_CAP = 5;
const DEFAULT_FOLDER = '~/code/shop';

interface Role {
  label: string;
  sub: string;
  name: string;
  task: string;
  tools: string[];
}

const ROLES: Role[] = [
  {
    label: 'Coder',
    sub: 'Builds features',
    name: 'Juniper',
    task: 'Build the feature described in the project brief. Keep changes small and add tests.',
    tools: ['read', 'edit', 'shell'],
  },
  {
    label: 'Tester',
    sub: 'Writes and runs tests',
    name: 'Pepper',
    task: 'Write tests for untested code and run the full suite. Report failures with the likely cause.',
    tools: ['read', 'edit', 'shell'],
  },
  {
    label: 'Reviewer',
    sub: 'Checks changes',
    name: 'Hazel',
    task: 'Review recent changes for bugs, security issues and missing tests. Leave clear suggestions.',
    tools: ['read'],
  },
  {
    label: 'Docs writer',
    sub: 'Keeps docs current',
    name: 'Wren',
    task: 'Keep the docs folder and README in sync with the code. Write in plain language.',
    tools: ['read', 'edit'],
  },
  {
    label: 'Researcher',
    sub: 'Looks things up',
    name: 'Marlow',
    task: 'Research the question in the brief, compare options and write a short recommendation.',
    tools: ['read', 'web'],
  },
  { label: 'Blank', sub: 'Start from scratch', name: '', task: '', tools: DEFAULT_TOOLS },
];

const ACCOUNT_LABELS: Partial<Record<AccountKind, string>> = {
  codex: 'ChatGPT (Codex)',
  claude_code: 'Claude Code on this computer',
};

/** Adds a number when the name is taken, so a role can be used twice. */
function freeName(name: string, office: Snapshot): string {
  const taken = (candidate: string) => office.agents.some((agent) => agent.name === candidate);
  if (!name || !taken(name)) return name;
  let number = 2;
  while (taken(`${name} ${number}`)) number++;
  return `${name} ${number}`;
}

function Form({ office, desk, project }: { office: Snapshot; desk?: number; project?: string }) {
  const set = useOfficeUi((state) => state.set);
  const scope = useOfficeUi((state) => state.project);
  const accounts = office.accounts.filter(
    (item) => item.status === 'connected' && ACCOUNT_LABELS[item.kind],
  );
  const leads = office.agents.filter((agent) => !agent.leadId);
  const [name, setName] = useState('');
  const [task, setTask] = useState('');
  const [tools, setTools] = useState(DEFAULT_TOOLS);
  // A role fills a box only if it is empty or still holds what a role put there.
  const [filled, setFilled] = useState({ name: false, task: false });
  const [role, setRole] = useState('');
  const [account, setAccount] = useState<AccountKind | ''>(accounts[0]?.kind ?? '');
  const [model, setModel] = useState('');
  const [cap, setCap] = useState(String(DEFAULT_CAP));
  const [projectId, setProjectId] = useState(
    project ?? (scope === 'all' ? office.projects[0]?.id : scope) ?? '',
  );
  const [lead, setLead] = useState('');
  const [folder, setFolder] = useState(DEFAULT_FOLDER);
  const [error, setError] = useState('');
  const close = () => set({ newAgent: null });
  const models = accounts.find((item) => item.kind === account)?.models ?? [];

  const applyRole = (choice: Role) => {
    setRole(choice.label);
    const next = { ...filled };
    if (!name || filled.name) {
      setName(freeName(choice.name, office));
      next.name = true;
    }
    if (!task || filled.task) {
      setTask(choice.task);
      next.task = true;
    }
    setFilled(next);
    setTools(choice.tools);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError('Give the agent a name.');
      return;
    }
    api
      .createAgent({
        name,
        account: account as AccountKind,
        model: model || models[0] || '',
        task,
        projectId,
        folder,
        dailyCostCap: Number(cap),
        allowedTools: tools,
        ...(desk === undefined ? {} : { desk }),
        ...(lead ? { leadId: lead } : {}),
      })
      .then(() => {
        close();
        window.location.hash = '#office';
      })
      .catch((failure: Error) => setError(failure.message));
  };

  return (
    <DialogFrame
      id="naTitle"
      wide
      titleSize={22}
      title={<>Create a new agent</>}
      help={`Pick a role to fill in the details, or start from scratch. It walks in and takes ${
        desk === undefined ? 'the next free desk' : `desk ${desk + 1}`
      }.`}
      close={close}
      onSubmit={submit}
    >
      {accounts.length ? null : (
        <div className="banner amber">
          <Icon>
            <path d="M12 8v5M12 16h.01" />
          </Icon>
          <span className="grow">Connect ChatGPT or add an API key first.</span>
          <a className="btn sm" href="#accounts" onClick={close}>
            Go to Accounts
          </a>
        </div>
      )}
      <div className="field">
        <span className="flabel">Role</span>
        <div className="roles" role="group" aria-label="Role">
          {ROLES.map((choice) => (
            <button
              type="button"
              className={role === choice.label ? 'rolebtn on' : 'rolebtn'}
              key={choice.label}
              aria-pressed={role === choice.label}
              onClick={() => applyRole(choice)}
            >
              <b>{choice.label}</b>
              <span>{choice.sub}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="grid2" style={{ gap: 16 }}>
        <div className="field">
          <label htmlFor="naName">Name</label>
          <input
            className="in"
            id="naName"
            autoFocus
            maxLength={20}
            placeholder="For example: Juniper"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setFilled({ ...filled, name: false });
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="naAcc">Account</label>
          <select
            className="in"
            id="naAcc"
            value={account}
            onChange={(event) => {
              setAccount(event.target.value as AccountKind);
              setModel('');
            }}
          >
            {accounts.map((item) => (
              <option value={item.kind} key={item.kind}>
                {ACCOUNT_LABELS[item.kind]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="naModel">Model</label>
          <select
            className="in"
            id="naModel"
            value={model || models[0] || ''}
            onChange={(event) => setModel(event.target.value)}
          >
            {models.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="naCap">Daily cost cap</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="muted">$</span>
            <input
              className="in num"
              id="naCap"
              type="number"
              min="0"
              step="1"
              value={cap}
              onChange={(event) => setCap(event.target.value)}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="naProj">Project</label>
          <select
            className="in"
            id="naProj"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            {office.projects.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        {desk === undefined ? (
          <div className="field">
            <label htmlFor="naLead">Desk</label>
            <select
              className="in"
              id="naLead"
              value={lead}
              onChange={(event) => setLead(event.target.value)}
            >
              <option value="">Its own desk</option>
              {leads.map((agent) => (
                <option value={agent.id} key={agent.id}>
                  In {agent.name}&apos;s office, as a subagent
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor="naInst">Instructions</label>
        <textarea
          className="in"
          id="naInst"
          placeholder="What should this agent do? For example: keep the docs folder in sync with the API changes."
          value={task}
          onChange={(event) => {
            setTask(event.target.value);
            setFilled({ ...filled, task: false });
          }}
        />
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
      <div className="field">
        <label htmlFor="naDir">Working folder</label>
        <input
          className="in mono"
          id="naDir"
          placeholder="~/code/my-project"
          value={folder}
          onChange={(event) => setFolder(event.target.value)}
        />
      </div>
      {error ? (
        <p role="alert" style={{ color: 'var(--red)', fontWeight: 700 }} className="help">
          {error}
        </p>
      ) : null}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={!accounts.length}>
          Create agent
        </button>
      </div>
    </DialogFrame>
  );
}

/** Opened from anywhere: the header, a Projects card, an empty desk or Vee. */
export function NewAgentDialog() {
  const office = useOfficeStore((state) => state.office);
  const request = useOfficeUi((state) => state.newAgent);
  if (!office || !request) return null;
  return <Form office={office} {...request} />;
}
