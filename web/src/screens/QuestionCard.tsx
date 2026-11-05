// SPDX-License-Identifier: Apache-2.0
import { useState, type FormEvent } from 'react';
import { api } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import { AnswerOtherMax, type LiveAgent, type Question } from '../gen/models.ts';
import {
  allAnswered,
  chooseOther,
  emptyDrafts,
  pick,
  toAnswers,
  typeOther,
  type Draft,
} from '../office/question.ts';

/**
 * A question the agent is asking you, such as Claude Code's AskUserQuestion, with its options
 * and room for your own answer. It is calm on purpose: a question is not an approval.
 */
export function QuestionCard({ agent }: { agent: LiveAgent }) {
  const question = agent.question;
  // A new question starts with a clean form.
  return question ? <QuestionForm agent={agent} question={question} key={question.id} /> : null;
}

function QuestionForm({ agent, question }: { agent: LiveAgent; question: Question }) {
  const toast = useOfficeStore((state) => state.toast);
  const [drafts, setDrafts] = useState<Draft[]>(() => emptyDrafts(question));
  const [sending, setSending] = useState(false);
  const ready = allAnswered(drafts);
  const update = (index: number, draft: Draft) =>
    setDrafts((current) => current.map((each, at) => (at === index ? draft : each)));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || sending) return;
    setSending(true);
    api
      .answerQuestion(agent.id, question.id, toAnswers(drafts))
      .then(() => toast(`Sent your answer to ${agent.name}`))
      .catch((error: Error) => {
        toast(error.message);
        setSending(false);
      });
  };
  const many = question.items.length > 1;
  return (
    <form className="qcard" aria-labelledby={`qh-${question.id}`} onSubmit={submit}>
      <h3 id={`qh-${question.id}`}>
        {agent.name} is asking you {many ? `${question.items.length} questions` : 'a question'}
      </h3>
      {question.items.map((item, index) => {
        const draft = drafts[index]!;
        const name = `q-${question.id}-${index}`;
        const kind = item.multiSelect ? 'checkbox' : 'radio';
        return (
          <fieldset className="qset" key={name}>
            <legend>
              {item.header ? <span className="chip">{item.header}</span> : null}
              <span className="qtext">{item.question}</span>
            </legend>
            {item.multiSelect ? <span className="help">Pick any that apply.</span> : null}
            {item.options.map((option, at) => (
              <label className="radio" key={at}>
                <input
                  type={kind}
                  name={name}
                  checked={draft.picked.includes(at)}
                  onChange={() => update(index, pick(item, draft, at))}
                />
                <span>
                  <b>{option.label}</b>
                  {option.description ? (
                    <>
                      <br />
                      <span className="help">{option.description}</span>
                    </>
                  ) : null}
                </span>
              </label>
            ))}
            <div className="radio qother">
              <label>
                <input
                  type={kind}
                  name={name}
                  checked={draft.otherOn}
                  onChange={(event) =>
                    update(index, chooseOther(item, draft, event.target.checked))
                  }
                />
                <b>Other</b>
              </label>
              {/* Typing here picks Other, so the words are never left out by mistake. */}
              <input
                className="in"
                aria-label={`Your own answer to: ${item.question}`}
                placeholder="Type your own answer"
                maxLength={AnswerOtherMax}
                value={draft.other}
                onChange={(event) => update(index, typeOther(item, draft, event.target.value))}
              />
            </div>
          </fieldset>
        );
      })}
      <div className="qfoot">
        <span className="help">
          {agent.name} waits for you. If nobody answers here for a while, it asks in its own window
          instead.
        </span>
        <button type="submit" className="btn primary sm" disabled={!ready || sending}>
          {many ? 'Send answers' : 'Send answer'}
        </button>
      </div>
    </form>
  );
}
