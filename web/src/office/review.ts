// SPDX-License-Identifier: Apache-2.0
// The logic of the review view: what a comment on a line becomes when it is sent to an agent, the
// comments waiting to be sent, and the second opinions asked for. The server counts the lines and
// reads the folder; this only words and keeps.
import { create } from 'zustand';
import type { ChangedFile, ChangeLine, Changes, LiveAgent } from '../gen/models.ts';

/** What is being reviewed: an agent's changes, or a project's. */
export interface ReviewTarget {
  kind: 'agent' | 'project';
  id: string;
}

export const targetKey = (target: ReviewTarget): string => `${target.kind}:${target.id}`;

/** A line a comment is about. `side` is the new version of the file, or the old one for a removed line. */
export interface LineRef {
  path: string;
  side: 'new' | 'old';
  line: number;
  /** The line's text, so the agent can find it if the file has moved on. */
  text: string;
}

export interface ReviewComment extends LineRef {
  id: string;
  comment: string;
}

/** Where a click on a line of the diff points. A remark of Git's, such as "No newline", has no line. */
export function lineRef(file: ChangedFile, line: ChangeLine): LineRef | null {
  if (line.kind === 'del') return { path: file.path, side: 'old', line: line.old, text: line.text };
  if (line.kind === 'add' || line.kind === 'ctx') {
    return { path: file.path, side: 'new', line: line.new, text: line.text };
  }
  return null;
}

/** The same line, as a key for finding its comments. */
export const lineKey = (ref: Pick<LineRef, 'path' | 'side' | 'line'>): string =>
  `${ref.path}\u0000${ref.side}\u0000${ref.line}`;

const QUOTE_MAX = 80;

/** A line of code as it is quoted in an instruction: trimmed, cut short, and with no backticks to break the quote. */
export function quoted(text: string): string {
  const flat = text.replace(/`/g, "'").trim();
  const runes = [...flat];
  return runes.length > QUOTE_MAX ? `${runes.slice(0, QUOTE_MAX - 1).join('')}…` : flat;
}

function where(ref: LineRef): string {
  const place = ref.side === 'old' ? `line ${ref.line} of the old version` : `line ${ref.line}`;
  const what = ref.side === 'old' ? 'removed' : '';
  const code = quoted(ref.text);
  const shown = code ? ` (${what ? `${what}: ` : ''}\`${code}\`)` : '';
  return `${ref.path}, ${place}${shown}`;
}

/** A comment of more than one line keeps its lines under its number. */
const indented = (text: string): string => text.trim().replace(/\n/g, '\n   ');

/**
 * The instruction a review becomes: one comment as a sentence, several as a numbered list under a
 * line that says whose changes they are about. It starts with a word, never a slash or a dash, so it
 * can't be taken for a command.
 */
export function reviewText(comments: ReviewComment[], folder: string): string {
  const [only] = comments;
  if (comments.length === 1 && only) {
    return `Review comment on ${where(only)}: ${only.comment.trim()}`;
  }
  const items = comments.map(
    (item, index) => `${index + 1}. ${where(item)}: ${indented(item.comment)}`,
  );
  return `Review of the changes in ${folder}. ${comments.length} comments:\n${items.join('\n')}`;
}

/** What a status is called on the page. An untracked file is new to the repository, as an added one is. */
export const STATUS_LABELS: Record<string, string> = {
  modified: 'Modified',
  added: 'New',
  untracked: 'New',
  deleted: 'Deleted',
  renamed: 'Renamed',
  conflict: 'Conflict',
};

export const statusLabel = (status: string): string => STATUS_LABELS[status] ?? status;

/** "3 files", or "1 file". */
export const filesText = (count: number): string => `${count} file${count === 1 ? '' : 's'}`;

/** A file's path as the list shows it, with where a renamed file was. */
export const pathText = (file: Pick<ChangedFile, 'path' | 'oldPath'>): string =>
  file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;

/** One line of the sentence that says what the review is of: "Ledger's changes in ~/code/shop". */
export function subjectText(changes: Pick<Changes, 'folder'>, name: string): string {
  return changes.folder ? `${name} in ${changes.folder}` : name;
}

// ---- Comments waiting to be sent, and second opinions asked for. Kept across closing the view, so
// a half-made review isn't lost, and not across a reload.

export interface Opinion {
  reviewerId: string;
  /** The instruction that went to the reviewer, so its reply can be found. May be empty. */
  instructionId: string;
  at: number;
}

interface ReviewStore {
  comments: Record<string, ReviewComment[]>;
  opinions: Record<string, Opinion[]>;
  addComment: (key: string, comment: ReviewComment) => void;
  removeComment: (key: string, id: string) => void;
  clearComments: (key: string) => void;
  addOpinion: (key: string, opinion: Opinion) => void;
}

let nextComment = 1;
export const newCommentId = (): string => `rc-${nextComment++}`;

export const useReview = create<ReviewStore>((set) => ({
  comments: {},
  opinions: {},
  addComment: (key, comment) =>
    set((state) => ({
      comments: { ...state.comments, [key]: [...(state.comments[key] ?? []), comment] },
    })),
  removeComment: (key, id) =>
    set((state) => ({
      comments: {
        ...state.comments,
        [key]: (state.comments[key] ?? []).filter((item) => item.id !== id),
      },
    })),
  clearComments: (key) => set((state) => ({ comments: { ...state.comments, [key]: [] } })),
  addOpinion: (key, opinion) =>
    set((state) => ({
      opinions: { ...state.opinions, [key]: [...(state.opinions[key] ?? []), opinion] },
    })),
}));

export type OpinionStatus = 'sent' | 'waiting' | 'delivered' | 'replied' | 'gone';

export interface OpinionView {
  name: string;
  status: OpinionStatus;
  reply: string;
  repliedAt: number;
}

/**
 * Where a second opinion stands, read from the reviewer as the office has it now: waiting for its
 * checkpoint, delivered, or answered, with the reply. The reply is the one the reviewer gave to
 * this very request.
 */
export function opinionView(opinion: Opinion, agents: LiveAgent[]): OpinionView {
  const reviewer = agents.find((agent) => agent.id === opinion.reviewerId);
  if (!reviewer) return { name: 'That agent', status: 'gone', reply: '', repliedAt: 0 };
  const view = (status: OpinionStatus, reply = '', repliedAt = 0): OpinionView => ({
    name: reviewer.name,
    status,
    reply,
    repliedAt,
  });
  if (!opinion.instructionId) return view('sent');
  if ((reviewer.queued ?? []).some((item) => item.id === opinion.instructionId))
    return view('waiting');
  const asked = (reviewer.asked ?? []).find((item) => item.id === opinion.instructionId);
  if (!asked) return view('delivered');
  return asked.reply ? view('replied', asked.reply, asked.repliedAt) : view('delivered');
}

export const OPINION_WORDS: Record<OpinionStatus, string> = {
  sent: 'Sent',
  waiting: 'Waiting for its next checkpoint',
  delivered: 'Delivered, no reply yet',
  replied: 'Replied',
  gone: 'Has left the office',
};
