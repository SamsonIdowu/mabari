// SPDX-License-Identifier: Apache-2.0
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { api } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import { clockText } from '../format.ts';
import type { LiveAgent, Project } from '../gen/models.ts';
import { openAgent } from '../office/uiStore.ts';
import { CHAT_STATUS, projectChat, removable, type ChatItem } from '../office/projectChat.ts';
import { Icon } from '../shell/Icon.tsx';
import { useEscape } from '../shell/useEscape.ts';

const toast = (text: string) => useOfficeStore.getState().toast(text);

/** The message box grows with what is typed, up to this many pixels. */
const BOX_MAX_PX = 140;

const timeOf = clockText;

function Message({ item, agents }: { item: ChatItem; agents: LiveAgent[] }) {
  const remove = () => api.removeInstruction(item.id).catch((error: Error) => toast(error.message));
  const agent = agents.find((candidate) => candidate.id === item.agentId);
  return (
    <>
      <li className="pcm you">
        <div className="pcmbody">{item.text}</div>
        <div className="pcmmeta">
          <span>
            To <b>{item.to}</b> · {timeOf(item.at)} ·{' '}
            <span className={item.status === 'queued' ? 'pcmq' : undefined}>
              {CHAT_STATUS[item.status]}
            </span>
          </span>
          {removable(item) ? (
            <button
              type="button"
              className="linkbtn"
              aria-label={`Remove “${item.text.slice(0, 40)}” before it is delivered`}
              onClick={() => void remove()}
            >
              Remove
            </button>
          ) : null}
        </div>
      </li>
      {item.reply ? (
        <li className="pcm ai">
          <div className="pcmmeta">
            <span>
              {agent ? (
                <button
                  type="button"
                  className="linkbtn"
                  onClick={() => openAgent(agent, useOfficeStore.getState().office?.agents ?? [])}
                >
                  {item.to}
                </button>
              ) : (
                <b>{item.to}</b>
              )}{' '}
              ({item.ai}) · {timeOf(item.repliedAt)}
            </span>
          </div>
          <div className="pcmbody">{item.reply}</div>
        </li>
      ) : null}
    </>
  );
}

/**
 * A chat with a project: what you send goes to the Claude Code session working there, or opens
 * Claude Code in the project's folder with it. Replies come back here as they land.
 */
export function ProjectChat({ project, close }: { project: Project; close: () => void }) {
  const agents = useOfficeStore((state) => state.office?.agents ?? []);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const items = projectChat(project, agents);
  const folder = project.repository?.path ?? '';
  const live = agents.filter((agent) => agent.projectId === project.id && !agent.leadId);
  // A dialog opened on top closes first, with its own Escape.
  useEscape(() => {
    if (!document.querySelector('.scrim')) close();
  });
  useLayoutEffect(() => {
    const field = box.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, BOX_MAX_PX)}px`;
  }, [text]);
  // Keep the newest message in view as messages and replies arrive.
  const last = items.at(-1);
  const lastKey = last ? `${last.id}:${last.status}` : '';
  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: 'end' });
  }, [lastKey]);
  useEffect(() => box.current?.focus(), []);

  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    try {
      const result = await api.sendToProject(project.id, message);
      setText('');
      toast(result.notice);
    } catch (error) {
      toast((error as Error).message);
    } finally {
      setSending(false);
    }
  };
  const openClaude = () =>
    api
      .openProjectClaude(project.id)
      .then(({ notice }) => toast(notice))
      .catch((error: Error) => toast(error.message));
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send();
  };
  const who = live.length
    ? `${live.map((agent) => agent.name).join(', ')} ${live.length === 1 ? 'works' : 'work'} here`
    : 'Nobody works here yet';

  return (
    <aside className="panel pchat" aria-label={`Chat with ${project.name}`}>
      <div className="phd" style={{ boxShadow: `inset 0 4px 0 ${project.color}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
          <h2 style={{ fontSize: 20, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span className="pdot" style={{ background: project.color }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {project.name}
            </span>
          </h2>
          <button
            type="button"
            className="btn ghost sm"
            aria-label="Close the chat"
            onClick={close}
          >
            <Icon>
              <path d="M6 6l12 12M18 6 6 18" />
            </Icon>
          </button>
        </div>
        <div
          className="meta"
          style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
        >
          {folder ? (
            <span className="mono" title={folder}>
              {folder}
            </span>
          ) : (
            <span>No folder yet</span>
          )}
          <span>· {who}</span>
        </div>
        {folder ? (
          <div>
            <button type="button" className="btn sm" onClick={() => void openClaude()}>
              Open Claude Code
            </button>
          </div>
        ) : null}
      </div>
      <ol className="pcmsgs" ref={list} aria-label="Messages" tabIndex={0}>
        {items.length === 0 ? (
          <li className="help pcempty">
            {folder
              ? `Nothing sent yet. Tell Claude what to do in ${folder}, or run a /command.`
              : 'Nothing sent yet. Attach a folder so Claude Code can open here.'}
          </li>
        ) : (
          items.map((item) => <Message key={item.id} item={item} agents={agents} />)
        )}
      </ol>
      <form className="pcbox" autoComplete="off" onSubmit={submit}>
        <label className="sr" htmlFor="pcText">
          Message {project.name}
        </label>
        <textarea
          id="pcText"
          ref={box}
          rows={1}
          placeholder="Tell Claude what to do, or type a /command"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKey}
        />
        <button type="submit" className="btn sm primary" disabled={sending || !text.trim()}>
          Send
        </button>
      </form>
      <p className="help pchint">
        Enter to send. A /command opens Claude Code in the folder and runs there; anything else goes
        to the Claude Code session working here, at its next step.
      </p>
    </aside>
  );
}
