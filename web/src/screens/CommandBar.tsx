// SPDX-License-Identifier: Apache-2.0
import { useRef, useState, type FormEvent } from 'react';
import type { Snapshot } from '../gen/models.ts';
import { send } from '../office/send.ts';
import { useOfficeUi } from '../office/uiStore.ts';
import { Icon } from '../shell/Icon.tsx';
import { LATER } from './parts.tsx';

function TeamAnswer() {
  const answer = useOfficeUi((state) => state.teamAnswer);
  const set = useOfficeUi((state) => state.set);
  if (!answer) return null;
  return (
    <div className="popover">
      <div className="answer" style={{ background: 'var(--surface)', boxShadow: 'var(--shadow)' }}>
        <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="chip query">Answered from the log</span>
          <button type="button" className="btn ghost sm" onClick={() => set({ teamAnswer: null })}>
            Close
          </button>
        </span>
        <span className="q">{answer.question}</span>
        {answer.lines.map((line) => (
          <span key={line.name}>
            <b>{line.name}</b>: {line.state}, {line.estimate}.{' '}
            <span className="muted">{line.task}</span>
          </span>
        ))}
        <span className="help">No agent was interrupted.</span>
      </div>
    </div>
  );
}

export function CommandBar({ office }: { office: Snapshot }) {
  const mode = useOfficeUi((state) => state.mode);
  const target = useOfficeUi((state) => state.target);
  const selectedId = useOfficeUi((state) => state.selected);
  const set = useOfficeUi((state) => state.set);
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const instruct = mode === 'instruct';
  const selected = office.agents.find((agent) => agent.id === selectedId);
  const auto = target === 'auto' || (target === 'selected' && !selected);
  const named = office.agents.find((agent) => agent.id === target) ?? selected;
  const who = target === 'everyone' ? 'everyone' : auto ? 'the team' : (named?.name ?? 'an agent');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const message = text.trim();
    if (!message) {
      input.current?.focus();
      return;
    }
    setText('');
    const destination = auto ? 'auto' : target === 'selected' ? (selected?.id ?? 'auto') : target;
    void send(message, mode, destination, office);
  };

  return (
    <div className="cmdbar" style={{ position: 'relative' }}>
      <TeamAnswer />
      <form className="cmdrow" autoComplete="off" onSubmit={submit}>
        <div className="seg modeseg" role="group" aria-label="Message type">
          <button
            type="button"
            className={instruct ? 'ins on' : 'ins'}
            aria-pressed={instruct}
            onClick={() => set({ mode: 'instruct' })}
          >
            <Icon>
              <path d="M4 12h12M12 6l6 6-6 6" />
            </Icon>
            Instruct
          </button>
          <button
            type="button"
            className={instruct ? 'qry' : 'qry on'}
            aria-pressed={!instruct}
            onClick={() => set({ mode: 'query' })}
          >
            <Icon>
              <path d="M9 9a3 3 0 1 1 4 2.8c-.6.3-1 .9-1 1.6V14M12 18h.01" />
            </Icon>
            Query
          </button>
        </div>
        <div className={instruct ? 'cmdin' : 'cmdin qry'}>
          <label className="sr" htmlFor="cmdText">
            Message
          </label>
          <input
            id="cmdText"
            ref={input}
            value={text}
            placeholder={
              instruct
                ? `Tell ${who} what to do`
                : `Ask what ${who} is doing. Answered from the log`
            }
            onChange={(event) => setText(event.target.value)}
          />
          <label className="sr" htmlFor="cmdTarget">
            Send to
          </label>
          <select
            id="cmdTarget"
            className="in"
            style={{
              width: 'auto',
              minHeight: 32,
              borderRadius: 8,
              padding: '2px 8px',
              fontSize: 13,
              fontWeight: 700,
            }}
            value={target}
            onChange={(event) => {
              const value = event.target.value;
              const agent = office.agents.find((item) => item.id === value);
              set(agent ? { target: value, selected: agent.id } : { target: value });
            }}
          >
            <option value="auto">Auto dispatch</option>
            <option value="selected">
              {selected ? `Selected: ${selected.name}` : 'Selected agent (none)'}
            </option>
            {office.agents.map((agent) => (
              <option value={agent.id} key={agent.id}>
                {agent.name}
              </option>
            ))}
            <option value="everyone">Everyone</option>
          </select>
        </div>
        <button type="button" className="mic" aria-label="Hold to talk" disabled title={LATER}>
          <Icon>
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </Icon>
        </button>
        <button type="submit" className={`btn sendbtn ${instruct ? 'ins' : 'qry'}`}>
          {instruct ? 'Send instruction' : 'Ask'}
        </button>
      </form>
      <div className="note">
        Instruct puts your message into the agent&apos;s session and it acts on it. Query reads
        Mabari&apos;s own log and never interrupts the agent. Hold the mic (or Space) to talk; you get
        2 seconds to cancel.
      </div>
    </div>
  );
}
