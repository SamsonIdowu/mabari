// SPDX-License-Identifier: Apache-2.0
import { useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { api } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import { agoText } from '../format.ts';
import type { AgentDef, Project, Snapshot } from '../gen/models.ts';
import {
  mabariCreate,
  mabariImprove,
  running,
  useBuilder,
  type DefDialog,
} from '../office/builderStore.tsx';
import {
  blankDef,
  DEF_COLORS,
  DEF_MODELS,
  DEF_TOOLS,
  defMarkdown,
  defTitle,
  draftFrom,
  MABARI_ID,
  MABARI_SKILLS,
  modelLabel,
  slug,
} from '../office/defs.ts';
import { useVee } from '../office/veeStore.ts';
import { Icon } from '../shell/Icon.tsx';
import { MabariHead } from '../shell/MabariHead.tsx';
import { useEscape } from '../shell/useEscape.ts';

const toast = (text: string) => useOfficeStore.getState().toast(text);

function projectName(projects: Project[], id: string) {
  return projects.find((project) => project.id === id)?.name ?? id;
}

function projectColour(projects: Project[], id: string) {
  return projects.find((project) => project.id === id)?.color ?? 'var(--muted)';
}

function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={className ? `chip ${className}` : 'chip'}>{children}</span>;
}

function stop(action: () => void) {
  return (event: MouseEvent) => {
    event.stopPropagation();
    action();
  };
}

function MabariTile({ def, defs, open }: { def: AgentDef; defs: AgentDef[]; open: boolean }) {
  const set = useBuilder((state) => state.set);
  const others = defs.length - 1;
  return (
    <article
      className={open ? 'card defcard sys open' : 'card defcard sys'}
      aria-expanded={open}
      title={open ? 'Click to collapse' : 'Click to see details'}
      onClick={() => set({ open: open ? null : def.id })}
    >
      <div className="dchead">
        <span className="davatar sysav">
          <MabariHead />
        </span>
        <div className="dctitle">
          <b>Mabari</b>
          <span className="mono muted">mabari · built in</span>
        </div>
        <Chip className="ok">
          <i />
          Always on
        </Chip>
      </div>
      <p className="dcdesc">{def.description}</p>
      <div className="dcmeta">
        <Chip className="accent">
          <i />
          Account · every project
        </Chip>
        <Chip>Manager</Chip>
        <Chip>{modelLabel(def.model)}</Chip>
        <Chip>
          Manages {others} agent{others === 1 ? '' : 's'}
        </Chip>
      </div>
      <div className="dcskills">
        <span className="flabel">Skills</span>
        {MABARI_SKILLS.map((skill) => (
          <div className="dcskill" key={skill.name}>
            <b>{skill.title}</b> <span className="mono muted">{skill.name}</span>
            <p>{skill.desc}</p>
          </div>
        ))}
      </div>
      <p className="dcpath mono">{def.path}</p>
      <div className="dcact">
        <button
          type="button"
          className="btn sm"
          onClick={stop(() =>
            set({ dialog: { id: def.id, edit: { ...def }, by: '', note: null } }),
          )}
        >
          Edit instructions
        </button>
        <button type="button" className="btn sm" onClick={stop(() => mabariCreate(''))}>
          Build an agent with Mabari
        </button>
      </div>
      <p className="help">
        Dispatched {def.runs} task{def.runs === 1 ? '' : 's'} · cannot be deleted or turned off
      </p>
    </article>
  );
}

const POWER = 'M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0';

function Tile(props: {
  def: AgentDef;
  office: Snapshot;
  open: boolean;
  deleting: boolean;
  now: number;
}) {
  const { def, office, open, deleting, now } = props;
  const set = useBuilder((state) => state.set);
  const run = running(office.agents, def);
  const expanded = open || deleting;
  const act = async (work: () => Promise<unknown>, done?: string) => {
    try {
      await work();
      if (done) toast(done);
    } catch (error) {
      toast((error as Error).message);
    }
  };
  const duplicate = () =>
    act(
      () => api.saveDef({ ...def, name: slug(`${def.name}-copy`), id: '' }, ''),
      `Duplicated as ${slug(`${def.name}-copy`)}`,
    );
  const toggle = () =>
    act(
      () => api.enableDef(def.id, !def.enabled),
      def.enabled ? `${defTitle(def)} is off. Mabari won't run it.` : `${defTitle(def)} is on`,
    );
  const remove = () =>
    act(
      async () => {
        await api.deleteDef(def.id);
        set({ deleting: null, open: null });
      },
      `${defTitle(def)} deleted`,
    );
  const runIt = () =>
    act(async () => {
      const agent = await api.runDef(def.id);
      window.location.hash = '#office';
      toast(`${agent.name} is walking in, built from ${def.name}`);
    });
  return (
    <article
      className={`card defcard${def.enabled ? '' : ' off'}${expanded ? ' open' : ''}`}
      aria-expanded={expanded}
      title={open ? 'Click to collapse' : 'Click to see details'}
      onClick={() => set({ open: open ? null : def.id })}
    >
      <div className="dchead">
        <span className="davatar" style={{ ['--dc' as string]: def.color }}>
          {defTitle(def).charAt(0)}
        </span>
        <div className="dctitle">
          <b>{defTitle(def)}</b>
          <span className="mono muted">{def.name}</span>
        </div>
        {def.enabled ? (
          run.length ? (
            <Chip className="ok">
              <i />
              {run.length} running
            </Chip>
          ) : null
        ) : (
          <Chip>Off</Chip>
        )}
      </div>
      <p className="dcdesc">{def.description}</p>
      <div className="dcmeta">
        <Chip className={def.scope === 'account' ? 'accent' : ''}>
          {def.scope === 'account' ? (
            <i />
          ) : (
            <span
              className="pdot"
              style={{ background: projectColour(office.projects, def.projectId) }}
            />
          )}
          {def.scope === 'account'
            ? 'Account · every project'
            : `Project · ${projectName(office.projects, def.projectId)}`}
        </Chip>
        <Chip>{modelLabel(def.model)}</Chip>
        <Chip>
          {def.tools.length} tool{def.tools.length === 1 ? '' : 's'}
        </Chip>
      </div>
      <p className="dcpath mono">{def.path}</p>
      {deleting ? (
        <div
          className="banner red"
          style={{ padding: '8px 10px' }}
          onClick={(event) => event.stopPropagation()}
        >
          <span className="grow">Delete {def.name}? Its file is removed.</span>
          <button type="button" className="btn sm" onClick={() => set({ deleting: null })}>
            Keep
          </button>
          <button type="button" className="btn sm danger" onClick={() => void remove()}>
            Delete
          </button>
        </div>
      ) : (
        <div className="dcact">
          <button
            type="button"
            className="btn sm primary"
            disabled={!def.enabled}
            onClick={stop(() => void runIt())}
          >
            <Icon>
              <path d="M7 5l11 7-11 7z" />
            </Icon>
            Run
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={stop(() =>
              set({ dialog: { id: def.id, edit: { ...def }, by: '', note: null } }),
            )}
          >
            Edit
          </button>
          <button
            type="button"
            className="btn sm"
            title="Mabari reviews this agent and suggests better instructions"
            onClick={stop(() => mabariImprove(def.id))}
          >
            Improve
          </button>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="btn ghost sm"
            title="Duplicate"
            aria-label="Duplicate"
            onClick={stop(() => void duplicate())}
          >
            <Icon>
              <path d="M8 8h11v11H8zM5 16V5h11" />
            </Icon>
          </button>
          <button
            type="button"
            className="btn ghost sm"
            title={def.enabled ? 'Turn off' : 'Turn on'}
            aria-label={def.enabled ? 'Turn off' : 'Turn on'}
            onClick={stop(() => void toggle())}
          >
            <Icon>
              <path d={POWER} />
            </Icon>
          </button>
          <button
            type="button"
            className="btn ghost sm"
            title="Delete"
            aria-label="Delete"
            onClick={stop(() => set({ deleting: def.id, open: def.id }))}
          >
            <Icon>
              <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
            </Icon>
          </button>
        </div>
      )}
      <p className="help">
        {def.runs} run{def.runs === 1 ? '' : 's'} · updated {agoText(def.updated || now, now)}
      </p>
    </article>
  );
}

function Persist() {
  const reload = async () => {
    try {
      const report = await api.rescanDefs();
      const projectFolders = Object.values(report.projects ?? {}).filter(
        (count) => count > 0,
      ).length;
      const fromProjects = Object.values(report.projects ?? {}).reduce(
        (sum, count) => sum + count,
        0,
      );
      const total = report.account + fromProjects;
      toast(
        `Loaded ${total} agents: ${report.account} from ~/.claude/agents and ${fromProjects} from ${projectFolders} project folder${projectFolders === 1 ? '' : 's'}.`,
      );
    } catch (error) {
      toast((error as Error).message);
    }
  };
  return (
    <div className="persist">
      <Icon>
        <path d="M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6" />
      </Icon>
      <span>
        <b>Saved as files on this computer.</b> Agents load every time Mabari starts, survive
        restarts and reinstalls, and stay when you switch or disconnect accounts.
      </span>
      <button
        type="button"
        className="btn sm ghost"
        title="Read the agent folders again"
        onClick={() => void reload()}
      >
        Reload from disk
      </button>
    </div>
  );
}

export function Builder() {
  const office = useOfficeStore((state) => state.office);
  const { filter, query, open, deleting, dialog, set } = useBuilder();
  const [now] = useState(() => Date.now());
  if (!office) return null;
  const defs = office.defs ?? [];
  const q = query.toLowerCase();
  const shown = defs.filter(
    (def) =>
      (filter === 'all' ||
        (filter === 'account'
          ? def.scope === 'account'
          : def.scope === 'project' && def.projectId === filter)) &&
      (!q || `${def.name} ${def.description}`.toLowerCase().includes(q)),
  );
  const tabs: [string, string, number][] = [
    ['all', 'All', defs.length],
    ['account', 'Account', defs.filter((def) => def.scope === 'account').length],
    ...office.projects.map((project): [string, string, number] => [
      project.id,
      project.name,
      defs.filter((def) => def.scope === 'project' && def.projectId === project.id).length,
    ]),
  ];
  const projectFilter = filter !== 'all' && filter !== 'account' ? filter : '';
  const buildNew = () =>
    set({ dialog: { id: '', edit: blankDef(defs.length, projectFilter), by: '', note: null } });
  return (
    <section data-screen="builder">
      <div className="page" id="builderPage">
        <div className="phead">
          <div>
            <h1>Agent builder</h1>
          </div>
          <button type="button" className="btn primary" onClick={buildNew}>
            <Icon>
              <path d="M12 5v14M5 12h14" />
            </Icon>
            Build an agent
          </button>
        </div>
        <Persist />
        <div className="defbar">
          <div className="seg" role="group" aria-label="Scope">
            {tabs.map(([id, label, count]) => (
              <button
                type="button"
                key={id}
                className={filter === id ? 'on' : ''}
                aria-pressed={filter === id}
                onClick={() => set({ filter: id })}
              >
                {label} <span className="n num">{count}</span>
              </button>
            ))}
          </div>
          <label className="sr" htmlFor="defQ">
            Search agents
          </label>
          <input
            className="in"
            id="defQ"
            placeholder="Search agents"
            value={query}
            onChange={(event) => set({ query: event.target.value })}
          />
        </div>
        {shown.length ? (
          <div className="defgrid">
            {shown.map((def) =>
              def.system ? (
                <MabariTile key={def.id} def={def} defs={defs} open={open === def.id} />
              ) : (
                <Tile
                  key={def.id}
                  def={def}
                  office={office}
                  open={open === def.id}
                  deleting={deleting === def.id}
                  now={now}
                />
              ),
            )}
          </div>
        ) : (
          <div className="card defempty">
            <h2>{defs.length ? 'No agents match' : 'Build your first agent'}</h2>
            <p className="muted">
              Agents you build here are saved as files Claude Code reads. Account agents work in
              every project. Project agents live in that project&apos;s folder.
            </p>
            <button type="button" className="btn primary" onClick={buildNew}>
              Build an agent
            </button>
          </div>
        )}
      </div>
      {dialog ? <DefDialogView key={dialogKey(dialog)} dialog={dialog} office={office} /> : null}
    </section>
  );
}

const dialogKeys = new WeakMap<DefDialog, number>();
let nextDialog = 1;

/** A new dialog starts its form afresh, even for the same agent. */
function dialogKey(dialog: DefDialog) {
  if (!dialogKeys.has(dialog)) dialogKeys.set(dialog, nextDialog++);
  return dialogKeys.get(dialog)!;
}

function folderOf(projects: Project[], id: string) {
  return projects.find((project) => project.id === id)?.repository?.path ?? '';
}

function previewPath(edit: AgentDef, projects: Project[]) {
  const name = edit.name || 'name';
  if (edit.scope === 'account') return `~/.claude/agents/${name}.md`;
  const folder = folderOf(projects, edit.projectId);
  return folder ? `${folder}/.claude/agents/${name}.md` : 'This project has no folder yet';
}

export function DefDialogView({ dialog, office }: { dialog: DefDialog; office: Snapshot }) {
  const set = useBuilder((state) => state.set);
  const [edit, setEdit] = useState<AgentDef>(dialog.edit);
  const [ask, setAsk] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const close = () => set({ dialog: null });
  useEscape(close);
  const change = (patch: Partial<AgentDef>) => setEdit((current) => ({ ...current, ...patch }));
  const system = edit.id === MABARI_ID;
  const toggleTool = (tool: string, on: boolean) =>
    change({ tools: on ? [...edit.tools, tool] : edit.tools.filter((item) => item !== tool) });
  const draft = () => {
    if (!ask.trim()) return;
    const drafted = draftFrom(ask);
    change({
      name: drafted.name,
      description: drafted.description,
      instructions: drafted.instructions,
      tools: drafted.tools,
    });
  };
  const save = async (thenRun: boolean) => {
    setSaving(true);
    setError('');
    try {
      const saved = await api.saveDef({ ...edit, name: slug(edit.name) }, dialog.id, dialog.by);
      close();
      toast(`${defTitle(saved)} saved to ${saved.path}`);
      if (dialog.by === 'mabari') {
        useVee
          .getState()
          .post(
            dialog.id
              ? `Saved my improvements to ${saved.name}. It uses them from its next task.`
              : `Built ${saved.name}. I'll send it matching work from now on.`,
            'clap',
          );
      }
      if (thenRun) {
        const agent = await api.runDef(saved.id);
        window.location.hash = '#office';
        toast(`${agent.name} is walking in, built from ${saved.name}`);
      }
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save(false);
  };
  return (
    <div className="scrim">
      <form
        className="dialog defdlg"
        id="defForm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="defTitle"
        autoComplete="off"
        onSubmit={submit}
      >
        <div className="dhd">
          <div>
            <h2 id="defTitle" style={{ fontSize: 22 }}>
              {dialog.id ? 'Edit agent' : 'Build an agent'}
            </h2>
            <p className="help" style={{ marginTop: 2 }}>
              Saved as a file Claude Code reads, so the agent works here and in your terminal.
            </p>
            {dialog.note ? (
              <div className="mbnote">
                <span className="mbhead">
                  <MabariHead size={28} />
                </span>
                <div>{dialog.note}</div>
              </div>
            ) : null}
          </div>
          <button type="button" className="btn ghost sm" aria-label="Close" onClick={close}>
            <Icon>
              <path d="M6 6l12 12M18 6 6 18" />
            </Icon>
          </button>
        </div>
        <div className="defcols">
          <div className="defform">
            {dialog.id ? null : (
              <div className="field">
                <label htmlFor="dfAsk">Describe it and draft</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="in"
                    id="dfAsk"
                    placeholder="For example: review pull requests for security problems"
                    value={ask}
                    onChange={(event) => setAsk(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        draft();
                      }
                    }}
                  />
                  <button type="button" className="btn" onClick={draft}>
                    Draft
                  </button>
                </div>
              </div>
            )}
            <div className="grid2" style={{ gap: 14 }}>
              <div className="field">
                <label htmlFor="dfName">Name</label>
                <input
                  className="in mono"
                  id="dfName"
                  placeholder="code-reviewer"
                  maxLength={40}
                  readOnly={system}
                  value={edit.name}
                  onChange={(event) => change({ name: event.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="dfModel">Model</label>
                <select
                  className="in"
                  id="dfModel"
                  value={edit.model || 'inherit'}
                  onChange={(event) => change({ model: event.target.value })}
                >
                  {DEF_MODELS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="dfDesc">When should Claude use it?</label>
              <input
                className="in"
                id="dfDesc"
                placeholder="Use after any change to review it for bugs"
                value={edit.description}
                onChange={(event) => change({ description: event.target.value })}
              />
            </div>
            {system ? (
              <p className="help">
                <b>Mabari is built in.</b> You can change its instructions, model and tools. It
                always works across your whole Claude account.
              </p>
            ) : (
              <div className="field">
                <span className="flabel">Scope</span>
                <div className="scopepick">
                  {(
                    [
                      ['account', 'Claude account', 'Available in every project'],
                      ['project', 'One project', 'Saved in the project folder'],
                    ] as const
                  ).map(([scope, title, sub]) => (
                    <label
                      key={scope}
                      className={edit.scope === scope ? 'scopeopt on' : 'scopeopt'}
                    >
                      <input
                        type="radio"
                        name="dfScope"
                        value={scope}
                        checked={edit.scope === scope}
                        onChange={() =>
                          change({
                            scope,
                            projectId:
                              scope === 'project'
                                ? edit.projectId || office.projects[0]?.id || ''
                                : '',
                          })
                        }
                      />
                      <b>{title}</b>
                      <span>{sub}</span>
                    </label>
                  ))}
                </div>
                {edit.scope === 'project' ? (
                  <select
                    className="in"
                    id="dfProj"
                    aria-label="Project"
                    value={edit.projectId}
                    onChange={(event) => change({ projectId: event.target.value })}
                  >
                    {office.projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
            )}
            <div className="field">
              <span className="flabel">Tools</span>
              <div className="toolgrid">
                {DEF_TOOLS.map(([tool, label]) => (
                  <label key={tool}>
                    <input
                      type="checkbox"
                      name="dfTool"
                      value={tool}
                      checked={edit.tools.includes(tool)}
                      onChange={(event) => toggleTool(tool, event.target.checked)}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
            <div className="field">
              <label htmlFor="dfPrompt">Instructions</label>
              <textarea
                className="in"
                id="dfPrompt"
                rows={5}
                placeholder="You are…"
                value={edit.instructions}
                onChange={(event) => change({ instructions: event.target.value })}
              />
            </div>
            {system ? null : (
              <div className="field">
                <span className="flabel">Colour</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  {DEF_COLORS.map((colour) => (
                    <button
                      type="button"
                      key={colour}
                      className={edit.color === colour ? 'swatch on' : 'swatch'}
                      style={{ ['--sw' as string]: colour }}
                      aria-label={`Colour ${colour}`}
                      aria-pressed={edit.color === colour}
                      onClick={() => change({ color: colour })}
                    />
                  ))}
                </div>
              </div>
            )}
            {error ? (
              <p
                className="help"
                id="dfErr"
                role="alert"
                style={{ color: 'var(--red)', fontWeight: 700 }}
              >
                {error}
              </p>
            ) : null}
          </div>
          <div className="defprev">
            <span className="flabel">File</span>
            <code className="mono" id="dfPath">
              {previewPath(edit, office.projects)}
            </code>
            <pre className="codebox" id="dfMd" tabIndex={0} aria-label="The agent file">
              {defMarkdown({ ...edit, name: slug(edit.name) })}
            </pre>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          {dialog.id ? null : (
            <button type="button" className="btn" disabled={saving} onClick={() => void save(true)}>
              Save and run
            </button>
          )}
          <button type="submit" className="btn primary" disabled={saving}>
            {dialog.id ? 'Save changes' : 'Save agent'}
          </button>
        </div>
      </form>
    </div>
  );
}
