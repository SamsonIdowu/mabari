// SPDX-License-Identifier: Apache-2.0
// The review view: what an agent, or a project, has changed in its folder. The server reads the
// folder with Git and counts the lines; this shows the files and their diffs in the diff style the
// approval cards use, lets you comment on a line, and sends the comments, or the whole diff, to an
// agent. It reads and never changes a file.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { api } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import { clockText, stateLabel } from '../format.ts';
import type { ChangedFile, Changes, LiveAgent, Snapshot } from '../gen/models.ts';
import { counted } from '../office/uiStore.ts';
import {
  filesText,
  lineKey,
  lineRef,
  newCommentId,
  OPINION_WORDS,
  opinionView,
  orphanComments,
  pathText,
  reviewText,
  statusLabel,
  targetKey,
  useReview,
  type LineRef,
  type ReviewComment,
  type ReviewTarget,
} from '../office/review.ts';
import { Icon } from '../shell/Icon.tsx';
import { Modal } from '../shell/Modal.tsx';
import { useEscape } from '../shell/useEscape.ts';
import '../styles/changes.css';

/** How often the view asks again while it is open, and the least time between asks that an agent's step sets off. */
const POLL_MS = 4000;
const STEP_MS = 1200;

const NO_COMMENTS: ReviewComment[] = [];

const toast = (text: string) => useOfficeStore.getState().toast(text);

/** The icon on the buttons that open the view: a plus above a minus. */
export function ChangesIcon() {
  return (
    <Icon>
      <path d="M8 4v8M4 8h8M13 18h8" />
    </Icon>
  );
}

/**
 * Reads the changes and keeps them fresh: on a timer while the view is open, and soon after the
 * agent takes a step, which `signal` changes with. A page that already holds the latest is told
 * so by the server and keeps what it has, so an idle folder costs next to nothing.
 */
function useChanges(target: ReviewTarget, signal: string) {
  const client = useQueryClient();
  const key = useMemo(() => ['changes', target.kind, target.id], [target.kind, target.id]);
  const query = useQuery({
    queryKey: key,
    queryFn: async (): Promise<Changes> => {
      const held = client.getQueryData<Changes>(key);
      const next = await api.changes(target, held?.version ?? '');
      return next.state === 'unchanged' && held ? held : next;
    },
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    // A read is cheap and always wanted fresh: never show an old one first.
    staleTime: 0,
    gcTime: 0,
  });
  const last = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return undefined;
    }
    const wait = Math.max(0, last.current + STEP_MS - Date.now());
    timer.current = window.setTimeout(() => {
      last.current = Date.now();
      void client.invalidateQueries({ queryKey: key });
    }, wait);
    return () => window.clearTimeout(timer.current);
  }, [signal, client, key]);
  return query;
}

/** One row of a file's diff, ready to draw. */
interface Row {
  key: string;
  kind: 'add' | 'del' | 'ctx' | 'note' | 'hunk';
  old: number;
  new: number;
  text: string;
  ref: LineRef | null;
  /** The place among the rows that have a button, for moving with the arrow keys. */
  stop: number;
}

function rowsOf(file: ChangedFile): Row[] {
  const rows: Row[] = [];
  let stop = 0;
  file.hunks.forEach((hunk, h) => {
    rows.push({
      key: `h${h}`,
      kind: 'hunk',
      old: 0,
      new: 0,
      text: hunk.header,
      ref: null,
      stop: -1,
    });
    hunk.lines.forEach((line, l) => {
      const ref = lineRef(file, line);
      rows.push({
        key: `${h}.${l}`,
        kind: line.kind as Row['kind'],
        old: line.old,
        new: line.new,
        text: line.text,
        ref,
        stop: ref ? stop++ : -1,
      });
    });
  });
  return rows;
}

const MARKS = { add: '+', del: '−', ctx: ' ', note: '', hunk: '' } as const;
const WORDS = { add: 'Added. ', del: 'Removed. ', ctx: '', note: '', hunk: '' } as const;

const DiffRow = memo(function DiffRow(props: {
  row: Row;
  tab: 0 | -1;
  open: (ref: LineRef) => void;
}) {
  const { row, tab, open } = props;
  if (row.kind === 'hunk') {
    return (
      <tr className="chl hunk">
        <td colSpan={4}>{row.text}</td>
      </tr>
    );
  }
  if (!row.ref) {
    return (
      <tr className="chl note">
        <td className="chn" colSpan={3} />
        <td className="chtext">
          <code>{row.text}</code>
        </td>
      </tr>
    );
  }
  const { ref } = row;
  // The button is the number it is for, so its name always holds the text it shows: the new line's
  // number, or the old one's for a line that was removed. The other number is plain text.
  const button = (number: number) => (
    <button
      type="button"
      className="chbtn"
      data-stop={row.stop}
      data-ref={`${ref.side}:${ref.line}`}
      tabIndex={tab}
      aria-label={`Comment on ${ref.side === 'old' ? 'removed line' : 'line'} ${ref.line}`}
      onClick={() => open(ref)}
    >
      {number}
    </button>
  );
  return (
    <tr className={`chl ${row.kind}`}>
      <td className="chn">
        {ref.side === 'old' ? button(row.old) : <span aria-hidden="true">{row.old || ''}</span>}
      </td>
      <td className="chn">{ref.side === 'new' ? button(row.new) : null}</td>
      <td className="chmark">
        <span aria-hidden="true">{MARKS[row.kind]}</span>
        <span className="sr">{WORDS[row.kind]}</span>
      </td>
      <td className="chtext">
        <code>{row.text || ' '}</code>
      </td>
    </tr>
  );
});

/** Where a comment on a line is written. */
function Composer(props: {
  file: ChangedFile;
  at: LineRef;
  who: string;
  add: (text: string) => void;
  cancel: () => void;
}) {
  const [text, setText] = useState('');
  const id = `chc-${props.file.id}-${props.at.side}-${props.at.line}`;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim()) props.add(text.trim());
  };
  return (
    <tr className="chc">
      <td colSpan={4}>
        <form className="chform" onSubmit={submit}>
          <label className="sr" htmlFor={id}>
            Comment on {props.at.side === 'old' ? 'removed line' : 'line'} {props.at.line} of{' '}
            {props.file.path}
          </label>
          <textarea
            id={id}
            rows={3}
            // Opens ready to type.
            autoFocus
            value={text}
            placeholder={`What should ${props.who} change here?`}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(event);
            }}
          />
          <div className="chbtns">
            <button type="submit" className="btn sm primary" disabled={!text.trim()}>
              Add comment
            </button>
            <button type="button" className="btn sm" onClick={props.cancel}>
              Cancel
            </button>
          </div>
        </form>
      </td>
    </tr>
  );
}

interface FileProps {
  file: ChangedFile;
  who: string;
  /** This file's comments, by the line they are on. */
  comments: Map<string, ReviewComment[]>;
  composing: LineRef | null;
  open: (ref: LineRef) => void;
  add: (ref: LineRef, text: string) => void;
  cancel: () => void;
  remove: (id: string) => void;
}

const FileView = memo(function FileView(props: FileProps) {
  const { file, comments, composing } = props;
  const rows = useMemo(() => rowsOf(file), [file]);
  const [asked, setActive] = useState(0);
  // The diff changes under the reader as the agent works, so the one tab stop stays on a line
  // that is still there.
  const active = Math.min(asked, Math.max(0, rows.filter((row) => row.stop >= 0).length - 1));
  const body = useRef<HTMLTableSectionElement>(null);
  const moveTo = (stop: number) => {
    const buttons = body.current?.querySelectorAll<HTMLButtonElement>('button.chbtn');
    if (!buttons?.length) return;
    const next = Math.max(0, Math.min(buttons.length - 1, stop));
    setActive(next);
    buttons[next]?.focus();
  };
  const onKey = (event: KeyboardEvent) => {
    const at = (event.target as HTMLElement).closest<HTMLElement>('button.chbtn');
    if (!at) return;
    const stop = Number(at.dataset.stop);
    const moves: Record<string, number> = {
      ArrowDown: stop + 1,
      ArrowUp: stop - 1,
      PageDown: stop + 12,
      PageUp: stop - 12,
      Home: 0,
      End: Number.MAX_SAFE_INTEGER,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    moveTo(next);
  };
  const ids = props.file.id;
  return (
    <section className="chfile" id={`chf-${ids}`} aria-labelledby={`chh-${ids}`}>
      <h3 className="chfhd" id={`chh-${ids}`} tabIndex={-1}>
        <span className="chip">{statusLabel(file.status)}</span>
        <PathText file={file} />
        <Counts file={file} />
      </h3>
      {file.note ? <p className="help chnote">{file.note}</p> : null}
      {rows.length ? (
        <div
          className="codebox chcode"
          tabIndex={0}
          role="region"
          aria-label={`Changes in ${file.path}`}
        >
          <table className="chtable">
            <caption className="sr">
              Changed lines in {file.path}. Press a line number to comment on that line.
            </caption>
            <tbody ref={body} onKeyDown={onKey}>
              {rows.map((row) => {
                const here = row.ref ? comments.get(lineKey(row.ref)) : undefined;
                const writing =
                  composing && row.ref && lineKey(composing) === lineKey(row.ref)
                    ? composing
                    : null;
                return (
                  <Fragment key={row.key}>
                    <DiffRow row={row} tab={row.stop === active ? 0 : -1} open={props.open} />
                    {here?.map((item) => (
                      <tr className="chc done" key={item.id}>
                        <td colSpan={4}>
                          <div className="chcard" data-testid="reviewComment">
                            <span className="chcomment">{item.comment}</span>
                            <button
                              type="button"
                              className="linkbtn"
                              aria-label={`Remove your comment on line ${item.line} of ${file.path}`}
                              onClick={() => props.remove(item.id)}
                            >
                              Remove
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {writing ? (
                      <Composer
                        file={file}
                        at={writing}
                        who={props.who}
                        add={(text) => props.add(writing, text)}
                        cancel={props.cancel}
                      />
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
});

/** A file's path: its folders, which give way first when there is no room, and then its name. */
function PathText({ file }: { file: Pick<ChangedFile, 'path' | 'oldPath'> }) {
  if (file.oldPath) {
    return (
      <span className="chpath mono" title={pathText(file)}>
        <span className="chbase">{pathText(file)}</span>
      </span>
    );
  }
  const cut = file.path.lastIndexOf('/') + 1;
  return (
    <span className="chpath mono" title={file.path}>
      <span className="chdir">{file.path.slice(0, cut)}</span>
      <span className="chbase">{file.path.slice(cut)}</span>
    </span>
  );
}

/** +4 −2, or nothing for a file whose lines weren't counted. */
function Counts({ file }: { file: Pick<ChangedFile, 'counted' | 'added' | 'removed'> }) {
  if (!file.counted) return <span className="chcount help">not counted</span>;
  return (
    <span className="chcount num">
      <span className="chadd">
        <span className="sr">Added </span>+{file.added}
      </span>{' '}
      <span className="chdel">
        <span className="sr">Removed </span>−{file.removed}
      </span>
    </span>
  );
}

function FileList(props: {
  files: ChangedFile[];
  comments: ReviewComment[];
  more: number;
  go: (file: ChangedFile) => void;
}) {
  return (
    <nav className="chlist" aria-label="Changed files">
      <ul>
        {props.files.map((file) => {
          const notes = props.comments.filter((item) => item.path === file.path).length;
          return (
            <li key={file.id}>
              <button type="button" className="chitem" onClick={() => props.go(file)}>
                <PathText file={file} />
                <span className="chmeta">
                  <span className="chip">{statusLabel(file.status)}</span>
                  <Counts file={file} />
                  {notes ? (
                    <span className="chip">
                      {notes} comment{notes === 1 ? '' : 's'}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {props.more > 0 ? (
        <p className="help">
          and {props.more} more {props.more === 1 ? 'file' : 'files'}, not listed here
        </p>
      ) : null}
    </nav>
  );
}

/** Second opinions asked for on these changes, and what has come back. */
function Opinions({ keyOf, agents }: { keyOf: string; agents: LiveAgent[] }) {
  const opinions = useReview((state) => state.opinions[keyOf]) ?? [];
  if (!opinions.length) return null;
  return (
    <section className="chopinions" aria-label="Second opinions">
      <h3>Second opinions</h3>
      {opinions.map((opinion) => {
        const view = opinionView(opinion, agents);
        return (
          <article className="chopinion" key={`${opinion.reviewerId}-${opinion.at}`}>
            <header>
              <b>{view.name}</b>
              <span className={view.status === 'replied' ? 'chip ok' : 'chip'}>
                {OPINION_WORDS[view.status]}
              </span>
              {view.status === 'replied' ? <small>{clockText(view.repliedAt)}</small> : null}
            </header>
            {view.reply ? (
              <div
                className="reply"
                data-testid="opinionReply"
                tabIndex={0}
                role="region"
                aria-label={`${view.name}'s reply`}
              >
                {view.reply}
              </div>
            ) : (
              <p className="help">
                {view.name}&apos;s answer shows here when it comes, and in its own panel.
              </p>
            )}
          </article>
        );
      })}
    </section>
  );
}

/** Comments on lines that are not in the diff now. They still go with the review. */
function Orphans(props: { comments: ReviewComment[]; remove: (id: string) => void }) {
  if (!props.comments.length) return null;
  return (
    <section
      className="chopinions chorphans"
      aria-label="Comments on lines that are not shown"
      data-testid="orphanComments"
    >
      <h3>Comments on lines that are not shown</h3>
      <p className="help">
        The agent has changed these lines since, or the file no longer differs. They still go with
        the review.
      </p>
      {props.comments.map((item) => (
        <article className="chcard" key={item.id}>
          <span className="chcomment">
            <b className="mono">
              {item.path}, line {item.line}
            </b>
            <br />
            {item.comment}
          </span>
          <button
            type="button"
            className="linkbtn"
            aria-label={`Remove your comment on line ${item.line} of ${item.path}`}
            onClick={() => props.remove(item.id)}
          >
            Remove
          </button>
        </article>
      ))}
    </section>
  );
}

function reviewersFor(office: Snapshot, target: ReviewTarget): LiveAgent[] {
  return counted(office.agents).filter(
    (agent) => agent.id !== target.id || target.kind !== 'agent',
  );
}

/** The bar along the bottom: send the comments, or ask someone else. */
function ReviewBar(props: {
  target: ReviewTarget;
  office: Snapshot;
  who: string;
  folder: string;
  count: number;
  canAsk: boolean;
  send: () => Promise<void>;
  discard: () => void;
  ask: (reviewerId: string) => Promise<void>;
  busy: string;
  error: string;
  status: string;
}) {
  const reviewers = reviewersFor(props.office, props.target);
  const [reviewer, setReviewer] = useState('');
  const chosen = reviewers.some((agent) => agent.id === reviewer) ? reviewer : '';
  return (
    <div className="chfoot">
      <div className="chask">
        <label htmlFor="chReviewer">Second opinion from</label>
        <select
          id="chReviewer"
          className="in"
          value={chosen}
          disabled={!reviewers.length}
          onChange={(event) => setReviewer(event.target.value)}
        >
          <option value="">{reviewers.length ? 'Choose an agent' : 'No other agent here'}</option>
          {reviewers.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name} ({stateLabel(agent.state)})
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn sm"
          disabled={!chosen || !props.canAsk || props.busy === 'ask'}
          title={
            props.canAsk
              ? 'Send these changes to the agent to review'
              : 'There is nothing to review yet'
          }
          onClick={() => void props.ask(chosen)}
        >
          Ask for a second opinion
        </button>
      </div>
      <div className="chsend">
        {props.count ? (
          <>
            <span className="num" data-testid="reviewCount">
              {props.count} comment{props.count === 1 ? '' : 's'}
            </span>
            <button type="button" className="btn ghost sm" onClick={props.discard}>
              Discard
            </button>
          </>
        ) : (
          <span className="help">Press a line number to comment on a line.</span>
        )}
        <button
          type="button"
          className="btn sm primary"
          disabled={!props.count || props.busy === 'send'}
          onClick={() => void props.send()}
        >
          {props.count > 1 ? `Send review to ${props.who}` : `Send comment to ${props.who}`}
        </button>
      </div>
      <p className="help chstatus" role="status">
        {props.status}
      </p>
      {props.error ? (
        <p role="alert" className="chalert help">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

/** What the view says about the state of a read it couldn't make, or an empty one. */
function Notice({ changes }: { changes: Changes }) {
  if (changes.state === 'ok') {
    return (
      <div className="card chempty" data-testid="changesEmpty">
        <h3>Nothing has changed</h3>
        <p className="help">
          Every file in {changes.folder || 'the folder'} matches the last commit
          {changes.branch ? ` on ${changes.branch}` : ''}. Changes show up here as they are made.
        </p>
      </div>
    );
  }
  return (
    <div className="card chempty" data-testid="changesProblem">
      <h3>Can&apos;t show changes</h3>
      <p className="help">{changes.message}</p>
    </div>
  );
}

export function ChangesDialog({ target, close }: { target: ReviewTarget; close: () => void }) {
  const office = useOfficeStore((state) => state.office);
  const key = targetKey(target);
  const agent = office?.agents.find((item) => target.kind === 'agent' && item.id === target.id);
  const project = office?.projects.find(
    (item) => target.kind === 'project' && item.id === target.id,
  );
  // The newest step of the agent, or of every agent on the project, tells the view to look again.
  const signal = useOfficeStore((state) => {
    const agents = state.office?.agents ?? [];
    const mine =
      target.kind === 'agent'
        ? agents.filter((item) => item.id === target.id)
        : agents.filter((item) => item.projectId === target.id);
    return mine.map((item) => `${item.feed?.[0]?.id ?? ''}${item.state}`).join('|');
  });
  const query = useChanges(target, signal);
  const comments = useReview((state) => state.comments[key]) ?? NO_COMMENTS;
  const [composing, setComposing] = useState<LineRef | null>(null);
  const composingNow = useRef(composing);
  useEffect(() => {
    composingNow.current = composing;
  });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const body = useRef<HTMLDivElement>(null);

  const changes = query.data;
  const who = agent?.name ?? (project ? `the ${project.name} team` : 'the agent');
  const title = agent ? `Changes by ${agent.name}` : `Changes in ${project?.name ?? 'the project'}`;
  const files = useMemo(() => changes?.files ?? [], [changes]);
  const orphans = useMemo(() => orphanComments(files, comments), [files, comments]);
  const byFile = useMemo(() => {
    const grouped = new Map<string, Map<string, ReviewComment[]>>();
    // Under their lines, unless the line has gone: those are listed apart.
    for (const item of comments.filter((one) => !orphans.includes(one))) {
      const forFile = grouped.get(item.path) ?? new Map<string, ReviewComment[]>();
      const forLine = forFile.get(lineKey(item)) ?? [];
      forLine.push(item);
      forFile.set(lineKey(item), forLine);
      grouped.set(item.path, forFile);
    }
    return grouped;
  }, [comments, orphans]);
  const noComments = useMemo(() => new Map<string, ReviewComment[]>(), []);

  const open = useCallback((ref: LineRef) => setComposing(ref), []);
  const cancel = useCallback(() => {
    const was = composingNow.current;
    setComposing(null);
    // Back to the line it was written on.
    if (was) {
      window.setTimeout(() => {
        body.current
          ?.querySelector<HTMLElement>(`button[data-ref="${was.side}:${was.line}"]`)
          ?.focus();
      }, 0);
    }
  }, []);
  // Escape is for the comment being written first, then for the view.
  useEscape(() => (composingNow.current ? cancel() : close()));
  const add = useCallback(
    (ref: LineRef, text: string) => {
      useReview.getState().addComment(key, { ...ref, id: newCommentId(), comment: text });
      setComposing(null);
      setStatus('');
      window.setTimeout(() => {
        body.current
          ?.querySelector<HTMLElement>(`button[data-ref="${ref.side}:${ref.line}"]`)
          ?.focus();
      }, 0);
    },
    [key],
  );
  const remove = useCallback((id: string) => useReview.getState().removeComment(key, id), [key]);
  const go = useCallback((file: ChangedFile) => {
    const heading = document.getElementById(`chh-${file.id}`);
    heading?.scrollIntoView({ block: 'start' });
    heading?.focus({ preventScroll: true });
  }, []);

  const folder = changes?.folder ?? '';
  const send = async () => {
    if (!comments.length) return;
    setBusy('send');
    setError('');
    const text = reviewText(comments, folder || 'the folder');
    try {
      if (target.kind === 'agent') {
        await api.sendMessage(text, 'instruct', target.id, { projectId: 'all', teamId: '' });
      } else {
        toast((await api.sendToProject(target.id, text)).notice);
      }
      useReview.getState().clearComments(key);
      setStatus(
        `Sent ${comments.length === 1 ? 'your comment' : `your ${comments.length} comments`} to ${who}.`,
      );
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy('');
    }
  };
  const ask = async (reviewerId: string) => {
    setBusy('ask');
    setError('');
    try {
      const result = await api.secondOpinion(target, reviewerId);
      useReview.getState().addOpinion(key, {
        reviewerId: result.agentId,
        instructionId: result.instructionId,
        at: Date.now(),
      });
      toast(result.notice);
      setStatus(result.notice);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy('');
    }
  };

  const sub = changes ? `${filesText(changes.fileCount)}` : '';
  return (
    <Modal>
      <div className="dialog changes" role="dialog" aria-modal="true" aria-labelledby="chTitle">
        <div className="dhd">
          <div className="chtitle">
            <h2 id="chTitle">
              {project ? (
                <span className="pdot" style={{ background: project.color }} />
              ) : agent ? (
                <span className="idot" style={{ ['--ac' as string]: agent.hue }} />
              ) : null}
              {title}
            </h2>
            <p className="help chsub">
              {changes && changes.state === 'ok' ? (
                <>
                  <b className="num">{sub}</b>
                  <span className="chcount num">
                    <span className="chadd">+{changes.added}</span>{' '}
                    <span className="chdel">−{changes.removed}</span>
                  </span>
                  {changes.branch ? (
                    <span
                      className="chip mono"
                      title={changes.detached ? 'Not on a branch' : 'Branch'}
                    >
                      {changes.detached ? `at ${changes.branch}` : changes.branch}
                    </span>
                  ) : null}
                  {changes.demo ? (
                    <span className="chip" data-testid="changesDemo">
                      Demo
                    </span>
                  ) : null}
                </>
              ) : null}
              {folder ? (
                <span className="mono chfolder" title={folder}>
                  {folder}
                </span>
              ) : null}
              {query.dataUpdatedAt ? (
                <span className="chlive" data-testid="changesLive">
                  {query.isError
                    ? `Can't reach Mabari. Showing what was read at ${clockText(query.dataUpdatedAt)}`
                    : `Live · ${clockText(query.dataUpdatedAt)}`}
                </span>
              ) : null}
            </p>
          </div>
          <button type="button" className="btn ghost sm" aria-label="Close" onClick={close}>
            <Icon>
              <path d="M6 6l12 12M18 6 6 18" />
            </Icon>
          </button>
        </div>
        {changes?.demo ? (
          <p className="help chdemo">
            This is the demo office, so these changes are made up to show how the view works. No
            folder is read.
          </p>
        ) : null}
        <div className="chbody" ref={body}>
          {office && !agent && !project ? (
            <div className="card chempty" data-testid="changesProblem">
              <h3>Can&apos;t show changes</h3>
              <p className="help">
                {target.kind === 'agent'
                  ? 'This agent has left the office'
                  : 'This project is gone'}
                , so there is nothing to read.
              </p>
            </div>
          ) : !changes ? (
            <p className="help" role="status">
              {query.isError ? query.error.message : 'Reading the folder…'}
            </p>
          ) : changes.state !== 'ok' || changes.fileCount === 0 ? (
            <>
              <Notice changes={changes} />
              {/* What was asked for and what came back stays in view, whatever the folder shows now. */}
              {office ? <Opinions keyOf={key} agents={office.agents} /> : null}
              <Orphans comments={comments} remove={remove} />
            </>
          ) : (
            <>
              <FileList
                files={files}
                comments={comments}
                more={changes.fileCount - files.length}
                go={go}
              />
              <div className="chfiles">
                {changes.truncated ? (
                  <p className="help chnote">
                    Some of the changes are too big to show here. Files that are cut say so, and the
                    counts are still true.
                  </p>
                ) : null}
                {office ? <Opinions keyOf={key} agents={office.agents} /> : null}
                <Orphans comments={orphans} remove={remove} />
                {files.map((file) => (
                  <FileView
                    key={file.id}
                    file={file}
                    who={who}
                    comments={byFile.get(file.path) ?? noComments}
                    composing={composing?.path === file.path ? composing : null}
                    open={open}
                    add={add}
                    cancel={cancel}
                    remove={remove}
                  />
                ))}
              </div>
            </>
          )}
        </div>
        {office ? (
          <ReviewBar
            target={target}
            office={office}
            who={who}
            folder={folder}
            count={comments.length}
            canAsk={Boolean(changes && changes.state === 'ok' && changes.fileCount > 0)}
            send={send}
            discard={() => useReview.getState().clearComments(key)}
            ask={ask}
            busy={busy}
            error={error}
            status={status}
          />
        ) : null}
      </div>
    </Modal>
  );
}
