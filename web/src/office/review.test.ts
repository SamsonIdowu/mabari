// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { ChangedFile, LiveAgent } from '../gen/models.ts';
import {
  filesText,
  lineKey,
  lineRef,
  opinionView,
  orphanComments,
  pathText,
  quoted,
  reviewText,
  statusLabel,
  useReview,
  type ReviewComment,
} from './review.ts';

const file = { path: 'src/app.ts', oldPath: '' } as ChangedFile;

describe('where a click on a line points', () => {
  it('names the new line for an added or an unchanged line, and the old one for a removed line', () => {
    expect(lineRef(file, { kind: 'add', old: 0, new: 9, text: 'nine' })).toEqual({
      path: 'src/app.ts',
      side: 'new',
      line: 9,
      text: 'nine',
    });
    expect(lineRef(file, { kind: 'ctx', old: 3, new: 4, text: 'x' })?.line).toBe(4);
    expect(lineRef(file, { kind: 'del', old: 2, new: 0, text: 'two' })).toEqual({
      path: 'src/app.ts',
      side: 'old',
      line: 2,
      text: 'two',
    });
    // Git's remark about a missing newline is not a line.
    expect(
      lineRef(file, { kind: 'note', old: 0, new: 0, text: 'No newline at end of file' }),
    ).toBeNull();
  });

  it('keys a line by its file, side and number', () => {
    const base = { path: 'a.ts', side: 'new', line: 4 } as const;
    expect(lineKey(base)).not.toBe(lineKey({ ...base, side: 'old' }));
    expect(lineKey(base)).not.toBe(lineKey({ ...base, line: 5 }));
    expect(lineKey(base)).not.toBe(lineKey({ ...base, path: 'b.ts' }));
    expect(lineKey(base)).toBe(lineKey({ ...base }));
  });
});

const comment = (patch: Partial<ReviewComment>): ReviewComment => ({
  id: 'rc-1',
  path: 'src/app.ts',
  side: 'new',
  line: 12,
  text: 'const total = sum + tax;',
  comment: 'Please move this into a helper.',
  ...patch,
});

describe('what a review becomes', () => {
  it('words one comment as a sentence with the file, the line and the code', () => {
    expect(reviewText([comment({})], '~/code/shop')).toBe(
      'Review comment on src/app.ts, line 12 (`const total = sum + tax;`): Please move this into a helper.',
    );
  });

  it('says when the comment is on a line that was removed', () => {
    expect(
      reviewText([comment({ side: 'old', line: 7, text: 'return sum;' })], '~/code/shop'),
    ).toBe(
      'Review comment on src/app.ts, line 7 of the old version (removed: `return sum;`): Please move this into a helper.',
    );
  });

  it('puts several comments in one numbered instruction, keeping a comment s own lines together', () => {
    const text = reviewText(
      [
        comment({}),
        comment({
          id: 'rc-2',
          path: 'db/schema.prisma',
          line: 3,
          text: '',
          comment: 'Why a string?\nIt should be an enum.',
        }),
      ],
      '~/code/shop',
    );
    expect(text).toBe(
      [
        'Review of the changes in ~/code/shop. 2 comments:',
        '1. src/app.ts, line 12 (`const total = sum + tax;`): Please move this into a helper.',
        '2. db/schema.prisma, line 3: Why a string?',
        '   It should be an enum.',
      ].join('\n'),
    );
  });

  it('never starts with a slash or a dash, so it cannot be taken for a command', () => {
    for (const text of [
      reviewText([comment({ comment: '/ux-audit this' })], '~/x'),
      reviewText([comment({}), comment({ id: 'rc-2' })], '~/x'),
      reviewText([comment({ path: '-rf', comment: '--help' })], '~/x'),
    ]) {
      expect(text).toMatch(/^Review/);
    }
  });

  it('quotes a long line cut short, and a line with backticks without breaking the quote', () => {
    expect(quoted('`a`')).toBe("'a'");
    const long = quoted('x'.repeat(200));
    expect([...long]).toHaveLength(80);
    expect(long.endsWith('…')).toBe(true);
    expect(quoted('   indented   ')).toBe('indented');
    // Cut by characters, not bytes: an accent or an emoji is not split.
    expect(quoted('é'.repeat(100))).toBe(`${'é'.repeat(79)}…`);
    expect(quoted('😀'.repeat(100))).toBe(`${'😀'.repeat(79)}…`);
  });
});

describe('words on the page', () => {
  it('calls a new file new, whether Git knows it or not', () => {
    expect(statusLabel('untracked')).toBe('New');
    expect(statusLabel('added')).toBe('New');
    expect(statusLabel('modified')).toBe('Modified');
    expect(statusLabel('something else')).toBe('something else');
  });

  it('counts files and shows a rename with where it was', () => {
    expect(filesText(1)).toBe('1 file');
    expect(filesText(0)).toBe('0 files');
    expect(filesText(7)).toBe('7 files');
    expect(pathText({ path: 'b.ts', oldPath: 'a.ts' })).toBe('a.ts → b.ts');
    expect(pathText({ path: 'b.ts', oldPath: '' })).toBe('b.ts');
  });
});

const reviewer = (patch: Partial<LiveAgent>): LiveAgent =>
  ({ id: 'cc-quill', name: 'Quill', queued: [], asked: [], ...patch }) as LiveAgent;

describe('where a second opinion stands', () => {
  const opinion = { reviewerId: 'cc-quill', instructionId: 'ins-1', at: 1 };

  it('follows the instruction from waiting to delivered to answered', () => {
    const waiting = reviewer({ queued: [{ id: 'ins-1' }] as LiveAgent['queued'] });
    expect(opinionView(opinion, [waiting]).status).toBe('waiting');
    const delivered = reviewer({ asked: [{ id: 'ins-1', reply: '' }] as LiveAgent['asked'] });
    expect(opinionView(opinion, [delivered]).status).toBe('delivered');
    const replied = reviewer({
      asked: [{ id: 'ins-1', reply: 'Looks fine.', repliedAt: 9 }] as LiveAgent['asked'],
    });
    expect(opinionView(opinion, [replied])).toEqual({
      name: 'Quill',
      status: 'replied',
      reply: 'Looks fine.',
      repliedAt: 9,
    });
  });

  it('takes only the reply to its own request', () => {
    const other = reviewer({
      asked: [
        { id: 'ins-9', reply: 'An answer to something else.', repliedAt: 3 },
      ] as LiveAgent['asked'],
    });
    expect(opinionView(opinion, [other]).reply).toBe('');
  });

  it('says so when the reviewer has left, and when it was sent with no way to follow it', () => {
    expect(opinionView(opinion, []).status).toBe('gone');
    expect(opinionView({ ...opinion, instructionId: '' }, [reviewer({})]).status).toBe('sent');
  });
});

describe('comments whose line has left the diff', () => {
  const changed = {
    path: 'src/app.ts',
    oldPath: '',
    hunks: [
      {
        header: '@@ -1,2 +1,2 @@',
        lines: [
          { kind: 'del', old: 1, new: 0, text: 'two' },
          { kind: 'add', old: 0, new: 1, text: 'TWO' },
          { kind: 'ctx', old: 2, new: 2, text: 'three' },
        ],
      },
    ],
  } as unknown as ChangedFile;

  it('are the ones with no line in the diff now, and the others stay under their line', () => {
    const here = comment({ id: 'a', line: 1, text: 'TWO' });
    const kept = comment({ id: 'b', side: 'old', line: 1, text: 'two' });
    const moved = comment({ id: 'c', line: 40 });
    const away = comment({ id: 'd', path: 'src/other.ts', line: 1, text: 'TWO' });
    // The same number on the other side of the file is another line.
    const otherSide = comment({ id: 'e', side: 'old', line: 2, text: 'three' });
    // The line is still there, but holds other words than the ones the comment was about.
    const reworded = comment({ id: 'f', line: 1, text: 'TWO, as it was' });
    expect(
      orphanComments([changed], [here, kept, moved, away, otherSide, reworded]).map(
        (item) => item.id,
      ),
    ).toEqual(['c', 'd', 'e', 'f']);
    expect(orphanComments([], [here]).map((item) => item.id)).toEqual(['a']);
    expect(orphanComments([changed], [])).toEqual([]);
  });
});

describe('the comments waiting to be sent', () => {
  it('keeps them by what is being reviewed, and lets each go or all go', () => {
    const { addComment, removeComment, clearComments } = useReview.getState();
    addComment('agent:a', comment({ id: 'rc-1' }));
    addComment('agent:a', comment({ id: 'rc-2' }));
    addComment('project:p', comment({ id: 'rc-3' }));
    expect(useReview.getState().comments['agent:a']?.map((item) => item.id)).toEqual([
      'rc-1',
      'rc-2',
    ]);
    removeComment('agent:a', 'rc-1');
    expect(useReview.getState().comments['agent:a']?.map((item) => item.id)).toEqual(['rc-2']);
    clearComments('agent:a');
    expect(useReview.getState().comments['agent:a']).toEqual([]);
    expect(useReview.getState().comments['project:p']).toHaveLength(1);
  });
});
