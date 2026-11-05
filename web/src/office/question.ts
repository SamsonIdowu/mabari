// SPDX-License-Identifier: Apache-2.0
import {
  AnswerOtherMax,
  type Question,
  type QuestionAnswer,
  type QuestionItem,
} from '../gen/models.ts';

/** The person's answer to one question while they fill it in. */
export interface Draft {
  /** The options picked, by their place in the list. */
  picked: number[];
  /** "Other" is chosen, so their own words count. */
  otherOn: boolean;
  other: string;
}

export const emptyDrafts = (question: Question): Draft[] =>
  question.items.map(() => ({ picked: [], otherOn: false, other: '' }));

/** Picks an option. A question that takes one answer swaps it; one that takes several toggles. */
export function pick(item: QuestionItem, draft: Draft, index: number): Draft {
  if (!item.multiSelect) return { ...draft, picked: [index], otherOn: false };
  const picked = draft.picked.includes(index)
    ? draft.picked.filter((each) => each !== index)
    : [...draft.picked, index];
  return { ...draft, picked };
}

/** Chooses "Other". For a question that takes one answer it replaces the option picked. */
export function chooseOther(item: QuestionItem, draft: Draft, on = true): Draft {
  if (!item.multiSelect) return on ? { ...draft, picked: [], otherOn: true } : draft;
  return { ...draft, otherOn: on };
}

/** Typing your own words chooses "Other", and they are kept to the length the server takes. */
export function typeOther(item: QuestionItem, draft: Draft, text: string): Draft {
  return { ...chooseOther(item, draft), other: [...text].slice(0, AnswerOtherMax).join('') };
}

export const isAnswered = (draft: Draft): boolean =>
  draft.picked.length > 0 || (draft.otherOn && draft.other.trim() !== '');

/** Every question needs an answer before any are sent. */
export const allAnswered = (drafts: Draft[]): boolean =>
  drafts.length > 0 && drafts.every(isAnswered);

/** What the server takes: the options in list order, and the words only when "Other" is on. */
export const toAnswers = (drafts: Draft[]): QuestionAnswer[] =>
  drafts.map((draft) => ({
    picked: [...draft.picked].sort((a, b) => a - b),
    other: draft.otherOn ? draft.other.trim() : '',
  }));
