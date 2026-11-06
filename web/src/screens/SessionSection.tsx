// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { emptyThread, useConversations } from '../data/conversation.ts';
import { api } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import type { ConversationItem, LiveAgent, ToolCallState } from '../gen/models.ts';
import { Modal } from '../shell/Modal.tsx';
import { waitingCall } from '../chat/threadModel.ts';
import { useEscape } from '../shell/useEscape.ts';

/** How many of the newest entries the panel shows. The Chats screen has the whole conversation. */
const SHOWN = 20;

const TOOL_WORDS: Record<ToolCallState, string> = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  denied: 'Denied',
};

function Entry(props: { item: ConversationItem; agent: LiveAgent; waiting: boolean }) {
  const { item, agent, waiting } = props;
  if (item.kind === 'tool' && item.tool) {
    return (
      <li className="feeditem" data-testid="threadTool">
        <span className="mono">{item.tool.summary || item.tool.name}</span>{' '}
        <span className="help">{waiting ? 'Waiting for you' : TOOL_WORDS[item.tool.state]}</span>
      </li>
    );
  }
  if (item.kind === 'notice') {
    return (
      <li className="help" data-testid="threadNotice">
        {item.text}
      </li>
    );
  }
  return (
    <li data-testid={item.kind === 'user' ? 'threadYou' : 'threadAgent'}>
      <b>{item.kind === 'user' ? 'You' : agent.name}</b>{' '}
      <span style={{ whiteSpace: 'pre-wrap' }}>{item.text}</span>
    </li>
  );
}

/** The newest of the conversation, live, until the Chats screen draws all of it. */
export function LatestConversation({ agent }: { agent: LiveAgent }) {
  const thread = useConversations((state) => state.threads[agent.id] ?? emptyThread);
  const open = useConversations((state) => state.open);
  useEffect(() => {
    void open(agent.id).catch(() => undefined);
  }, [agent.id, open]);
  const newest = thread.items.slice(-SHOWN);
  if (!newest.length) return null;
  const waiting = waitingCall(newest, agent.approval);
  return (
    <div className="sect">
      <h3>Conversation</h3>
      <ul
        className="asked"
        data-testid="thread"
        aria-live="polite"
        aria-relevant="additions"
        style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}
      >
        {newest.map((item) => (
          <Entry item={item} agent={agent} waiting={item.id === waiting} key={item.id} />
        ))}
      </ul>
    </div>
  );
}

/** Shows the exact command that carries a session on in a terminal, so nobody feels locked in. */
function ContinueDialog({ agent, close }: { agent: LiveAgent; close: () => void }) {
  const toast = useOfficeStore((state) => state.toast);
  const demo = useOfficeStore((state) => state.office?.demo ?? false);
  const session = agent.session;
  useEscape(close);
  if (!session) return null;
  const running = session.status === 'running' && !demo;
  const release = () => {
    api
      .releaseSession(agent.id)
      .then(() => toast(`Mabari has let go of ${agent.name}'s session.`))
      .catch((failure: Error) => toast(failure.message));
  };
  return (
    <Modal onBackdrop={close}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="continueTitle">
        <h2 id="continueTitle">Continue in a terminal</h2>
        <p className="help">
          {demo
            ? 'This is what you would run. In the demo there is no real session, so it is only an example.'
            : 'Run this in any terminal. The conversation carries on from where it is.'}
        </p>
        {/* Wrapped, not clipped: this is a command to read and check before running. */}
        <div
          className="codebox"
          data-testid="continueCommand"
          style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
        >
          <span className="ctx">{session.resume}</span>
        </div>
        {running ? (
          <div className="banner amber" style={{ padding: '10px 12px' }}>
            <span className="grow">
              Mabari is still running this session. Let go of it first, or both will write to one
              history.
            </span>
            <button type="button" className="btn sm" onClick={release}>
              Let go of it
            </button>
          </div>
        ) : null}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={close}>
            Close
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() =>
              void navigator.clipboard
                ?.writeText(session.resume)
                .then(() => toast('Command copied'))
                .catch(() => toast('Copy it by hand: the browser refused the clipboard.'))
            }
          >
            Copy the command
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Takes over a session started elsewhere, once the person knows it may still be open there. */
function TakeOverDialog({ agent, close }: { agent: LiveAgent; close: () => void }) {
  const toast = useOfficeStore((state) => state.toast);
  const takeOver = () => {
    api
      .resumeSession(agent.id, true)
      .then(() => {
        toast(`Mabari runs ${agent.name}'s session now.`);
        close();
      })
      .catch((failure: Error) => toast(failure.message));
  };
  return (
    <Modal>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="takeOverTitle">
        <h2 id="takeOverTitle">Continue this session from Mabari?</h2>
        <p className="help">
          It was started somewhere else and may still be open there. Close it first: if both carry
          on, their messages mix in one history.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={close}>
            Leave it
          </button>
          <button type="button" className="btn primary" onClick={takeOver}>
            It&apos;s closed, continue here
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Who has this agent's session, and the ways to move it. Subagents share their lead's. */
export function SessionSection({ agent }: { agent: LiveAgent }) {
  const [dialog, setDialog] = useState<'continue' | 'takeOver' | null>(null);
  const toast = useOfficeStore((state) => state.toast);
  const session = agent.session;
  if (!session || agent.leadId) return null;
  const waiting = agent.queued?.length ?? 0;
  return (
    <div className="sect" data-testid="sessionSection">
      <h3>Session</h3>
      {session.status === 'running' ? <p className="help">Mabari runs this session.</p> : null}
      {session.status === 'resumable' ? (
        <p className="help" data-testid="sessionResumable">
          Resumable. Send a message and it carries on from where it stopped.
        </p>
      ) : null}
      {session.status === 'elsewhere' ? (
        <p className="help">
          Started somewhere else. Mabari follows it and reads its conversation.
        </p>
      ) : null}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {session.status === 'elsewhere' ? (
          <button type="button" className="btn sm" onClick={() => setDialog('takeOver')}>
            Continue from Mabari
          </button>
        ) : (
          <button type="button" className="btn sm" onClick={() => setDialog('continue')}>
            Continue in terminal
          </button>
        )}
        {session.status === 'resumable' && waiting > 0 ? (
          <button
            type="button"
            className="btn sm"
            onClick={() =>
              void api
                .resumeSession(agent.id, false)
                .catch((failure: Error) => toast(failure.message))
            }
          >
            Resume and send what&apos;s waiting
          </button>
        ) : null}
      </div>
      {dialog === 'continue' ? (
        <ContinueDialog agent={agent} close={() => setDialog(null)} />
      ) : null}
      {dialog === 'takeOver' ? (
        <TakeOverDialog agent={agent} close={() => setDialog(null)} />
      ) : null}
    </div>
  );
}
