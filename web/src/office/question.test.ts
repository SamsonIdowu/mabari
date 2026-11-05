// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { AnswerOtherMax, type Question, type QuestionItem } from '../gen/models.ts';
import { allAnswered, chooseOther, emptyDrafts, pick, toAnswers, typeOther } from './question.ts';

const single: QuestionItem = {
  question: 'Which database?',
  header: 'Database',
  multiSelect: false,
  options: [
    { label: 'Postgres', description: '' },
    { label: 'SQLite', description: '' },
  ],
};
const several: QuestionItem = {
  question: 'Which checks?',
  header: 'Checks',
  multiSelect: true,
  options: [
    { label: 'Lint', description: '' },
    { label: 'Tests', description: '' },
    { label: 'Types', description: '' },
  ],
};
const question: Question = { id: 'q1', agentId: 'a1', time: 0, items: [single, several] };

describe('answering a question', () => {
  it('starts with nothing answered', () => {
    const drafts = emptyDrafts(question);
    expect(drafts).toHaveLength(2);
    expect(allAnswered(drafts)).toBe(false);
  });

  it('swaps the answer to a question that takes one, and Other replaces it', () => {
    let draft = emptyDrafts(question)[0]!;
    draft = pick(single, draft, 0);
    draft = pick(single, draft, 1);
    expect(draft.picked).toEqual([1]);
    draft = typeOther(single, draft, 'MySQL');
    expect(draft).toEqual({ picked: [], otherOn: true, other: 'MySQL' });
    draft = pick(single, draft, 0);
    expect(draft.otherOn).toBe(false);
    expect(toAnswers([draft])).toEqual([{ picked: [0], other: '' }]);
  });

  it('toggles options on a question that takes several, keeping list order', () => {
    let draft = emptyDrafts(question)[1]!;
    draft = pick(several, draft, 2);
    draft = pick(several, draft, 0);
    draft = pick(several, draft, 1);
    draft = pick(several, draft, 1);
    draft = typeOther(several, draft, '  Docs  ');
    expect(toAnswers([draft])).toEqual([{ picked: [0, 2], other: 'Docs' }]);
    draft = chooseOther(several, draft, false);
    expect(toAnswers([draft])).toEqual([{ picked: [0, 2], other: '' }]);
  });

  it('needs every question answered, and Other needs words', () => {
    const drafts = emptyDrafts(question);
    const first = pick(single, drafts[0]!, 0);
    let second = drafts[1]!;
    expect(allAnswered([first, second])).toBe(false);
    second = chooseOther(several, second);
    expect(allAnswered([first, second])).toBe(false);
    second = typeOther(several, second, '   ');
    expect(allAnswered([first, second])).toBe(false);
    second = typeOther(several, second, 'Docs');
    expect(allAnswered([first, second])).toBe(true);
  });

  it('keeps your own words to the length the server takes', () => {
    const draft = typeOther(single, emptyDrafts(question)[0]!, 'é'.repeat(AnswerOtherMax + 5));
    expect([...draft.other]).toHaveLength(AnswerOtherMax);
  });
});
