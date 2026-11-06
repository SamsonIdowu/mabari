// SPDX-License-Identifier: Apache-2.0
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useOfficeStore } from '../data/officeStore.ts';
import { clockText } from '../format.ts';
import type { LiveAgent, Message, Snapshot } from '../gen/models.ts';
import { chatHash, chatPlace, useChatHash } from '../chat/chatRoute.ts';
import { WithYou } from '../chat/WithYou.tsx';
import { openAgent, threadKey, useOfficeUi } from '../office/uiStore.ts';
import { MESSAGE_KINDS } from '../office/talk.ts';
import { Icon } from '../shell/Icon.tsx';
import { PageHead } from './parts.tsx';
import { Cast } from '../shell/Cast.tsx';

const KINDS = MESSAGE_KINDS;

const LIVE_MS = 5000;
/** Within this many pixels of the bottom, a new message keeps the view at the bottom. */
const NEAR_BOTTOM_PX = 80;

interface Thread {
  key: string;
  first: string;
  second: string;
  messages: Message[];
}

function threadsOf(messages: Message[]): Thread[] {
  const threads = new Map<string, Thread>();
  for (const message of messages) {
    const [first, second] = [message.fromName, message.toName].sort() as [string, string];
    const key = threadKey(first, second);
    const thread = threads.get(key) ?? { key, first, second, messages: [] };
    thread.messages.push(message);
    threads.set(key, thread);
  }
  return [...threads.values()].sort(
    (a, b) => (b.messages.at(-1)?.time ?? 0) - (a.messages.at(-1)?.time ?? 0),
  );
}

function Dot({ hue }: { hue: string | undefined }) {
  return <span className="idot" style={{ ['--ac' as string]: hue ?? '#9AA0AE' }} />;
}

export function MessageBubble(props: {
  message: Message;
  right: boolean;
  hue: string | undefined;
  showPair?: boolean;
}) {
  const { message } = props;
  const kind = KINDS[message.kind];
  return (
    <div className={props.right ? 'cmsg r' : 'cmsg'}>
      <Dot hue={props.hue} />
      <div className="cb" style={{ borderLeftColor: kind?.color }}>
        <span className="cmeta">
          <b>{message.fromName}</b>
          {props.showPair !== false ? (
            <>
              <span className="muted">to</span>
              <b>{message.toName}</b>
            </>
          ) : null}
          {kind ? (
            <span className="dec" style={{ ['--dc' as string]: kind.color }}>
              {kind.label}
            </span>
          ) : null}
          <span className="muted num">{clockText(message.time)}</span>
        </span>
        <span>{message.text}</span>
      </div>
    </div>
  );
}

function ThreadProject({ office, id }: { office: Snapshot; id: string | null }) {
  const project = office.projects.find((item) => item.id === id);
  if (!project) return null;
  return (
    <span className="chip" style={{ marginLeft: 4 }}>
      <span className="pdot" style={{ background: project.color }} />
      {project.name}
    </span>
  );
}

/** The time, refreshed every second, so a thread's live marker fades without a new message. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** What agents say to each other: the pairs, and the thread of each. */
function AgentChats() {
  const now = useNow();
  const office = useOfficeStore((state) => state.office);
  // Kept in the UI store, so an agent's panel can open a thread here.
  const project = useOfficeUi((state) => state.threadProject);
  const selected = useOfficeUi((state) => state.thread);
  const set = useOfficeUi((state) => state.set);
  const setProject = (threadProject: string) => set({ threadProject });
  const setSelected = (thread: string) => set({ thread });
  const [search, setSearch] = useState('');
  const messages = office?.messages;
  const inProject = useMemo(
    () => (messages ?? []).filter((item) => project === 'all' || item.projectId === project),
    [messages, project],
  );
  const body = useRef<HTMLDivElement>(null);
  const shown = useRef({ thread: '', count: 0 });
  const count = inProject.length;
  // Newest at the bottom: jump there on a new thread, and follow new messages while near it.
  useLayoutEffect(() => {
    const pane = body.current;
    if (!pane) return;
    const near = pane.scrollHeight - pane.scrollTop - pane.clientHeight < NEAR_BOTTOM_PX;
    const before = shown.current;
    if (before.thread !== selected || (count !== before.count && near) || before.count === 0) {
      pane.scrollTop = pane.scrollHeight;
    }
    shown.current = { thread: selected, count };
  });
  if (!office) return null;

  const query = search.toLowerCase();
  const threads = threadsOf(inProject).filter((thread) => {
    if (!query) return true;
    const text = thread.messages.map((item) => item.text).join(' ');
    return `${thread.first} ${thread.second} ${text}`.toLowerCase().includes(query);
  });
  const current = threads.find((thread) => thread.key === selected);
  const hueOf = (name: string) =>
    office.agents.find((agent: LiveAgent) => agent.name === name)?.hue;
  const tabs = [{ id: 'all', name: 'All projects', color: '#8E8E93' }, ...office.projects];

  return (
    <>
      <div className="ptabs">
        {tabs.map((tab) => (
          <button
            type="button"
            key={tab.id}
            className={project === tab.id ? 'ptab on' : 'ptab'}
            style={{ ['--pc2' as string]: tab.color }}
            aria-pressed={project === tab.id}
            onClick={() => setProject(tab.id)}
          >
            {tab.id === 'all' ? null : <span className="pd" />}
            {tab.name}
          </button>
        ))}
      </div>
      <div className="convwrap">
        <div className="card">
          <div className="cardhd">
            <label className="sr" htmlFor="convQ">
              Search conversations
            </label>
            <input
              className="in"
              id="convQ"
              placeholder="Search by agent or message"
              style={{ minHeight: 36 }}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <button
              type="button"
              className={current ? 'thread' : 'thread on'}
              onClick={() => setSelected('all')}
            >
              <span className="tav" style={{ background: 'var(--accent-soft)' }}>
                <Icon>
                  <path d="M4 6h16M4 12h16M4 18h10" />
                </Icon>
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <b>Everything</b>
                <span className="tl">
                  {inProject.length} messages across {threads.length} conversations
                </span>
              </span>
            </button>
            {threads.map((thread) => {
              const last = thread.messages.at(-1);
              const live = last ? now - last.time < LIVE_MS : false;
              return (
                <button
                  type="button"
                  key={thread.key}
                  className={current?.key === thread.key ? 'thread on' : 'thread'}
                  onClick={() => setSelected(thread.key)}
                >
                  <span className="tav">
                    <Dot hue={hueOf(thread.first)} />
                    <Dot hue={hueOf(thread.second)} />
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <b>
                        {thread.first} and {thread.second}
                      </b>
                      <span className="muted num" style={{ fontSize: 12 }}>
                        {last ? clockText(last.time) : ''}
                      </span>
                    </span>
                    <span className="tl">
                      {live ? <span className="livepip" /> : null}
                      {last?.fromName}: {last?.text}
                    </span>
                  </span>
                </button>
              );
            })}
            {threads.length === 0 ? (
              <p className="help" style={{ padding: 12 }}>
                No conversations yet in this project. Agents start talking once two of them share a
                project.
              </p>
            ) : null}
          </div>
        </div>
        <div className="card">
          <div className="cardhd">
            {current ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <Dot hue={hueOf(current.first)} />
                  <b>{current.first}</b>
                  <span className="muted">and</span>
                  <Dot hue={hueOf(current.second)} />
                  <b>{current.second}</b>
                  <ThreadProject office={office} id={current.messages[0]?.projectId ?? null} />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {[current.first, current.second].map((name) => {
                    const agent = office.agents.find((item) => item.name === name);
                    return agent ? (
                      <button
                        type="button"
                        className="btn sm"
                        key={name}
                        onClick={() => openAgent(agent, office.agents)}
                      >
                        Open {name}
                      </button>
                    ) : null;
                  })}
                </div>
              </>
            ) : (
              <div>
                <b>Everything</b>{' '}
                <span className="muted">· every message between agents, newest at the bottom</span>
              </div>
            )}
          </div>
          <div
            ref={body}
            data-testid="convBody"
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              padding: 18,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            {(current ? current.messages : inProject.slice(-80)).map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                hue={hueOf(message.fromName)}
                right={current ? message.fromName !== current.first : false}
              />
            ))}
            {inProject.length === 0 ? (
              <div className="emptycast">
                <Cast who={2} act="think" />
                <p className="help">Nothing yet.</p>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}

const DESCRIPTIONS = {
  with: 'Talk to your agents, or to everyone on a project. The ones that need you come first.',
  between:
    'What agents say to each other: questions, answers, handoffs, reviews and subagent reports. Pick a pair to read their thread.',
};

/**
 * Chats. With you is where you give agents instructions, one agent or a whole project, in a
 * thread. Between agents is what they say to each other, as it always was.
 */
export function Conversations() {
  const office = useOfficeStore((state) => state.office);
  const hash = useChatHash();
  const { tab } = chatPlace(hash);
  if (!office) return null;
  const tabs: [typeof tab, string, string][] = [
    ['with', 'With you', chatHash.with()],
    ['between', 'Between agents', chatHash.between()],
  ];
  return (
    <section data-screen="conversations">
      <div className="page">
        <PageHead title="Conversations" description={DESCRIPTIONS[tab]}>
          {tab === 'between' ? (
            <div className="legend">
              {Object.entries(KINDS).map(([id, kind]) => (
                <span className="dec" style={{ ['--dc' as string]: kind.color }} key={id}>
                  {kind.label}
                </span>
              ))}
            </div>
          ) : null}
        </PageHead>
        <div className="seg chtabs" role="group" aria-label="Conversation views">
          {tabs.map(([id, label, href]) => (
            <button
              type="button"
              key={id}
              className={tab === id ? 'on' : ''}
              aria-pressed={tab === id}
              onClick={() => {
                window.location.hash = href;
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === 'with' ? <WithYou office={office} /> : <AgentChats />}
      </div>
    </section>
  );
}
