// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { api } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import type { Approval, LiveAgent, Settings, Snapshot } from '../gen/models.ts';
import { leaveFullscreen } from '../office/fullscreen.ts';
import { useOfficeUi } from '../office/uiStore.ts';
import { Icon } from '../shell/Icon.tsx';
import { useEscape } from '../shell/useEscape.ts';

function Body({ approval }: { approval: Approval }) {
  const { detail, type } = approval;
  if (type === 'plan') {
    return (
      <ol className="planlist">
        {detail.steps?.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    );
  }
  if (type === 'command') return <div className="codebox">$ {detail.cmd}</div>;
  return (
    <div className="field">
      <span className="flabel mono">{detail.path}</span>
      <div className="codebox">
        {detail.lines?.map((line, index) => (
          <span className={line.kind} key={index}>
            {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '− ' : '  '}
            {line.text}
          </span>
        ))}
      </div>
    </div>
  );
}

export function ApprovalCard({ office }: { office: Snapshot }) {
  const reviewing = useOfficeUi((state) => state.reviewing);
  const set = useOfficeUi((state) => state.set);
  const agent = office.agents.find((item) => item.approval?.id === reviewing);

  // The card belongs to one approval. If that one is settled, it must not reopen on a later one.
  useEffect(() => {
    if (reviewing && !agent) set({ reviewing: null });
  }, [reviewing, agent, set]);

  const approval = agent?.approval;
  if (!agent || !approval) return null;

  return (
    <ApprovalDialog
      agent={agent}
      approval={approval}
      autoOn={office.settings.autoApprove.on}
      close={() => set({ reviewing: null })}
    />
  );
}

function ApprovalDialog(props: {
  agent: LiveAgent;
  approval: Approval;
  autoOn: boolean;
  close: () => void;
}) {
  const { agent, approval, autoOn, close } = props;
  useEscape(close);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    leaveFullscreen();
    dialog.current?.focus();
  }, []);

  const decide = (decision: 'allowed' | 'denied') => {
    close();
    api.decide(approval.id, decision).catch((error: Error) => {
      useOfficeStore.getState().toast(error.message);
    });
  };
  const risky = approval.riskLevel === 'high';
  return (
    <div className="scrim">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="apTitle"
        tabIndex={-1}
        ref={dialog}
      >
        <div className="dhd">
          <div
            className={`p-${agent.provider}`}
            style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
          >
            <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span className="chip red">
                <i />
                Approval needed
              </span>
              {risky ? (
                <span className="chip red">Risky</span>
              ) : (
                <span className="chip">Low risk</span>
              )}
            </span>
            <h2 id="apTitle" style={{ fontSize: 20 }}>
              {agent.name} {approval.title}
            </h2>
            <span className="meta">
              <span className="pdot" />
              {agent.model} · {agent.folder}
            </span>
          </div>
          <button type="button" className="btn ghost sm" aria-label="Close" onClick={close}>
            <Icon>
              <path d="M6 6l12 12M18 6 6 18" />
            </Icon>
          </button>
        </div>
        <Body approval={approval} />
        <p className="help">
          {approval.risk} {agent.name} is paused until you choose.
          {autoOn && risky ? ' Auto approve skips risky actions, so this one still needs you.' : ''}
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" className="btn" onClick={() => decide('denied')}>
            Deny
          </button>
          <button type="button" className="btn primary" onClick={() => decide('allowed')}>
            Allow once
          </button>
        </div>
      </div>
    </div>
  );
}

export function AutoApproveButton(props: { settings: Settings; extraStyle?: CSSProperties }) {
  const { on, scope } = props.settings.autoApprove;
  const set = useOfficeUi((state) => state.set);
  const toggle = () => {
    if (on) void api.autoApprove(false, scope, false);
    else set({ autoDialog: true });
  };
  return (
    <button
      type="button"
      className={on ? 'btn autoon' : 'btn'}
      style={props.extraStyle}
      aria-pressed={on}
      title={on ? 'Turn off auto approve' : 'Let agents continue without asking you'}
      onClick={toggle}
    >
      <Icon>
        <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
      </Icon>
      {!on
        ? 'Auto approve'
        : scope === 'all'
          ? 'Auto approve: everything'
          : 'Auto approve: low risk'}
    </button>
  );
}

export function AutoApproveDialog({ office }: { office: Snapshot }) {
  const open = useOfficeUi((state) => state.autoDialog);
  return open ? <AutoApproveForm office={office} /> : null;
}

function AutoApproveForm({ office }: { office: Snapshot }) {
  const set = useOfficeUi((state) => state.set);
  const [scope, setScope] = useState<'safe' | 'all'>('safe');
  const [acknowledged, setAcknowledged] = useState(false);
  const pending = office.agents.filter((agent) => agent.state === 'approval').length;
  const close = () => set({ autoDialog: false });
  useEscape(close);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (scope === 'all' && !acknowledged) return;
    api
      .autoApprove(true, scope, acknowledged)
      .then(close)
      .catch((error: Error) => useOfficeStore.getState().toast(error.message));
  };
  return (
    <div className="scrim">
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="autoTitle"
        onSubmit={submit}
      >
        <div className="dhd">
          <div>
            <h2 id="autoTitle" style={{ fontSize: 20 }}>
              Auto approve for all agents
            </h2>
            <p className="help" style={{ marginTop: 2 }}>
              Agents keep working without stopping to ask you. You can turn this off at any time.
            </p>
          </div>
          <button type="button" className="btn ghost sm" aria-label="Close" onClick={close}>
            <Icon>
              <path d="M6 6l12 12M18 6 6 18" />
            </Icon>
          </button>
        </div>
        <div className="field">
          <span className="flabel">What should be approved automatically?</span>
          <label className="radio">
            <input
              type="radio"
              name="autoScope"
              checked={scope === 'safe'}
              onChange={() => setScope('safe')}
            />
            <span>
              <b>Low risk actions only</b> <span className="chip">Recommended</span>
              <br />
              <span className="help">
                Installs, tests and code changes inside each agent&apos;s working folder. Deleting
                files, force pushes, database changes and production settings still wait for you.
              </span>
            </span>
          </label>
          <label className="radio">
            <input
              type="radio"
              name="autoScope"
              checked={scope === 'all'}
              onChange={() => setScope('all')}
            />
            <span>
              <b>Everything, including risky actions</b>
              <br />
              <span className="help">
                No agent will ask before deleting files, pushing code or changing databases.
              </span>
            </span>
          </label>
        </div>
        {scope === 'all' ? (
          <label className="banner red" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={acknowledged}
              style={{ width: 18, height: 18, accentColor: 'var(--red)' }}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span className="grow">
              I understand agents can delete files, push code and change databases without asking
              me.
            </span>
          </label>
        ) : null}
        {pending ? (
          <p className="help">
            {pending} approval{pending === 1 ? ' is' : 's are'} waiting now. Any that match will be
            approved as soon as you turn this on.
          </p>
        ) : null}
        <p className="help">
          Every auto-approval is recorded in the Activity log, and the floor shows a banner while
          this is on.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={scope === 'all' && !acknowledged}>
            Turn on auto approve
          </button>
        </div>
      </form>
    </div>
  );
}
