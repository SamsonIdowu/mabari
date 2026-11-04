// SPDX-License-Identifier: Apache-2.0
import type { Account, AccountKind, AccountStatus } from '../gen/models.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import { Icon } from '../shell/Icon.tsx';
import { LATER, PageHead } from './parts.tsx';

function StatusChip({ status }: { status: AccountStatus }) {
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
  const connected = account.status === 'connected';
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
        <StatusChip status={account.status} />
      </div>
      <div className="scroll">
        <p style={{ color: 'var(--fg2)' }}>
          A browser tab opens on ChatGPT so you can sign in there. Mabari never sees your password and
          only receives a token it stores on this computer.
        </p>
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
        <div className="field">
          <span className="flabel">What appears in the office</span>
          <p className="help">
            Every Codex session you start, from the terminal or from Mabari. Codex agents get
            instructions right away.
          </p>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className={connected ? 'btn' : 'btn primary'} disabled title={LATER}>
          {connected ? 'Sign out' : 'Sign in with ChatGPT'}
        </button>
      </div>
    </article>
  );
}

function ClaudeCard({ account }: { account: Account }) {
  const connected = account.status === 'connected';
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
        <StatusChip status={account.status} />
      </div>
      <div className="scroll">
        <p style={{ color: 'var(--fg2)' }}>
          Mabari adds a small hook to your Claude Code settings so each session reports what it is
          doing. Your Claude sign in stays where it is.
        </p>
        <div className="field">
          <span className="flabel">
            These lines will be added to <code>~/.claude/settings.json</code>
          </span>
          <div className="codebox">
            <span className="ctx">{'{'}</span>
            {'\n'}
            <span className="ctx">{'  "model": "claude-sonnet-4-5",'}</span>
            {'\n'}
            <span className="add">{'+ "hooks": {'}</span>
            <span className="add">
              {
                '+   "PreToolUse":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "mabari-hook pre" }] }],'
              }
            </span>
            <span className="add">
              {
                '+   "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "mabari-hook post" }] }],'
              }
            </span>
            <span className="add">
              {
                '+   "Stop":        [{ "hooks": [{ "type": "command", "command": "mabari-hook stop" }] }]'
              }
            </span>
            <span className="add">{'+ }'}</span>
            <span className="ctx">{'}'}</span>
          </div>
          <p className="help">
            <Icon>
              <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
            </Icon>{' '}
            A backup is saved first, to <code>~/.claude/settings.json.mabari-backup</code>. Detaching
            puts the backup back.
          </p>
        </div>
        <div className="field">
          <span className="flabel">Models</span>
          <Models models={account.models} />
        </div>
        {connected ? <p className="help">Hook reporting. Last event a moment ago.</p> : null}
        <p className="help">
          Claude Code picks up instructions at its next checkpoint, after the current step finishes.
        </p>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn primary" disabled title={LATER}>
          {connected ? 'Start a Claude Code session' : 'Attach Claude Code'}
        </button>
        <button type="button" className="btn" disabled title={LATER}>
          {connected ? 'Detach and restore backup' : 'Attach and start a session'}
        </button>
      </div>
    </article>
  );
}

const KEYS: { id: string; kind: AccountKind; title: string; placeholder: string; note: string }[] =
  [
    {
      id: 'anthropic',
      kind: 'anthropic_key',
      title: 'Anthropic API key',
      placeholder: 'sk-ant-…',
      note: 'Agents use orange, like other Claude agents.',
    },
    {
      id: 'openai',
      kind: 'openai_key',
      title: 'OpenAI API key',
      placeholder: 'sk-…',
      note: 'Agents use green, like other OpenAI agents.',
    },
  ];

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
          <div className="card" style={{ padding: 18, background: 'var(--surface2)' }} key={key.id}>
            <div className="acchead" style={{ justifyContent: 'space-between' }}>
              <h3>{key.title}</h3>
              <span className="chip">
                <i />
                Not set
              </span>
            </div>
            <div className="field">
              <label htmlFor={`key-${key.id}`}>Key</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="in mono"
                  type="password"
                  id={`key-${key.id}`}
                  placeholder={key.placeholder}
                  autoComplete="off"
                  disabled
                  title={LATER}
                />
                <button type="button" className="btn" disabled title={LATER}>
                  Save
                </button>
              </div>
              <span className="help">Stored encrypted on this computer. {key.note}</span>
            </div>
            <div className="field">
              <span className="flabel">Models</span>
              <Models models={accounts.find((a) => a.kind === key.kind)?.models ?? []} />
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

function HubCard() {
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
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn primary" disabled title={LATER}>
          Generate a token
        </button>
        <span className="help">You can revoke it at any time.</span>
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
          <button type="button" className="btn" disabled title={LATER}>
            Start an agent
          </button>
        </PageHead>
        {codex?.status === 'connected' && office.agents.length === 0 ? (
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
              Your ChatGPT sign in expired. Codex agents can&apos;t report until you sign in again.
            </span>
          </div>
        ) : null}
        <div className="grid2">
          {codex ? <ChatGptCard account={codex} /> : null}
          {claude ? <ClaudeCard account={claude} /> : null}
        </div>
        <ApiKeys accounts={office.accounts} />
        <HubCard />
      </div>
    </section>
  );
}
