// SPDX-License-Identifier: Apache-2.0
import { memo, useState, type FormEvent } from 'react';
import { api } from '../data/api.ts';
import { chatApi, useSaved } from '../data/chatApi.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import { clockText } from '../format.ts';
import type { LiveAgent, ToolCallState } from '../gen/models.ts';
import { chatHash } from './chatRoute.ts';
import { ApprovalBody } from '../screens/Approvals.tsx';
import { Icon } from '../shell/Icon.tsx';
import { Modal } from '../shell/Modal.tsx';
import { useEscape } from '../shell/useEscape.ts';
import { copyText } from './copy.ts';
import { Markdown } from './Markdown.tsx';
import type { Row, RoundColumn, Who } from './threadModel.ts';

const toast = (text: string) => useOfficeStore.getState().toast(text);

const TOOL_WORDS: Record<ToolCallState, string> = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  denied: 'Denied',
};

function Dot({ who }: { who: Who }) {
  return <span className="idot" style={{ ['--ac' as string]: who.hue }} aria-hidden="true" />;
}

/** Who spoke and when. A link to their chat in a project's thread, where more than one agent speaks. */
function Byline({ who, time, showWho }: { who: Who; time: number; showWho: boolean }) {
  return (
    <div className="mby">
      <Dot who={who} />
      {showWho ? (
        <a className="mwho" href={chatHash.agent(who.id)}>
          {who.name}
        </a>
      ) : (
        <b className="mwho">{who.name}</b>
      )}
      <time className="num">{clockText(time)}</time>
    </div>
  );
}

function Chips({ parts }: { parts: Extract<Row, { kind: 'user' }>['parts'] }) {
  if (!parts.plan && !parts.files.length && !parts.context.length && !parts.handedFrom) return null;
  return (
    <div className="muchips">
      {parts.plan ? <span className="chip">Plan first</span> : null}
      {parts.handedFrom ? <span className="chip">Handed over from {parts.handedFrom}</span> : null}
      {parts.files.map((file) => (
        <span className="chip" key={file.path} title={file.path}>
          <Icon>
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </Icon>
          {file.name}
        </span>
      ))}
      {parts.context.map((entry) => (
        <details className="mucontext" key={entry.who}>
          <summary>
            {entry.text
              ? `Included ${entry.who}'s latest reply`
              : `${entry.who} had not replied yet`}
          </summary>
          {entry.text ? <p>{entry.text}</p> : null}
        </details>
      ))}
    </div>
  );
}

function SaveDialog({ text, close }: { text: string; close: () => void }) {
  const [name, setName] = useState(() => text.split(/\s+/).slice(0, 4).join(' ').slice(0, 40));
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);
  useEscape(close);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    useSaved
      .getState()
      .add(name, text)
      .then(() => {
        toast('Saved. Type / in the message box to use it.');
        close();
      })
      .catch((error: Error) => {
        setProblem(error.message);
        setSaving(false);
      });
  };
  return (
    <Modal>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="saveTitle"
        onSubmit={submit}
      >
        <h2 id="saveTitle">Save as an instruction</h2>
        <p className="help">
          Keep this message to send again. It shows up when you type / in any message box.
        </p>
        <div className="field">
          <label htmlFor="saveName">Name</label>
          <input
            id="saveName"
            className="in"
            value={name}
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? 'saveProblem' : undefined}
            autoFocus
          />
          {problem ? (
            <span className="help" id="saveProblem" role="alert" style={{ color: 'var(--red)' }}>
              {problem}
            </span>
          ) : null}
        </div>
        <blockquote className="mdquote">
          {text.length > 400 ? `${text.slice(0, 400)}…` : text}
        </blockquote>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!name.trim() || saving}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function UserRow({ row }: { row: Extract<Row, { kind: 'user' }> }) {
  const [saving, setSaving] = useState(false);
  const { item, parts } = row;
  const typedElsewhere = item.from === 'session';
  return (
    <div className="mrow you" data-testid="chatYou">
      <div className="mbody">
        <Chips parts={parts} />
        {parts.body ? <div className="mtext">{parts.body}</div> : null}
      </div>
      <div className="mmeta">
        <span>
          {typedElsewhere ? "You, in the session's own window" : 'You'}
          {row.who ? <> to {row.who.name}</> : null} ·{' '}
          <time className="num">{clockText(item.time)}</time>
        </span>
        <span className="macts">
          <button
            type="button"
            className="linkbtn"
            onClick={() => copyText(parts.body, 'Message copied')}
          >
            Copy
          </button>
          <button type="button" className="linkbtn" onClick={() => setSaving(true)}>
            Save as instruction
          </button>
        </span>
      </div>
      {saving ? <SaveDialog text={parts.body || item.text} close={() => setSaving(false)} /> : null}
    </div>
  );
}

function HandDialog({ from, itemId, close }: { from: Who; itemId: string; close: () => void }) {
  const agents = useOfficeStore((state) => state.office?.agents ?? []);
  const options = agents.filter((agent) => agent.id !== from.id && !agent.leadId && !agent.leaving);
  const [to, setTo] = useState(options[0]?.id ?? '');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  useEscape(close);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!to || sending) return;
    setSending(true);
    chatApi
      .hand(from.id, itemId, to, note.trim())
      .then(() => {
        toast(`Handed to ${options.find((agent) => agent.id === to)?.name ?? 'the agent'}.`);
        close();
      })
      .catch((error: Error) => {
        toast(error.message);
        setSending(false);
      });
  };
  return (
    <Modal>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="handTitle"
        onSubmit={submit}
      >
        <h2 id="handTitle">Hand {from.name}&apos;s reply to…</h2>
        <p className="help">
          They get the reply, what it answered and who it came from. Their risky actions still need
          your click.
        </p>
        {options.length ? (
          <fieldset className="handlist">
            <legend className="sr">Who gets it</legend>
            {options.map((agent) => (
              <label className="radio" key={agent.id}>
                <input
                  type="radio"
                  name="handTo"
                  checked={to === agent.id}
                  onChange={() => setTo(agent.id)}
                />
                <span>
                  <Dot who={agent} /> <b>{agent.name}</b> <span className="help">{agent.task}</span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : (
          <p className="help">There is nobody else in the office to hand it to.</p>
        )}
        <div className="field">
          <label htmlFor="handNote">Add a note (optional)</label>
          <textarea
            id="handNote"
            className="in"
            rows={2}
            value={note}
            placeholder="For example: review this for edge cases"
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!to || sending}>
            Hand over
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AssistantRow({
  row,
  showWho,
}: {
  row: Extract<Row, { kind: 'assistant' }>;
  showWho: boolean;
}) {
  const [handing, setHanding] = useState(false);
  const { item, who } = row;
  return (
    <div className="mrow ai" data-testid="chatAgent" aria-busy={item.streaming || undefined}>
      <Byline who={who} time={item.time} showWho={showWho} />
      <div className="mbody">
        {item.text ? (
          <Markdown text={item.text} streaming={item.streaming} />
        ) : (
          <span className="mtyping" role="status">
            <span className="sr">{who.name} is writing</span>
            <i aria-hidden="true" />
            <i aria-hidden="true" />
            <i aria-hidden="true" />
          </span>
        )}
        {item.clipped ? (
          <p className="help">This reply was longer than Mabari keeps, so the end is cut.</p>
        ) : null}
      </div>
      {item.streaming || !item.text ? null : (
        <div className="mmeta">
          <span className="macts">
            <button
              type="button"
              className="linkbtn"
              onClick={() => copyText(item.text, 'Reply copied')}
            >
              Copy
            </button>
            <button type="button" className="linkbtn" onClick={() => setHanding(true)}>
              Hand to…
            </button>
          </span>
        </div>
      )}
      {handing ? <HandDialog from={who} itemId={item.id} close={() => setHanding(false)} /> : null}
    </div>
  );
}

function ToolRow({ row }: { row: Extract<Row, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const { item } = row;
  const tool = item.tool!;
  const id = `tool-${item.id}`;
  return (
    <div className={`mtool ${tool.state}${item.parent ? ' sub' : ''}`} data-testid="chatTool">
      <button
        type="button"
        className="mtoolbtn"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((was) => !was)}
      >
        <svg className="ico chev" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 6l6 6-6 6" />
        </svg>
        <span className="mtoolname mono">{tool.name}</span>
        <span className="mtoolsum">{tool.summary || tool.name}</span>
        <span className="mtoolstate">{TOOL_WORDS[tool.state]}</span>
      </button>
      {open ? (
        <div className="mtooldetail" id={id}>
          {tool.input ? (
            <>
              <span className="help">Input</span>
              <pre tabIndex={0} aria-label="Tool input">
                {tool.input}
              </pre>
            </>
          ) : null}
          {tool.output ? (
            <>
              <span className="help">Output</span>
              <pre tabIndex={0} aria-label="Tool output">
                {tool.output}
              </pre>
            </>
          ) : (
            <span className="help">
              {tool.state === 'running' ? 'No result yet.' : 'No output.'}
            </span>
          )}
          {item.clipped ? <span className="help">Some of this was cut to fit.</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function PendingRow({ row }: { row: Extract<Row, { kind: 'pending' }> }) {
  const { instruction, parts } = row;
  const remove = () =>
    api.removeInstruction(instruction.id).catch((error: Error) => toast(error.message));
  return (
    <div className="mrow you pending" data-testid="chatPending">
      <div className="mbody">
        <Chips parts={parts} />
        {parts.body ? <div className="mtext">{parts.body}</div> : null}
      </div>
      <div className="mmeta">
        <span>
          {row.who ? <>To {row.who.name} · </> : null}
          <span className="pcmq">
            {row.opening ? 'Opening Claude Code' : 'Waiting for its next checkpoint'}
          </span>
        </span>
        {row.opening ? null : (
          <button
            type="button"
            className="linkbtn"
            aria-label={`Remove “${instruction.text.slice(0, 40)}” before it is delivered`}
            onClick={() => void remove()}
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

const COLUMN_WORDS = {
  waiting: 'Waiting for its next checkpoint',
  working: 'Working on it',
  replied: 'Replied',
  gone: 'Has left the office',
} as const;

function Column({ column }: { column: RoundColumn }) {
  const text = column.replies.map((reply) => reply.text).join('\n\n');
  return (
    <section className="mcol" aria-label={`${column.who.name}'s reply`} data-state={column.state}>
      <header>
        <Dot who={column.who} />
        <a className="mwho" href={chatHash.agent(column.who.id)}>
          {column.who.name}
        </a>
        <span className={column.state === 'waiting' ? 'pcmq' : 'help'}>
          {COLUMN_WORDS[column.state]}
        </span>
      </header>
      {text ? (
        <div className="mcolbody">
          <Markdown text={text} streaming={column.streaming} />
        </div>
      ) : (
        <p className="help">
          {column.state === 'gone' ? 'Nothing came back before it left.' : 'No reply yet.'}
        </p>
      )}
    </section>
  );
}

function RoundRow({ row }: { row: Extract<Row, { kind: 'round' }> }) {
  const { ask, columns } = row;
  // An agent that has said something has replied, though it may still be working on the rest.
  const replied = columns.filter((column) => column.replies.length > 0).length;
  return (
    <div className="mround" data-testid="chatRound">
      <div className="mrow you">
        <div className="mbody">
          <span className="chip">Asked everyone</span>
          <div className="mtext">{ask.text}</div>
        </div>
        <div className="mmeta">
          <span>
            You to {columns.length} {columns.length === 1 ? 'agent' : 'agents'} ·{' '}
            <time className="num">{clockText(ask.time)}</time> · {replied} of {columns.length}{' '}
            replied
          </span>
        </div>
      </div>
      <div className="mcols">
        {columns.map((column) => (
          <Column key={column.who.id} column={column} />
        ))}
      </div>
    </div>
  );
}

function sameRow(a: Row, b: Row): boolean {
  if (a.kind !== b.kind || a.key !== b.key) return false;
  if ('item' in a && 'item' in b) {
    return a.item === b.item && a.who?.name === b.who?.name && a.who?.hue === b.who?.hue;
  }
  if (a.kind === 'pending' && b.kind === 'pending') {
    return a.instruction.text === b.instruction.text && a.who?.name === b.who?.name;
  }
  return false;
}

interface RowProps {
  row: Row;
  showWho: boolean;
}

/** One line of a thread. A row only draws again when its own item has changed. */
export const ThreadRow = memo(
  function ThreadRow({ row, showWho }: RowProps) {
    switch (row.kind) {
      case 'user':
        return <UserRow row={row} />;
      case 'assistant':
        return <AssistantRow row={row} showWho={showWho} />;
      case 'tool':
        return <ToolRow row={row} />;
      case 'notice':
        return (
          <p className="mnotice" data-testid="chatNotice">
            <span>{row.item.text}</span>
          </p>
        );
      case 'pending':
        return <PendingRow row={row} />;
      case 'round':
        return <RoundRow row={row} />;
    }
  },
  (before, after) => before.showWho === after.showWho && sameRow(before.row, after.row),
);

/**
 * An approval, in the thread where you would answer it: what is asked, how risky, and the two
 * answers. It is the same card as the dialog's, and only a click on it answers.
 */
export function ApprovalInline({ agent }: { agent: LiveAgent }) {
  const approval = agent.approval;
  const autoOn = useOfficeStore((state) => state.office?.settings.autoApprove.on ?? false);
  if (!approval) return null;
  const risky = approval.riskLevel === 'high';
  const decide = (decision: 'allowed' | 'denied') => {
    api.decide(approval.id, decision).catch((error: Error) => toast(error.message));
  };
  return (
    <section className="mapproval" aria-labelledby={`ap-${approval.id}`} data-testid="chatApproval">
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <span className="chip red">
          <i />
          Approval needed
        </span>
        {risky ? <span className="chip red">Risky</span> : <span className="chip">Low risk</span>}
      </div>
      <h3 id={`ap-${approval.id}`}>
        {agent.name} {approval.title}
      </h3>
      <ApprovalBody approval={approval} />
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
    </section>
  );
}
