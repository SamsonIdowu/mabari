// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import { api } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import { openAgent } from '../office/uiStore.ts';
import { LATER } from './parts.tsx';

/** Shows Mori's error on the floor, loading the demo office first if Mori isn't there. */
async function seeMori() {
  const store = useOfficeStore.getState();
  let office = store.office;
  if (!office || office.firstRun || !office.agents.some((agent) => agent.name === 'Mori')) {
    await api.loadDemo();
    office = await api.snapshot();
    store.setSnapshot(office);
  }
  const mori = office.agents.find((agent) => agent.name === 'Mori');
  if (mori) openAgent(mori, office.agents);
}

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
        <p className="muted">Build one in the agent builder or in your terminal.</p>
        <a className="btn primary sm" href="#builder">
          Start an agent
        </a>
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
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            seeMori().catch((error: unknown) => {
              useOfficeStore.getState().toast(error instanceof Error ? error.message : 'Try again');
            });
          }}
        >
          See Mori on the floor
        </button>
      </>
    ),
  },
];

/** The six status screens, the Library's first tab. */
export function StatusGrid() {
  return (
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
  );
}
