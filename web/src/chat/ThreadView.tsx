// SPDX-License-Identifier: Apache-2.0
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type RefObject,
} from 'react';
import { useAsks } from '../data/chatApi.ts';
import { emptyThread, useConversations, type Thread } from '../data/conversation.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import type { LiveAgent, Project } from '../gen/models.ts';
import { QuestionCard } from '../screens/QuestionCard.tsx';
import { Cast } from '../shell/Cast.tsx';
import type { ComposerHandle } from './Composer.tsx';
import { ApprovalInline, ThreadRow } from './Rows.tsx';
import { buildRows, doingNow, type Row } from './threadModel.ts';

/** How many rows are drawn at first, and how many more each "Show earlier" adds. */
const ROWS_SHOWN = 120;
const ROWS_MORE = 120;
/** Within this many pixels of the bottom, new text keeps the thread at the bottom. */
const NEAR_BOTTOM_PX = 80;
const JUMP_PX = 240;
/** The top of the thread is this near, and this long since the last load, to load more by itself. */
const TOP_PX = 200;
const LOAD_GAP_MS = 350;

interface Props {
  mode: 'agent' | 'project';
  /** What the thread is called to a screen reader, such as "Messages with Ada". */
  label: string;
  agents: LiveAgent[];
  project?: Project | undefined;
  composer: RefObject<ComposerHandle | null>;
  empty: string;
}

/** Every thread opened since the page loaded, for the agents this one shows. */
function useThreads(agents: LiveAgent[]): Record<string, Thread> {
  const all = useConversations((state) => state.threads);
  const open = useConversations((state) => state.open);
  const ids = agents.map((agent) => agent.id).join('|');
  useEffect(() => {
    for (const id of ids.split('|').filter(Boolean)) void open(id).catch(() => undefined);
  }, [ids, open]);
  return all;
}

/**
 * What an agent, or a project's agents, have said and done, newest at the bottom. Streaming text
 * grows in place, a tool call is one calm line, and an approval or question waits at the end
 * where you answer it. Only the newest rows are drawn until you ask for earlier ones, or scroll to
 * the top, so a thread of thousands opens as fast as one of a hundred.
 */
export function ThreadView({ mode, label, agents, project, composer, empty }: Props) {
  const all = useThreads(agents);
  const older = useConversations((state) => state.older);
  const asks = useAsks((state) => (project ? state.byProject[project.id] : undefined));
  const loadAsks = useAsks((state) => state.load);
  const toast = useOfficeStore((state) => state.toast);
  const [shown, setShown] = useState(ROWS_SHOWN);
  const [away, setAway] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const loading = useRef(false);
  // Where the thread was when it last settled, so rows added above can be made up for.
  const metrics = useRef({ height: 0, top: 0, first: '' });

  useEffect(() => {
    if (project) void loadAsks(project.id).catch(() => undefined);
  }, [project, loadAsks]);

  const threads = useMemo(() => {
    const mine: Record<string, Thread> = {};
    for (const agent of agents) mine[agent.id] = all[agent.id] ?? emptyThread;
    return mine;
  }, [agents, all]);
  const loaded = agents.every((agent) => threads[agent.id]?.loaded);
  const more = agents.some((agent) => threads[agent.id]?.hasMore);

  const rows = useMemo(
    () =>
      buildRows({
        mode,
        agents,
        threads,
        asks: asks ?? [],
        opening: project?.opening ?? [],
      }),
    [mode, agents, threads, asks, project?.opening],
  );
  const first = Math.max(0, rows.length - shown);
  const visible = rows.slice(first);
  const doing = doingNow(agents, mode);

  // Draws more of what is held and, when that would use it up, asks for the page before it.
  const earlier = useCallback(() => {
    const next = shown + ROWS_MORE;
    setShown(next);
    if (rows.length > next || loading.current) return;
    const pages = agents.filter((agent) => threads[agent.id]?.hasMore);
    if (!pages.length) return;
    loading.current = true;
    void Promise.all(pages.map((agent) => older(agent.id)))
      .catch((error: Error) => toast(error.message))
      .finally(() => {
        loading.current = false;
      });
  }, [agents, older, rows.length, shown, threads, toast]);

  // Scrolling to near the top loads what is above, without a click. It is paced, so rows that were
  // just added have settled before more are, and it is started only by a scroll: a thread being
  // written to never loads its past by itself.
  const canLoad = first > 0 || more;
  const lastLoad = useRef(0);

  // What changes at the bottom: a new row, more text in the last one, an approval or a question.
  const last = rows.at(-1);
  const lastText = last && 'item' in last ? last.item.text.length : 0;
  const waiting = agents.filter((agent) => agent.approval || agent.question).length;
  const firstKey = visible[0]?.key ?? '';
  const signature = `${rows.length}:${last?.key ?? ''}:${lastText}:${waiting}:${loaded}`;
  useLayoutEffect(() => {
    const pane = scroller.current;
    if (!pane) return;
    const before = metrics.current;
    if (before.first && firstKey !== before.first && !stick.current) {
      // Rows were added above what is in view: keep what was in view where it was.
      pane.scrollTop = before.top + (pane.scrollHeight - before.height);
    } else if (stick.current) {
      pane.scrollTop = pane.scrollHeight;
    }
    metrics.current = { height: pane.scrollHeight, top: pane.scrollTop, first: firstKey };
  }, [signature, visible.length, firstKey]);

  const onScroll = () => {
    const pane = scroller.current;
    if (!pane) return;
    const gap = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
    metrics.current = { ...metrics.current, height: pane.scrollHeight, top: pane.scrollTop };
    stick.current = gap < NEAR_BOTTOM_PX;
    setAway(gap > JUMP_PX);
    if (canLoad && pane.scrollTop <= TOP_PX && Date.now() - lastLoad.current >= LOAD_GAP_MS) {
      lastLoad.current = Date.now();
      earlier();
    }
  };
  const jump = () => {
    const pane = scroller.current;
    if (!pane) return;
    stick.current = true;
    pane.scrollTop = pane.scrollHeight;
    setAway(false);
  };

  const dragged = (event: DragEvent) => event.dataTransfer.types.includes('Files');
  const showWho = mode === 'project';

  return (
    <div className="mscrollwrap">
      <div
        className="mscroll"
        ref={scroller}
        role="log"
        aria-label={label}
        aria-live="polite"
        aria-relevant="additions"
        tabIndex={0}
        data-testid="thread"
        onScroll={onScroll}
        onDragOver={(event) => {
          if (dragged(event)) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!dragged(event)) return;
          event.preventDefault();
          composer.current?.addFiles(Array.from(event.dataTransfer.files));
        }}
      >
        {canLoad ? (
          <button type="button" className="btn ghost sm mearlier" onClick={earlier}>
            Show earlier messages
            {first > 0 ? ` (${first}${more ? '+' : ''} more)` : ''}
          </button>
        ) : null}
        {visible.map((row: Row) => (
          <ThreadRow key={row.key} row={row} showWho={showWho} />
        ))}
        {!loaded && rows.length === 0 ? (
          <p className="help mempty" role="status">
            Loading the conversation…
          </p>
        ) : null}
        {loaded && rows.length === 0 ? (
          <div className="emptycast mempty">
            <Cast who={2} act="think" />
            <p className="help">{empty}</p>
          </div>
        ) : null}
        {agents.map((agent) =>
          agent.approval || agent.question ? (
            <div className="mwaiting" key={agent.id}>
              <ApprovalInline agent={agent} />
              <QuestionCard agent={agent} />
            </div>
          ) : null,
        )}
      </div>
      {away ? (
        <button type="button" className="btn sm mjump" onClick={jump}>
          Jump to latest
        </button>
      ) : null}
      <div
        className={`mdoing ${doing?.tone ?? 'none'}`}
        role="status"
        aria-live={doing?.tone === 'working' ? 'off' : 'polite'}
        aria-atomic="true"
        data-testid="doingNow"
      >
        {doing ? (
          <>
            <i aria-hidden="true" />
            <span>{doing.text}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}
