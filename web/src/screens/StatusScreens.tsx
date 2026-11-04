// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import { LATER, PageHead } from './parts.tsx';

const showLive = (
  <button type="button" className="btn sm" disabled title={LATER}>
    Show it live
  </button>
);

const CARDS: { title: string; when: string; mock: ReactNode }[] = [
  {
    title: 'No accounts connected',
    when: 'Shown on the office floor before any account is connected.',
    mock: (
      <>
        <h3>No accounts connected</h3>
        <p className="muted">Connect an account and your agents take a desk.</p>
        <a className="btn primary sm" href="#accounts">
          Connect an account
        </a>
      </>
    ),
  },
  {
    title: 'Connected, no agents yet',
    when: 'An account is connected but no session is running.',
    mock: (
      <>
        <h3>No agents running yet</h3>
        <p className="muted">Start one here or in your terminal.</p>
        <button type="button" className="btn primary sm" disabled title={LATER}>
          New agent
        </button>
      </>
    ),
  },
  {
    title: 'Sign in expired',
    when: 'The ChatGPT token expired. Shown on Accounts and as a banner on the floor.',
    mock: (
      <>
        <span className="chip red">
          <i />
          Sign in expired
        </span>
        <p className="muted">Codex agents stopped reporting.</p>
        {showLive}
      </>
    ),
  },
  {
    title: 'Claude Code hook stopped',
    when: 'No hook event for a few minutes while sessions should be running.',
    mock: (
      <>
        <span className="chip amber">
          <i />
          Hook not reporting
        </span>
        <p className="muted">Claude agents may be out of date.</p>
        {showLive}
      </>
    ),
  },
  {
    title: 'Instruction waiting for a checkpoint',
    when: 'A message to a Claude Code agent that will be read when its current step ends.',
    mock: (
      <div className="queued" style={{ textAlign: 'left', width: '100%' }}>
        <b style={{ color: 'var(--amber)' }}>Waiting to deliver</b>
        <span>“Also add a changelog entry”</span>
        <span className="help">Delivered at Sage&apos;s next checkpoint.</span>
      </div>
    ),
  },
  {
    title: 'Agent error',
    when: "An agent hit a problem it can't solve alone. Grey cloud on the floor.",
    mock: (
      <>
        <span className="chip red">
          <i />
          Error
        </span>
        <p className="muted">Lost connection to the embedding service.</p>
        <a className="btn sm" href="#office">
          See Mori on the floor
        </a>
      </>
    ),
  },
];

export function StatusScreens() {
  return (
    <section data-screen="states">
      <div className="page">
        <PageHead
          title="Status screens"
          description="What people see when something is missing or wrong. Each one names the problem and the one action that fixes it."
        />
        <div className="grid3">
          {CARDS.map((card) => (
            <article className="card statecard" key={card.title}>
              <div>
                <h2>{card.title}</h2>
                <p className="help">{card.when}</p>
              </div>
              <div className="mock">{card.mock}</div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
