// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { defaultModel } from '../data/accountInfo.ts';
import { api } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import type { Account, AccountKind, Snapshot } from '../gen/models.ts';
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
  anthropic_key: 'Anthropic API key',
  openai_key: 'OpenAI API key',
};

/** Adds a number when the name is taken, so a role can be used twice. */
function freeName(name: string, office: Snapshot): string {
  const taken = (candidate: string) => office.agents.some((agent) => agent.name === candidate);
  if (!name || !taken(name)) return name;
  let number = 2;
  while (taken(`${name} ${number}`)) number++;
  return `${name} ${number}`;
}

/** The accounts an agent can be started on from here: connected, and the server says it can. */
function startableAccounts(office: Snapshot): Account[] {
  return office.accounts.filter(
    (item) => item.status === 'connected' && ACCOUNT_LABELS[item.kind] && item.canStart,
  );
}

/** Where the server's own refusals about the name belong: beside the Name field. */
const NAME_PROBLEM = /^(Give the agent a name|There is already an agent called)/;

function Form({ office, desk, project }: { office: Snapshot; desk?: number; project?: string }) {
  const set = useOfficeUi((state) => state.set);
  const scope = useOfficeUi((state) => state.project);
  const accounts = startableAccounts(office);
  // Connected accounts that can't start an agent here are named, so nobody wonders where they went.
  const elsewhere = office.accounts.filter(
    (item) => item.status === 'connected' && ACCOUNT_LABELS[item.kind] && !item.canStart,
  );
  const nameBox = useRef<HTMLInputElement>(null);
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
  // The project the office is showing, or none. Never another one: an agent filed under a
  // project nobody chose is lost in it. Opened from a project's own card, it is that project.
  const [projectId, setProjectId] = useState(
    project ?? (scope === 'all' || !office.projects.some((item) => item.id === scope) ? '' : scope),
  );
  const [lead, setLead] = useState('');
  const folderOf = (id: string) =>
    office.projects.find((item) => item.id === id)?.repository?.path ?? '';
  const [typed, setFolder] = useState('');
  // The folder follows the project until someone types or picks one themselves.
  const [folderChosen, setFolderChosen] = useState(false);
  const folder = folderChosen ? typed : folderOf(projectId) || DEFAULT_FOLDER;
  const [folderNote, setFolderNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    api
      .recentFolders()
      .then(setRecent)
      .catch(() => setRecent([]));
  }, []);
  /** Checks the folder on this computer, and says what's in it or what's wrong with it. */
  const checkFolder = (path: string, chosen: boolean) => {
    if (!path.trim()) {
      setFolderNote(null);
      return;
    }
    api
      .checkFolder(path.trim(), false)
      .then((check) => {
        if (check.error) {
          setFolderNote({ text: check.error, bad: true });
          return;
        }
        // A path typed or picked is tidied, as the server reads it.
        if (chosen) setFolder(check.path);
        setFolderNote({ text: check.hint || `Works in ${check.name}.`, bad: false });
      })
      .catch((failure: Error) => setFolderNote({ text: failure.message, bad: true }));
  };
  const browse = () =>
    api
      .pickFolder()
      .then(({ path }) => {
        setFolderChosen(true);
        setFolder(path);
        checkFolder(path, true);
      })
      .catch((failure: Error) => setFolderNote({ text: failure.message, bad: true }));
  const [error, setError] = useState('');
  // Shown beside the Name field, which is also given focus, so it is never out of sight.
  const [nameError, setNameError] = useState('');
  const close = () => set({ newAgent: null });
  const models = accounts.find((item) => item.kind === account)?.models ?? [];
  const leader = office.agents.find((agent) => agent.id === lead);
  // The default is looked up by the settings key, not the account kind, so Settings is obeyed.
  const preset = leader
    ? leader.subModel && leader.subModel !== 'inherit'
      ? leader.subModel
      : leader.model
    : defaultModel(office.settings, account) || (models[0] ?? '');
  const nameProblem = (message: string) => {
    setNameError(message);
    setError('');
    nameBox.current?.focus();
  };

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
      nameProblem('Give the agent a name.');
      return;
    }
    setNameError('');
    api
      .createAgent({
        name,
        account: account as AccountKind,
        model: model || preset,
        task,
        projectId,
        folder,
        dailyCostCap: Number(cap),
        allowedTools: tools,
        ...(lead ? { leadId: lead } : desk === undefined ? {} : { desk }),
      })
      .then(() => {
        close();
        window.location.hash = '#office';
      })
      .catch((failure: Error) => {
        if (NAME_PROBLEM.test(failure.message)) nameProblem(failure.message);
        else setError(failure.message);
      });
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
            ref={nameBox}
            autoFocus
            maxLength={20}
            placeholder="For example: Juniper"
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? 'naNameError' : undefined}
            style={nameError ? { borderColor: 'var(--red)' } : undefined}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setFilled({ ...filled, name: false });
              setNameError('');
            }}
          />
          {nameError ? (
            <span
              className="help"
              id="naNameError"
              role="alert"
              style={{ color: 'var(--red)', fontWeight: 700 }}
            >
              {nameError}
            </span>
          ) : null}
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
          {elsewhere.length ? (
            <span className="help" data-testid="startElsewhere">
              {elsewhere
                .map((item) =>
                  item.kind === 'claude_code'
                    ? 'Claude Code agents start in your terminal.'
                    : `${ACCOUNT_LABELS[item.kind]} can't start agents here yet.`,
                )
                .join(' ')}
            </span>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="naModel">Model</label>
          <select
            className="in"
            id="naModel"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value="">
              From {leader ? `${leader.name}'s ` : ''}agent settings ({preset})
            </option>
            {models.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
          <span className="help">Leave it on agent settings to use your default.</span>
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
          <span className="help">The agent pauses when it reaches this.</span>
        </div>
        <div className="field">
          <label htmlFor="naProj">Project</label>
          <select
            className="in"
            id="naProj"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">No project</option>
            {office.projects.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="naLead">Desk</label>
          <select
            className="in"
            id="naLead"
            value={lead}
            onChange={(event) => {
              setLead(event.target.value);
              setModel('');
            }}
          >
            <option value="">Its own desk</option>
            {leads.map((agent) => (
              <option value={agent.id} key={agent.id}>
                In {agent.name}&apos;s office, as a subagent
              </option>
            ))}
          </select>
          <span className="help">Subagents sit next to their lead and share its project.</span>
        </div>
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
        <span className="help">
          Shell commands and file changes outside the folder always ask for approval.
        </span>
      </div>
      <div className="field">
        <label htmlFor="naDir">Working folder</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="in mono"
            id="naDir"
            list="naRecentDirs"
            placeholder="~/code/my-project"
            value={folder}
            onChange={(event) => {
              setFolderChosen(true);
              setFolder(event.target.value);
              setFolderNote(null);
            }}
            onBlur={() => checkFolder(folder, folderChosen)}
          />
          <button type="button" className="btn" onClick={() => void browse()}>
            Browse…
          </button>
        </div>
        <datalist id="naRecentDirs">
          {recent.map((path) => (
            <option key={path} value={path} />
          ))}
        </datalist>
        <span
          className="help"
          role={folderNote?.bad ? 'alert' : undefined}
          style={folderNote?.bad ? { color: 'var(--red)', fontWeight: 700 } : undefined}
        >
          {folderNote?.text ??
            'A folder on this computer: pick it with Browse…, or type or paste its path.'}
        </span>
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
        <button type="submit" className="btn primary">
          Create agent
        </button>
      </div>
    </DialogFrame>
  );
}

/**
 * Shown instead of the form when no connected account can start an agent from here, so nobody
 * fills in a form that can't succeed. It says what to do instead, with the command.
 */
function CannotStart({ office }: { office: Snapshot }) {
  const set = useOfficeUi((state) => state.set);
  const close = () => set({ newAgent: null });
  const connected = office.accounts.filter(
    (item) => item.status === 'connected' && item.kind !== 'hub',
  );
  const claude = connected.find((item) => item.kind === 'claude_code');
  const others = connected.filter((item) => item.kind !== 'claude_code');
  return (
    <DialogFrame
      id="naTitle"
      wide
      titleSize={22}
      title={<>Create a new agent</>}
      help={
        connected.length
          ? "Mabari can't start an agent on the accounts you have connected. Here is what to do instead."
          : 'An agent needs an account to run on.'
      }
      close={close}
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="cantstart" data-testid="cantStart">
        {connected.length ? null : (
          <div className="banner amber">
            <Icon>
              <path d="M12 8v5M12 16h.01" />
            </Icon>
            <span className="grow">
              Connect an account first: sign in with ChatGPT or attach Claude Code.
            </span>
          </div>
        )}
        {claude ? (
          <div className="card">
            <h3>Claude Code agents start in your terminal</h3>
            <p className="help">
              Run this in the agent&apos;s folder. The session takes the next free desk.
            </p>
            <div className="codebox" data-testid="startCommand">
              <span className="ctx">claude</span>
            </div>
            <p className="help">
              Want a named, reusable agent? Make one in the agent builder, then start it from the
              free desk on the office floor.
            </p>
            <div>
              <a className="btn sm" href="#builder" onClick={close}>
                Open the agent builder
              </a>
            </div>
          </div>
        ) : null}
        {others.map((item) => (
          <div className="card" key={item.kind}>
            <h3>{ACCOUNT_LABELS[item.kind] ?? item.kind}</h3>
            <p className="help">{item.startNote}</p>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={close}>
          Close
        </button>
        <a className="btn primary" href="#accounts" onClick={close}>
          Go to Accounts
        </a>
      </div>
    </DialogFrame>
  );
}

/** Opened from anywhere: the header, a Projects card, an empty desk or Vee. */
export function NewAgentDialog() {
  const office = useOfficeStore((state) => state.office);
  const request = useOfficeUi((state) => state.newAgent);
  if (!office || !request) return null;
  if (!startableAccounts(office).length) return <CannotStart office={office} />;
  return <Form office={office} {...request} />;
}
