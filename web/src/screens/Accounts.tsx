// SPDX-License-Identifier: Apache-2.0
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../data/api.ts';
import type { Account, AccountKind, AccountStatus } from '../gen/models.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import { useOfficeUi } from '../office/uiStore.ts';
import { Icon } from '../shell/Icon.tsx';
import { DemoNote } from './DemoNote.tsx';
import { PageHead } from './parts.tsx';

/** How to install the Codex CLI: the npm package Mabari is tested with (docs/INTEGRATIONS.md). */
const CODEX_INSTALL = 'npm install -g @openai/codex';
// The guide lives in the repository, which a person running only the program doesn't have.
const HUB_API_GUIDE = 'https://github.com/SamsonIdowu/mabari/blob/main/docs/HUB_API.md';

function StatusChip({ status, demo }: { status: AccountStatus; demo?: boolean }) {
  // The demo's accounts only look connected. Say so, so nothing reads as a real sign in.
  if (demo) {
    return (
      <span className="chip accent" data-testid="demoChip">
        <i />
        Demo
      </span>
    );
  }
  switch (status) {
    case 'connected':
      return (
        <span className="chip ok">
          <i />
          Connected
        </span>
      );
    case 'connecting':
      return (
        <span className="chip accent">
          <i />
          Connecting
        </span>
      );
    case 'expired':
      return (
        <span className="chip red">
          <i />
          Sign in expired
        </span>
      );
    case 'stale':
      return (
        <span className="chip amber">
          <i />
          Hook not reporting
        </span>
      );
    default:
      return (
        <span className="chip">
          <i />
          Not connected
        </span>
      );
  }
}

function Models({ models }: { models: string[] }) {
  return (
    <div className="models">
      {models.map((model) => (
        <span className="model" key={model}>
          {model}
        </span>
      ))}
    </div>
  );
}

function ChatGptCard({ account }: { account: Account }) {
  const toast = useOfficeStore((state) => state.toast);
  // In the demo the sign in is pretend: the card acts as if no one is signed in, because no one is.
  const connected = account.status === 'connected' && !account.demo;
  const missing = account.missing === 'codex';
  const fail = (error: unknown) => toast(error instanceof Error ? error.message : 'Try again');
  // Codex runs its own ChatGPT sign in. Mabari only opens the page Codex gives it.
  const signIn = () =>
    api
      .codexLogin()
      .then(({ authUrl }) => window.open(authUrl, '_blank', 'noopener,noreferrer'))
      .catch(fail);
  return (
    <article className="card eqcard">
      <div className="acchead">
        <span
          className="accicon p-openai"
          style={{ background: 'var(--ok-soft)', color: 'var(--openai-ink)' }}
        >
          <Icon>
            <path d="M12 2a10 10 0 1 0 0 20a10 10 0 0 0 0-20zM8 12h8M12 8v8" />
          </Icon>
        </span>
        <div style={{ flex: 1 }}>
          <h2>Sign in with ChatGPT</h2>
          <p className="help">Uses your ChatGPT plan through Codex.</p>
        </div>
        <StatusChip status={account.status} demo={account.demo} />
      </div>
      <div className="scroll" tabIndex={0}>
        {missing ? (
          // Stays on the card, with the step to take, as the Whisper set-up does.
          <div className="banner amber" data-testid="codexMissing" style={{ padding: '10px 12px' }}>
            <Icon>
              <path d="M12 8v5M12 16h.01" />
            </Icon>
            <span className="grow">
              Needs the Codex CLI, which isn&apos;t installed. Install it with{' '}
              <code>{CODEX_INSTALL}</code>, then restart Mabari.
            </span>
          </div>
        ) : null}
        {account.demo ? (
          <p className="help" data-testid="demoAccount">
            Demo account: nobody is signed in. Sign in below to use your own ChatGPT plan.
          </p>
        ) : null}
        {connected && account.email ? (
          <div className="banner" style={{ padding: '10px 12px' }}>
            <Icon>
              <path d="M20 21a8 8 0 0 0-16 0M12 11a4 4 0 1 0 0-8a4 4 0 0 0 0 8z" />
            </Icon>
            <span className="grow">
              Signed in as <b>{account.email}</b>
            </span>
          </div>
        ) : null}
        <div className="field">
          <span className="flabel">Models this account gives you</span>
          <Models models={account.models} />
          {connected ? null : <span className="help">Available after you sign in.</span>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {connected ? (
          <button type="button" className="btn" onClick={() => api.codexLogout().catch(fail)}>
            Sign out
          </button>
        ) : (
          <button
            type="button"
            className="btn primary"
            disabled={account.status === 'connecting' || missing}
            title={missing ? 'Install the Codex CLI first' : undefined}
            onClick={signIn}
          >
            {missing
              ? 'Install the Codex CLI first'
              : account.status === 'connecting'
                ? 'Waiting for ChatGPT…'
                : account.status === 'expired'
                  ? 'Sign in again'
                  : 'Sign in with ChatGPT'}
          </button>
        )}
      </div>
    </article>
  );
}

const DIFF_MARK = { add: '+ ', del: '- ', ctx: '  ' } as const;

function ClaudeCard({ account }: { account: Account }) {
  const queryClient = useQueryClient();
  const toast = useOfficeStore((state) => state.toast);
  const plan = useQuery({ queryKey: ['claudePlan', account.status], queryFn: api.claudePlan });
  const [busy, setBusy] = useState(false);
  const [showCommand, setShowCommand] = useState(false);
  const command = useRef<HTMLDivElement>(null);
  // In the demo the connection is pretend: the card acts as if Claude Code weren't attached,
  // because nothing has been added to its settings.
  const connected = (account.status === 'connected' || account.status === 'stale') && !account.demo;
  const stale = account.status === 'stale';
  // Whether Mabari's hooks are in Claude Code's settings, as the server read the file just now.
  const hooksIn = Boolean(plan.data?.attached);
  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    work()
      .catch((error: unknown) => toast(error instanceof Error ? error.message : 'Try again'))
      .finally(() => {
        setBusy(false);
        void queryClient.invalidateQueries({ queryKey: ['claudePlan'] });
      });
  };
  const attach = () => run(api.connectClaude);
  const detach = () => run(api.disconnectClaude);
  const path = plan.data?.path ?? '~/.claude/settings.json';
  const backup = plan.data?.backup ?? path + '.mabari-backup';
  const outdated = hooksIn && Boolean(plan.data?.outdated);
  // The command is at the top of the card, so showing it brings it into view.
  useEffect(() => {
    if (showCommand) command.current?.scrollIntoView({ block: 'nearest' });
  }, [showCommand]);
  return (
    <article className="card eqcard">
      <div className="acchead">
        <span
          className="accicon"
          style={{ background: 'var(--amber-soft)', color: 'var(--claude-ink)' }}
        >
          <Icon>
            <path d="M4 17l6-6-6-6M12 19h8" />
          </Icon>
        </span>
        <div style={{ flex: 1 }}>
          <h2>Attach Claude Code</h2>
          <p className="help">Uses the Claude Code you are already signed in to.</p>
        </div>
        <StatusChip status={account.status} demo={account.demo} />
      </div>
      <div className="scroll" tabIndex={0}>
        {showCommand ? (
          // Above the change, so it is in view as soon as it is asked for, not 5000 px down.
          <div className="field" ref={command} data-testid="claudeCommand" role="status">
            <span className="flabel">Run this in your project folder</span>
            <div className="codebox">
              <span className="ctx">claude</span>
            </div>
            <p className="help">The session takes a desk as soon as it starts.</p>
          </div>
        ) : null}
        {account.demo ? (
          <p className="help" data-testid="demoAccount">
            Demo account: Claude Code is not attached. Nothing has been added to its settings.
          </p>
        ) : null}
        {hooksIn && !outdated ? (
          // Past tense: the change is made, so the lines to add are no longer shown.
          <p className="help" data-testid="hooksAdded">
            Mabari&apos;s hooks were added to <code>{path}</code>. The original is saved as{' '}
            <code>{backup}</code>. Detaching takes Mabari&apos;s lines out again and puts the
            original back.
          </p>
        ) : (
          <div className="field">
            {outdated ? (
              <p className="help" data-testid="hooksOutdated">
                Mabari&apos;s hooks are from an older version. Update them so you can answer
                Claude&apos;s questions here; until then Claude Code asks in its own window.
              </p>
            ) : null}
            <span className="flabel">
              {outdated ? 'These lines will change in ' : 'These lines will be added to '}
              <code>{path}</code>
            </span>
            {/* Focusable, because the change is long enough to scroll. */}
            <div
              className="codebox"
              data-testid="claudeDiff"
              tabIndex={0}
              role="region"
              aria-label="Lines added to Claude Code's settings"
            >
              {plan.isError ? (
                <span className="ctx">{plan.error.message}</span>
              ) : (
                (plan.data?.diff ?? []).map((line, index) => (
                  <span className={line.kind} key={index}>
                    {DIFF_MARK[line.kind as keyof typeof DIFF_MARK] ?? '  '}
                    {line.text}
                    {'\n'}
                  </span>
                ))
              )}
            </div>
            <p className="help">
              <Icon>
                <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
              </Icon>{' '}
              A backup is saved first, to <code>{backup}</code>. Detaching takes Mabari&apos;s lines
              out again.
            </p>
          </div>
        )}
        <div className="field">
          <span className="flabel">Models</span>
          <Models models={account.models} />
        </div>
        {stale ? (
          <div className="banner amber" style={{ padding: '10px 12px' }}>
            <Icon>
              <path d="M12 8v5M12 16h.01" />
            </Icon>
            <span className="grow">
              The hook stopped reporting. Claude Code may have been updated.
            </span>
          </div>
        ) : null}
        {account.status === 'connected' && !account.demo ? (
          <p className="help">Hook reporting. Mabari never sees your Claude sign-in.</p>
        ) : null}
        <DefaultAgent />
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {stale ? (
          <button type="button" className="btn primary" disabled={busy} onClick={attach}>
            Reattach the hook
          </button>
        ) : connected || hooksIn ? (
          <>
            {outdated ? (
              <button type="button" className="btn primary" disabled={busy} onClick={attach}>
                Update the hooks
              </button>
            ) : null}
            <button type="button" className="btn primary" onClick={() => setShowCommand(true)}>
              Start a Claude Code session
            </button>
            <button type="button" className="btn" disabled={busy} onClick={detach}>
              Detach and restore backup
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !plan.data}
              onClick={attach}
            >
              Attach Claude Code
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !plan.data}
              onClick={() => {
                attach();
                setShowCommand(true);
              }}
            >
              Attach and start a session
            </button>
          </>
        )}
      </div>
    </article>
  );
}

/**
 * Mabari as the agent every new Claude Code session runs as: with Mabari's instructions and its
 * map of the projects. Like attaching, it shows exactly what changes in settings.json, and
 * nothing changes until the button is pressed.
 */
function DefaultAgent() {
  const queryClient = useQueryClient();
  const toast = useOfficeStore((state) => state.toast);
  const plan = useQuery({ queryKey: ['defaultAgent'], queryFn: api.defaultAgentPlan });
  const [busy, setBusy] = useState(false);
  if (!plan.data) return null;
  const { on, other, path, diff, backup } = plan.data;
  const change = () => {
    setBusy(true);
    api
      .setDefaultAgent(!on)
      .catch((error: unknown) => toast(error instanceof Error ? error.message : 'Try again'))
      .finally(() => {
        setBusy(false);
        void queryClient.invalidateQueries({ queryKey: ['defaultAgent'] });
      });
  };
  return (
    <div className="field" data-testid="defaultAgent">
      <span className="flabel">Default agent</span>
      <p className="help">
        {on
          ? 'Mabari is the default agent: new Claude Code sessions run as Mabari, with its map of every project.'
          : other
            ? `New Claude Code sessions run as ${other} now. Make Mabari the default instead, so they run with its map of every project.`
            : 'Make Mabari the default agent, so new Claude Code sessions run as Mabari, with its map of every project.'}
      </p>
      <span className="flabel">
        {on ? 'This line will be taken out of' : 'This line will be set in'} <code>{path}</code>
      </span>
      <div
        className="codebox"
        tabIndex={0}
        role="region"
        aria-label="The change to Claude Code's settings"
      >
        {diff
          .filter((line) => line.kind !== 'ctx')
          .map((line, index) => (
            <span className={line.kind} key={index}>
              {DIFF_MARK[line.kind as keyof typeof DIFF_MARK] ?? '  '}
              {line.text}
              {'\n'}
            </span>
          ))}
      </div>
      <p className="help">
        A backup is saved first, to <code>{backup}</code>.
      </p>
      <div>
        <button
          type="button"
          className={on ? 'btn' : 'btn primary'}
          disabled={busy}
          onClick={change}
        >
          {on ? "Use Claude Code's own agent again" : 'Make Mabari the default agent'}
        </button>
      </div>
    </div>
  );
}

interface KeySpec {
  id: string;
  kind: AccountKind;
  title: string;
  /** Who the key is with, as the "not checked" line says it. */
  provider: string;
  placeholder: string;
  /** The shape the key must have, said before and after a paste that doesn't fit. */
  shape: string;
  /** What Mabari really does with the key. */
  note: string;
}

const KEYS: KeySpec[] = [
  {
    id: 'anthropic',
    kind: 'anthropic_key',
    title: 'Anthropic API key',
    provider: 'Anthropic',
    placeholder: 'sk-ant-…',
    shape: 'Starts with sk-ant- and has at least 20 more characters.',
    note: 'It writes fuller answers when you ask about an agent, if a Claude model answers queries in Settings.',
  },
  {
    id: 'openai',
    kind: 'openai_key',
    title: 'OpenAI API key',
    provider: 'OpenAI',
    placeholder: 'sk-…',
    shape: 'Starts with sk- and has at least 20 more characters.',
    note: 'Nothing uses this key yet.',
  },
];

/** A server message starts in lower case, as it can follow other words; on its own it is a sentence. */
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Said wherever a key is offered, because an agent can't run on one yet. */
const KEY_AGENTS_NOTE =
  "Agents can't run on an API key yet. Attach Claude Code or sign in with ChatGPT to run agents.";

function KeyCard({ spec, account }: { spec: KeySpec; account: Account | undefined }) {
  const toast = useOfficeStore((state) => state.toast);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  // Beside the field, where the paste was, and kept until the next try. A toast would be gone.
  const [error, setError] = useState('');
  const set = account?.status === 'connected';
  const run = (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError('');
    work()
      .then(() => {
        setValue('');
        toast(done);
      })
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? sentence(failure.message) : 'Try again'),
      )
      .finally(() => setBusy(false));
  };
  const hint = `key-${spec.id}-hint`;
  const problem = `key-${spec.id}-error`;
  return (
    <div className="card" style={{ padding: 18, background: 'var(--surface2)' }}>
      <div className="acchead" style={{ justifyContent: 'space-between' }}>
        <h3>{spec.title}</h3>
        <span className={set ? 'chip ok' : 'chip'}>
          <i />
          {set ? 'Saved' : 'Not set'}
        </span>
      </div>
      <form
        className="field"
        onSubmit={(event) => {
          event.preventDefault();
          run(() => api.saveKey(spec.kind, value.trim()), `${spec.title} saved`);
        }}
      >
        <label htmlFor={`key-${spec.id}`}>Key</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="in mono"
            type="password"
            id={`key-${spec.id}`}
            placeholder={set ? 'Saved. Paste a new key to replace it.' : spec.placeholder}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${problem} ${hint}` : hint}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setError('');
            }}
          />
          <button type="submit" className="btn" disabled={busy || !value.trim()}>
            Save
          </button>
          {set ? (
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => run(() => api.deleteKey(spec.kind), `${spec.title} removed`)}
            >
              Remove
            </button>
          ) : null}
        </div>
        {error ? (
          <span
            className="help"
            id={problem}
            role="alert"
            data-testid="keyError"
            style={{ color: 'var(--red)', fontWeight: 700 }}
          >
            {error}
          </span>
        ) : null}
        <span className="help" id={hint}>
          {spec.shape} Stored encrypted on this computer.
        </span>
        {set ? (
          <span className="help" data-testid="keyUnchecked">
            Saved, but not checked with {spec.provider}. A wrong key only fails when it is used.
          </span>
        ) : null}
      </form>
      <p className="help" data-testid="keyNote">
        {KEY_AGENTS_NOTE} {spec.note}
      </p>
      <div className="field">
        <span className="flabel">Models</span>
        <Models models={account?.models ?? []} />
      </div>
    </div>
  );
}

function ApiKeys({ accounts }: { accounts: Account[] }) {
  return (
    <details className="keys">
      <summary>
        <svg className="ico chev" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 6l6 6-6 6" />
        </svg>
        API keys (optional)
        <span className="help" style={{ fontWeight: 600, marginLeft: 6 }}>
          Use pay as you go keys instead of, or as well as, a plan.
        </span>
      </summary>
      <div className="keysbody">
        {KEYS.map((key) => (
          <KeyCard key={key.id} spec={key} account={accounts.find((a) => a.kind === key.kind)} />
        ))}
      </div>
    </details>
  );
}

function HubCard({ account }: { account: Account | undefined }) {
  const toast = useOfficeStore((state) => state.toast);
  const [token, setToken] = useState('');
  // Replacing or revoking a token that apps use cuts them off, so each asks first.
  const [asking, setAsking] = useState<'replace' | 'revoke' | null>(null);
  const connected = account?.status === 'connected';
  const fail = (error: unknown) => toast(error instanceof Error ? error.message : 'Try again');
  const make = () =>
    api
      .newHubToken()
      .then((made) => {
        setToken(made.token);
        if (connected) toast('New hub token made. The old one has stopped working.');
      })
      .catch(fail)
      .finally(() => setAsking(null));
  const revoke = () =>
    api
      .revokeHubToken()
      .then(() => {
        setToken('');
        toast('Hub token revoked. Apps that used it have stopped reporting.');
      })
      .catch(fail)
      .finally(() => setAsking(null));
  const copy = () =>
    void navigator.clipboard
      ?.writeText(token)
      .then(() => toast('Hub token copied'))
      .catch(() => toast('Copy it by hand: the browser refused the clipboard.'));
  return (
    <div className="card">
      <div className="acchead">
        <span
          className="accicon"
          style={{ background: 'var(--surface3)', color: 'var(--custom-ink)' }}
        >
          <Icon>
            <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
          </Icon>
        </span>
        <div style={{ flex: 1 }}>
          <h2>Hub token for custom apps</h2>
          <p className="help">
            Let your own scripts and agents report to the office. They show up in blue.
          </p>
        </div>
        <StatusChip status={account?.status ?? 'off'} />
      </div>
      {token ? (
        <div className="field">
          <span className="flabel">Copy it now. Mabari won&apos;t show it again.</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
            <div className="codebox" data-testid="hubToken" style={{ flex: 1, minWidth: 0 }}>
              <span className="ctx">{token}</span>
            </div>
            <button type="button" className="btn" onClick={copy}>
              Copy
            </button>
          </div>
          <span className="help">
            Send it as <code>Authorization: Bearer …</code> to <code>/hub/v1/events</code>.
          </span>
        </div>
      ) : null}
      {asking ? (
        <div className="banner amber" role="alert" data-testid="hubConfirm">
          <Icon>
            <path d="M12 8v5M12 16h.01" />
          </Icon>
          <span className="grow">
            {asking === 'replace'
              ? 'The current token stops working the moment you make a new one. Apps that use it have to be given the new one.'
              : 'Apps that use this token stop reporting right away. You can make a new token afterwards.'}
          </span>
          <button type="button" className="btn" onClick={() => setAsking(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn danger"
            onClick={() => void (asking === 'replace' ? make() : revoke())}
          >
            {asking === 'replace' ? 'Yes, replace it' : 'Yes, revoke it'}
          </button>
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn primary"
          onClick={() => (connected ? setAsking('replace') : void make())}
        >
          {connected ? 'Make a new token' : 'Generate a token'}
        </button>
        {connected ? (
          <button type="button" className="btn" onClick={() => setAsking('revoke')}>
            Revoke
          </button>
        ) : null}
        <span className="help">
          You can revoke it at any time. The{' '}
          <a
            href={HUB_API_GUIDE}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--fg)', textDecoration: 'underline' }}
          >
            hub API guide<span className="sr"> (opens on GitHub in a new tab)</span>
          </a>{' '}
          says what to send.
        </span>
      </div>
    </div>
  );
}

export function Accounts() {
  const office = useOfficeStore((state) => state.office);
  if (!office) return null;
  const account = (kind: AccountKind) => office.accounts.find((item) => item.kind === kind);
  const codex = account('codex');
  const claude = account('claude_code');

  return (
    <section data-screen="accounts">
      <div className="page">
        <PageHead
          title="Accounts"
          description="Connect the places your agents come from. Each connection shows its status and the models it gives you."
        >
          <button
            type="button"
            className="btn"
            onClick={() => useOfficeUi.getState().set({ newAgent: {} })}
          >
            New agent
          </button>
        </PageHead>
        <DemoNote office={office}>
          ChatGPT and Claude Code only look connected, so the demo&apos;s agents make sense. Nobody
          is signed in and nothing in Claude Code&apos;s settings has changed.
        </DemoNote>
        <div id="accBanner">
          {codex?.status === 'connected' && !codex.demo && office.agents.length === 0 ? (
            <div className="banner ok">
              <Icon>
                <path d="M5 12l5 5L20 7" />
              </Icon>
              <span className="grow">
                ChatGPT is connected. Your Codex sessions will appear in the office.
              </span>
              <a className="btn primary sm" href="#office">
                Go to the office
              </a>
            </div>
          ) : null}
          {codex?.status === 'expired' ? (
            <div className="banner red">
              <Icon>
                <path d="M12 8v5M12 16h.01" />
              </Icon>
              <span className="grow">
                Your ChatGPT sign in expired. Codex agents can&apos;t report until you sign in
                again.
              </span>
            </div>
          ) : null}
        </div>
        <div className="grid2">
          {codex ? <ChatGptCard account={codex} /> : null}
          {claude ? <ClaudeCard account={claude} /> : null}
        </div>
        <ApiKeys accounts={office.accounts} />
        <HubCard account={account('hub')} />
      </div>
    </section>
  );
}
