// SPDX-License-Identifier: Apache-2.0
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { api, type FolderCheck, type ProjectPlan, type ProjectStart } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import { clockText, minsText } from '../format.ts';
import type { AccountKind } from '../gen/models.ts';
import { listen, type Listener } from '../office/speech.ts';
import { useOfficeUi } from '../office/uiStore.ts';
import { Icon } from '../shell/Icon.tsx';
import { useEscape } from '../shell/useEscape.ts';

const EXAMPLES = [
  'I need a landing page for our coffee shop with online ordering, and tests so checkout never breaks',
  'Research three competitors and write a short report on their pricing',
  'Build an internal dashboard that shows weekly sales by region',
];

const ACCOUNT_LABEL: Record<string, string> = {
  claude_code: 'Claude Code on this computer',
  codex: 'ChatGPT (Codex)',
  anthropic_key: 'your Anthropic API key',
  openai_key: 'your OpenAI API key',
};

/** Files read as text, as the prototype does: small text files only. */
const TEXT_FILE = /^(md|txt|json|ya?ml|toml|csv|js|ts|py|html|css)$/;
const MAX_READ_BYTES = 400_000;
const MAX_TEXT = 20_000;
const MAX_FILES = 10;
const INSTRUCTION_FILE = /claude\.md|agents\.md|instruction|brief|guideline|readme/i;

interface Message {
  who: 'you' | 'planner';
  text: string;
  examples?: boolean;
  plan?: boolean;
}

interface Attached {
  id: string;
  name: string;
  size: number;
  text: string | null;
  reading: boolean;
  instr: boolean;
}

interface Repo {
  name: string;
  src: string;
  branch: string;
  check: FolderCheck;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

const FIRST: Message = {
  who: 'planner',
  text: 'What should the team work on? Describe the goal in your own words, or pick an example.',
  examples: true,
};

let nextFile = 1;

/** The New project chat: describe it, attach files or a repository, and the planner makes a team. */
export function NewProjectDialog() {
  const open = useOfficeUi((state) => state.newProject);
  if (!open) return null;
  return <Brief />;
}

function Brief() {
  const office = useOfficeStore((state) => state.office);
  const toast = useOfficeStore((state) => state.toast);
  const set = useOfficeUi((state) => state.set);
  const [messages, setMessages] = useState<Message[]>([FIRST]);
  const [plan, setPlan] = useState<ProjectPlan | null>(null);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Attached[]>([]);
  const [instructions, setInstructions] = useState('');
  const [instrFrom, setInstrFrom] = useState<string | null>(null);
  const [repo, setRepo] = useState<Repo | null>(null);
  const [repoReading, setRepoReading] = useState(false);
  const [repoSrc, setRepoSrc] = useState('');
  const [branch, setBranch] = useState('');
  const [repoHint, setRepoHint] = useState<{ text: string; bad: boolean } | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [mode, setMode] = useState<'plan' | 'go'>('plan');
  const [menu, setMenu] = useState(false);
  const [drag, setDrag] = useState(false);
  const [starting, setStarting] = useState(false);
  const [name, setName] = useState('');
  // The time the dialog opened, for the finish time. Reading the clock while drawing isn't allowed.
  const [openedAt] = useState(() => Date.now());
  const chat = useRef<HTMLDivElement>(null);
  const textBox = useRef<HTMLTextAreaElement>(null);
  const instrBox = useRef<HTMLTextAreaElement>(null);
  const repoBox = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const close = () => set({ newProject: false });
  // Hold the mic to dictate the brief. It only fills the box: nothing starts until Send, and no
  // project starts until Start project is pressed.
  const [dictating, setDictating] = useState(false);
  const dictation = useRef<Listener | null>(null);
  const stopDictating = () => {
    dictation.current?.stop();
    dictation.current = null;
    setDictating(false);
  };
  const startDictating = () => {
    if (dictation.current) return;
    const before = text ? `${text} ` : '';
    setDictating(true);
    dictation.current = listen(
      {
        onText: (heard) => setText(before + heard),
        onError: (message) => {
          toast(message);
          dictation.current = null;
          setDictating(false);
        },
        onEnd: () => {
          dictation.current = null;
          setDictating(false);
        },
      },
      useOfficeStore.getState().office?.settings.voiceEngine,
    );
  };
  useEffect(() => {
    window.addEventListener('pointerup', stopDictating);
    return () => window.removeEventListener('pointerup', stopDictating);
  });
  useEffect(() => () => dictation.current?.abort(), []);
  useEscape(close);

  useEffect(() => {
    textBox.current?.focus();
    api
      .recentFolders()
      .then(setRecent)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (chat.current) chat.current.scrollTop = chat.current.scrollHeight;
  }, [messages, typing]);

  const fail = (error: unknown) => toast(error instanceof Error ? error.message : 'Try again');

  const send = (raw: string) => {
    let said = raw.trim();
    if (!said) {
      if (files.length || repo || instructions.trim())
        said = 'Set up a project from what I attached.';
      else return;
    }
    const next = [...messages, { who: 'you' as const, text: said }];
    setMessages(next);
    setTyping(true);
    api
      .plan({
        said: next.filter((m) => m.who === 'you').map((m) => m.text),
        previous: plan,
        instructions,
        files: files.map((f) => ({ name: f.name, text: f.text ?? '' })),
        repo: repo
          ? {
              name: repo.name,
              lang: repo.check.scan?.lang ?? 'Mixed',
              files: repo.check.scan?.count ?? 0,
            }
          : null,
      })
      .then((answer) => {
        setPlan(answer.plan);
        setName(answer.plan.name);
        setMessages((current) => [...current, { who: 'planner', text: answer.reply, plan: true }]);
      })
      .catch(fail)
      .finally(() => setTyping(false));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    send(text);
    setText('');
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send(text);
      setText('');
    }
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const added = Array.from(list).slice(0, Math.max(0, MAX_FILES - files.length));
    if (added.length < list.length) toast(`Attach at most ${MAX_FILES} files.`);
    for (const file of added) {
      const ext = (file.name.split('.').pop() ?? '').toLowerCase();
      const entry: Attached = {
        id: `f${nextFile++}`,
        name: file.name,
        size: file.size,
        text: null,
        reading: false,
        instr: false,
      };
      const texty = TEXT_FILE.test(ext) || file.type.startsWith('text/');
      if (texty && file.size < MAX_READ_BYTES) {
        entry.reading = true;
        file
          .text()
          .then((body) => {
            const read = body.slice(0, MAX_TEXT);
            const asInstructions =
              INSTRUCTION_FILE.test(file.name) && !instrBox.current?.value.trim();
            if (asInstructions) {
              setInstructions(read.slice(0, 4000));
              setInstrFrom(file.name);
              toast(`Using ${file.name} as the project instructions`);
            }
            setFiles((current) =>
              current.map((f) =>
                f.id === entry.id ? { ...f, text: read, reading: false, instr: asInstructions } : f,
              ),
            );
          })
          .catch(() =>
            setFiles((current) =>
              current.map((f) => (f.id === entry.id ? { ...f, reading: false } : f)),
            ),
          );
      }
      setFiles((current) => [...current, entry]);
    }
  };
  const removeFile = (id: string) => {
    setFiles((current) =>
      current.filter((f) => {
        if (f.id === id && f.instr) setInstrFrom(null);
        return f.id !== id;
      }),
    );
  };

  const browse = () =>
    api
      .pickFolder()
      .then(({ path }) => setRepoSrc(path))
      .catch(fail);
  const attachRepo = () => {
    if (!repoSrc.trim()) {
      toast('Choose a folder or paste a path or Git URL');
      repoBox.current?.focus();
      return;
    }
    setRepoReading(true);
    api
      .checkFolder(repoSrc, true)
      .then((check) => {
        if (check.error) {
          setRepoHint({ text: check.error, bad: true });
          return;
        }
        setRepoSrc(check.path);
        setRepo({ name: check.name, src: check.path, branch: branch.trim() || 'main', check });
        setRepoHint(null);
        toast(`Attached ${check.name}`);
      })
      .catch(fail)
      .finally(() => setRepoReading(false));
  };

  const toggle = (index: number) => {
    if (!plan) return;
    const members = plan.members.map((member, i) =>
      i === index ? { ...member, on: !member.on } : member,
    );
    const changed = { ...plan, members };
    setPlan(changed);
    api
      .estimatePlan(changed)
      .then(({ minutes }) => setPlan((current) => (current ? { ...current, minutes } : current)))
      .catch(fail);
  };

  const accounts = office?.accounts ?? [];
  const ready = (kind: AccountKind) =>
    kind === 'claude_code' || accounts.some((a) => a.kind === kind && a.status === 'connected');

  const start = () => {
    if (!plan) return;
    if (!name.trim()) {
      toast('Give the project a name.');
      return;
    }
    setStarting(true);
    const body: ProjectStart = {
      plan,
      name: name.trim(),
      instructions,
      files: files.map((f) => f.name),
      folder: repo?.src ?? '',
      branch: repo?.check.url ? repo.branch : '',
      mode,
      brief: messages
        .filter((m) => m.who === 'you')
        .map((m) => m.text)
        .join(' '),
    };
    api
      .startProject(body)
      .then((started) => {
        set({ newProject: false, project: started.project.id, team: null });
        window.location.hash = '#office';
        if (started.notice) toast(started.notice);
      })
      .catch(fail)
      .finally(() => setStarting(false));
  };

  const lastPlan = messages.reduce((last, m, i) => (m.plan ? i : last), -1);
  const on = plan?.members.filter((m) => m.on).length ?? 0;

  const planCard = (live: boolean) => {
    if (!plan) return null;
    if (!live) {
      return (
        <span className="help">
          Plan: {plan.name}, led by {plan.leadName} with {on} subagent{on === 1 ? '' : 's'}.
        </span>
      );
    }
    const isReady = ready(plan.account);
    const label = ACCOUNT_LABEL[plan.account] ?? plan.account;
    return (
      <div className="plancard" style={{ ['--ac' as string]: plan.color }}>
        <div className="field">
          <label htmlFor="bpName">Project name</label>
          <input
            className="in"
            id="bpName"
            value={name}
            maxLength={28}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="prow" style={{ cursor: 'default', ['--ac' as string]: plan.color }}>
          <span className="idot" style={{ marginTop: 5 }} />
          <div>
            <b>{plan.leadName}</b> · Team lead ·{' '}
            <span className="mono" style={{ fontSize: 12 }}>
              {plan.leadModel}
            </span>
            <div className="help">{plan.leadTask}</div>
            <div className="help">About 10 min to plan, then it reviews the work</div>
          </div>
        </div>
        {plan.members.map((member, index) => (
          <label className="prow" key={member.role}>
            <input type="checkbox" checked={member.on} onChange={() => toggle(index)} />
            <div>
              <b>{member.name}</b> · {member.label}{' '}
              <span className="help">in {plan.leadName}&apos;s office</span>
              <div className="help">{member.task}</div>
              <div className="help">
                Model from {plan.leadName}&apos;s settings:{' '}
                <span className="mono">{plan.subModel}</span> · estimated {member.minutes} min
              </div>
            </div>
          </label>
        ))}
        <p className="help">
          Runs on {label}
          {plan.account === 'claude_code'
            ? '. Each Claude Code session joins this project when it starts in its folder.'
            : '.'}{' '}
          Say “use Codex” or “use Claude” to switch.
        </p>
        {isReady ? null : (
          <div className="banner amber" style={{ padding: '10px 12px' }}>
            <span className="grow">Connect {label} first.</span>
            <a className="btn sm" href="#accounts" onClick={close}>
              Accounts
            </a>
          </div>
        )}
        <div className="eta" style={{ padding: '10px 12px' }}>
          <b>Estimated time to completion: about {minsText(plan.minutes * 60)}</b>
          <span className="help">
            Done around {clockText(openedAt + plan.minutes * 60_000)} if you start now. Subagents
            work at the same time, so the longest task sets the pace.
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn primary"
            disabled={!isReady || starting}
            onClick={start}
          >
            Start project with {on + 1} agent{on ? 's' : ''}
          </button>
        </div>
      </div>
    );
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDrag(false);
    addFiles(event.dataTransfer.files);
  };

  return (
    <div className="scrim">
      <div
        className={drag ? 'dialog brief drag' : 'dialog brief'}
        id="briefDlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="brTitle"
        onDragOver={(event) => {
          event.preventDefault();
          setDrag(true);
        }}
        onDragLeave={(event) => {
          if (event.target === event.currentTarget) setDrag(false);
        }}
        onDrop={onDrop}
      >
        <div className="dhd">
          <div>
            <h2 id="brTitle" style={{ fontSize: 20 }}>
              New project
            </h2>
            <p className="help" style={{ marginTop: 2 }}>
              Describe what you need, attach files or a repository, and the planner puts a team
              together.
            </p>
          </div>
          <button type="button" className="btn ghost sm" aria-label="Close" onClick={close}>
            <Icon>
              <path d="M6 6l12 12M18 6 6 18" />
            </Icon>
          </button>
        </div>
        <div className="briefgrid">
          <div className="briefmain">
            <div className="briefchat" id="briefChat" aria-live="polite" ref={chat}>
              {messages.map((message, index) =>
                message.who === 'you' ? (
                  <div className="bmsg you" key={index}>
                    <div className="bb">{message.text}</div>
                  </div>
                ) : (
                  <div className="bmsg" key={index}>
                    <span className="bav">
                      <Icon>
                        <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
                      </Icon>
                    </span>
                    <div className="bb">
                      <b>Planner</b>
                      <div>{message.text}</div>
                      {message.examples ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {EXAMPLES.map((example) => (
                            <button
                              type="button"
                              className="qex"
                              key={example}
                              onClick={() => send(example)}
                            >
                              {example}
                            </button>
                          ))}
                        </div>
                      ) : null}
                      {message.plan ? planCard(index === lastPlan) : null}
                    </div>
                  </div>
                ),
              )}
              {typing ? (
                <div className="bmsg">
                  <span className="bav">
                    <Icon>
                      <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
                    </Icon>
                  </span>
                  <div className="bb">
                    <b>Planner</b>
                    <span className="typing">
                      <span />
                      <span />
                      <span />
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
            <form id="briefForm" className="composer" autoComplete="off" onSubmit={submit}>
              {files.length || repo ? (
                <div className="chips" id="briefChips">
                  {files.map((file) => (
                    <span className="achip" key={file.id}>
                      {file.name}
                      <button
                        type="button"
                        aria-label={`Remove ${file.name}`}
                        onClick={() => removeFile(file.id)}
                      >
                        <Icon>
                          <path d="M6 6l12 12M18 6 6 18" />
                        </Icon>
                      </button>
                    </span>
                  ))}
                  {repo ? (
                    <span className="achip">
                      {repo.name} · {repo.branch}
                      <button
                        type="button"
                        aria-label="Remove repository"
                        onClick={() => setRepo(null)}
                      >
                        <Icon>
                          <path d="M6 6l12 12M18 6 6 18" />
                        </Icon>
                      </button>
                    </span>
                  ) : null}
                </div>
              ) : null}
              <label className="sr" htmlFor="briefText">
                Describe the project
              </label>
              <textarea
                id="briefText"
                ref={textBox}
                rows={2}
                placeholder="Describe what you want built. Use + to attach files or a repository."
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={onKey}
              />
              <div className="comprow">
                <div className="ddwrap" id="attachWrap">
                  <button
                    type="button"
                    className="ibtn"
                    aria-label="Attach files or a repository"
                    title="Attach"
                    aria-expanded={menu}
                    onClick={() => setMenu(!menu)}
                  >
                    <Icon>
                      <path d="M12 5v14M5 12h14" />
                    </Icon>
                  </button>
                  <div className="menu up" id="attachMenu" role="menu" hidden={!menu}>
                    <button
                      type="button"
                      className="mi"
                      role="menuitem"
                      onClick={() => {
                        setMenu(false);
                        fileInput.current?.click();
                      }}
                    >
                      Upload files
                    </button>
                    <button
                      type="button"
                      className="mi"
                      role="menuitem"
                      onClick={() => {
                        setMenu(false);
                        if (repo) toast('A repository is already attached');
                        else repoBox.current?.focus();
                      }}
                    >
                      Attach a repository
                    </button>
                    <button
                      type="button"
                      className="mi"
                      role="menuitem"
                      onClick={() => {
                        setMenu(false);
                        instrBox.current?.focus();
                      }}
                    >
                      Write project instructions
                    </button>
                  </div>
                </div>
                <div className="seg" id="briefModeSeg" role="group" aria-label="How to start">
                  <button
                    type="button"
                    className={mode === 'plan' ? 'on' : ''}
                    aria-pressed={mode === 'plan'}
                    title="The lead shows you a plan and waits for your OK"
                    onClick={() => setMode('plan')}
                  >
                    Plan first
                  </button>
                  <button
                    type="button"
                    className={mode === 'go' ? 'on' : ''}
                    aria-pressed={mode === 'go'}
                    title="The team starts as soon as the project is created"
                    onClick={() => setMode('go')}
                  >
                    Start right away
                  </button>
                </div>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  className={dictating ? 'mic on' : 'mic'}
                  id="briefMic"
                  aria-label="Hold to speak"
                  aria-pressed={dictating}
                  style={{ width: 40, height: 40 }}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    startDictating();
                  }}
                >
                  <Icon>
                    <rect x="9" y="3" width="6" height="11" rx="3" />
                    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                  </Icon>
                </button>
                <button type="submit" className="btn primary" style={{ minHeight: 40 }}>
                  Send
                </button>
              </div>
            </form>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <span className="help" id="briefHint">
                Enter sends. Shift and Enter adds a line. Drop files anywhere in this window.
              </span>
            </div>
          </div>
          <aside className="briefside" aria-label="Project setup">
            <h3 style={{ fontSize: 15 }}>Project setup</h3>
            <div className="field">
              <label htmlFor="bInstr">Instructions</label>
              <textarea
                className="in"
                id="bInstr"
                ref={instrBox}
                rows={6}
                placeholder="How the team should work: rules, style, what done looks like."
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
              />
              <span className="help" id="bInstrNote">
                {instrFrom
                  ? `Taken from ${instrFrom}. Edit it if you like. Agents read this before every task.`
                  : 'Agents read this before every task, like a CLAUDE.md file.'}
              </span>
            </div>
            <div className="field">
              <span className="flabel">Files</span>
              <div id="bFiles" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {files.length ? (
                  files.map((file) => (
                    <div className="frow" key={file.id}>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <b>{file.name}</b>{' '}
                        <span className="help">
                          {size(file.size)}
                          {file.reading ? ' · reading…' : file.text ? ' · read' : ' · attached'}
                        </span>
                      </span>
                      {file.instr ? <span className="chip accent">Instructions</span> : null}
                      <button
                        type="button"
                        className="btn ghost sm"
                        aria-label={`Remove ${file.name}`}
                        onClick={() => removeFile(file.id)}
                      >
                        <Icon>
                          <path d="M6 6l12 12M18 6 6 18" />
                        </Icon>
                      </button>
                    </div>
                  ))
                ) : (
                  <p className="help">
                    Specs, briefs, designs or a CLAUDE.md. Drop files anywhere in this window.
                  </p>
                )}
              </div>
              <button
                type="button"
                className="btn sm"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => fileInput.current?.click()}
              >
                Upload files
              </button>
            </div>
            <div className="field">
              <span className="flabel">Repository or working folder</span>
              <div id="bRepo">
                {repoReading ? (
                  <div className="frow">Reading the repository…</div>
                ) : repo ? (
                  <div className="repocard">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <b style={{ flex: 1 }}>{repo.name}</b>
                      <span className="chip">{repo.branch}</span>
                    </div>
                    <span className="help mono" style={{ wordBreak: 'break-all' }}>
                      {repo.src}
                    </span>
                    {repo.check.scan ? (
                      <span className="help">
                        {repo.check.scan.count} files · {repo.check.scan.lang} ·{' '}
                        {repo.check.scan.manifest} · tests with {repo.check.scan.tests}
                        {repo.check.scan.instructionsFrom
                          ? ` · has ${repo.check.scan.instructionsFrom}`
                          : ''}
                      </span>
                    ) : null}
                    <span className="help">
                      Working folder:{' '}
                      <span className="mono">
                        {repo.check.url ? `~/code/${repo.name}` : repo.src}
                      </span>
                      {repo.check.url ? ' (cloned when the project starts)' : ''}
                    </span>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {repo.check.scan?.instructions && !instructions.trim() ? (
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() => {
                            setInstructions(repo.check.scan?.instructions ?? '');
                            setInstrFrom(`${repo.check.scan?.instructionsFrom} in ${repo.name}`);
                          }}
                        >
                          Use its {repo.check.scan.instructionsFrom} as instructions
                        </button>
                      ) : null}
                      <button type="button" className="btn ghost sm" onClick={() => setRepo(null)}>
                        Remove
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <label className="sr" htmlFor="bRepoSrc">
                      Folder or Git URL
                    </label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        className="in mono"
                        id="bRepoSrc"
                        ref={repoBox}
                        list="recentDirs"
                        value={repoSrc}
                        placeholder="~/code/shop or https://github.com/you/shop"
                        spellCheck={false}
                        autoComplete="off"
                        style={{ fontSize: 12.5 }}
                        onChange={(event) => setRepoSrc(event.target.value)}
                      />
                      <button
                        type="button"
                        className="btn"
                        title="Choose a folder on this computer"
                        onClick={browse}
                      >
                        Browse…
                      </button>
                    </div>
                    <datalist id="recentDirs">
                      {recent.map((folder) => (
                        <option value={folder} key={folder} />
                      ))}
                    </datalist>
                    <span
                      className="help"
                      id="bRepoSrcHint"
                      style={repoHint?.bad ? { color: 'var(--red)' } : undefined}
                    >
                      {repoHint?.text ??
                        'Choose a folder on this computer, or type or paste its path. A Git URL works too.'}
                    </span>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <label className="sr" htmlFor="bRepoBranch">
                        Branch
                      </label>
                      <input
                        className="in mono"
                        id="bRepoBranch"
                        placeholder="Branch: main"
                        style={{ fontSize: 12.5 }}
                        value={branch}
                        onChange={(event) => setBranch(event.target.value)}
                      />
                      <button type="button" className="btn primary" onClick={attachRepo}>
                        Attach
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </aside>
        </div>
        <input
          type="file"
          id="bFileInput"
          ref={fileInput}
          multiple
          hidden
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
