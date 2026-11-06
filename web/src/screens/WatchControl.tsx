// SPDX-License-Identifier: Apache-2.0
import { useState, type FormEvent } from 'react';
import { api } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import type { Snapshot, Watch, WatchKind } from '../gen/models.ts';
import { chainsFor, tellable, watchOf } from '../office/watches.ts';

const fail = (error: Error) => useOfficeStore.getState().toast(error.message);

/** What a pending instruction says, short enough for a line in a panel. */
const quoted = (text: string) => `“${text.length > 60 ? `${text.slice(0, 59)}…` : text}”`;

/**
 * "Tell me when it's done": a quiet switch on an agent's panel and on a project's card. On, the
 * server watches, and tells you once with a toast, a line in Home's chat and, if you turned them
 * on, a desktop notification. Beside it a "Then…" field can name another agent to tell when the
 * work is done. It goes the way any instruction goes, so what that agent does next still needs
 * your click, and it is never sent after an error. All of it lives on the server, so a reload
 * shows it as it was.
 */
export function WatchControl({
  office,
  kind,
  target,
  name,
  compact = false,
}: {
  office: Snapshot;
  kind: WatchKind;
  target: string;
  name: string;
  /** On a card: the Then field opens from a button, to leave the list its room. */
  compact?: boolean;
}) {
  const watch = watchOf(office.watches, kind, target);
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  // What the switch was just turned to, until the server has answered. The watch itself is the
  // server's, so the switch goes back to what the server says if it refuses or can't be reached.
  const [turned, setTurned] = useState<boolean | null>(null);
  const id = `watch-${kind}-${target}`;
  const noun = kind === 'project' ? 'project' : 'agent';

  const turn = (on: boolean) => {
    setNote('');
    setTurned(on);
    const settled = () => setTurned(null);
    if (!on) {
      if (watch) void api.cancelWatch(watch.id).catch(fail).finally(settled);
      else settled();
      return;
    }
    void api
      .setWatch({ kind, target })
      // Already finished: nothing to wait for, so the switch stays off and this says why.
      .then((result) => setNote(result.watch ? '' : result.text))
      .catch(fail)
      .finally(settled);
  };

  // On a card there is no room for the sentence, so it is only read aloud, unless there is
  // something to say: that the work has already finished.
  const quiet = compact && !note;
  return (
    <div className="watch" data-watching={watch ? 'yes' : 'no'}>
      <div className="watchrow">
        <label className="switch" htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={turned ?? Boolean(watch)}
            aria-describedby={`${id}-help`}
            onChange={(event) => turn(event.target.checked)}
          />
          Tell me when it&apos;s done
        </label>
        {compact && !open ? (
          <button
            type="button"
            className="linkbtn watchmore"
            aria-expanded={false}
            onClick={() => setOpen(true)}
          >
            {watch?.then ? 'Change what comes next' : 'Then tell another agent…'}
          </button>
        ) : null}
      </div>
      <span className={quiet ? 'help sr' : 'help'} id={`${id}-help`} role="status">
        {watch
          ? kind === 'project'
            ? `Watching. You will be told once, when every agent on ${name} has finished.`
            : `Watching. You will be told once, when ${name} is done or stops with an error.`
          : note ||
            (kind === 'project'
              ? 'Mabari tells you once, calmly, when every agent on this project has finished.'
              : `Mabari tells you once, calmly, when this ${noun} is done.`)}
      </span>
      {watch?.then ? <Pending watch={watch} /> : null}
      {!compact || open ? (
        <ThenForm
          office={office}
          kind={kind}
          target={target}
          name={name}
          onNote={setNote}
          after={compact ? () => setOpen(false) : undefined}
        />
      ) : null}
    </div>
  );
}

/** The instruction a watch will pass on, with a way to cancel it that keeps the watch. */
function Pending({ watch }: { watch: Watch }) {
  const then = watch.then;
  if (!then) return null;
  return (
    <p className="watchthen" data-testid="watchThen">
      <span>
        Then tell <b>{then.agentName}</b> {quoted(then.text)}
      </span>
      <button
        type="button"
        className="linkbtn"
        aria-label={`Cancel telling ${then.agentName} ${quoted(then.text)}`}
        title="Cancel what comes next. You are still told when it's done."
        onClick={() => void api.cancelWatchThen(watch.id).catch(fail)}
      >
        Cancel
      </button>
    </p>
  );
}

/** "Then…": the agent to tell, and what to tell it. Setting it also starts the watch. */
function ThenForm({
  office,
  kind,
  target,
  name,
  onNote,
  after,
}: {
  office: Snapshot;
  kind: WatchKind;
  target: string;
  name: string;
  onNote: (text: string) => void;
  after: (() => void) | undefined;
}) {
  const others = tellable(office.agents, kind, target);
  const [who, setWho] = useState('');
  const [text, setText] = useState('');
  const id = `then-${kind}-${target}`;
  if (others.length === 0) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const said = text.trim();
    if (!who || !said) return;
    void api
      .setWatch({ kind, target, then: { agentId: who, text: said } })
      .then((result) => {
        setText('');
        setWho('');
        onNote(result.watch ? '' : result.text);
        after?.();
      })
      .catch(fail);
  };
  return (
    <form
      className="thenform"
      autoComplete="off"
      onSubmit={submit}
      aria-label={`Then, after ${name}`}
    >
      <label className="sr" htmlFor={`${id}-who`}>
        Then tell
      </label>
      <select
        id={`${id}-who`}
        className="in"
        value={who}
        onChange={(event) => setWho(event.target.value)}
      >
        <option value="">Then tell…</option>
        {others.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
      <label className="sr" htmlFor={`${id}-text`}>
        What to tell it
      </label>
      <input
        id={`${id}-text`}
        className="in"
        value={text}
        placeholder="…to review it"
        maxLength={2000}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" className="btn sm" disabled={!who || !text.trim()}>
        Add
      </button>
    </form>
  );
}

/**
 * On the panel of an agent that a watch will tell something to: what it will be told and when, with
 * a way to cancel it. Nothing shows when no watch is waiting on its way to this agent.
 */
export function WatchesWaiting({ office, agentId }: { office: Snapshot; agentId: string }) {
  const chains = chainsFor(office.watches, agentId);
  if (!chains.length) return null;
  return (
    <div className="sect watch" data-testid="watchesWaiting">
      <h3>Told when another agent is done</h3>
      {chains.map((watch) => (
        <p className="watchthen" key={watch.id}>
          <span>
            {quoted(watch.then?.text ?? '')} once {watch.name} is done
          </span>
          <button
            type="button"
            className="linkbtn"
            aria-label={`Cancel being told ${quoted(watch.then?.text ?? '')} after ${watch.name}`}
            onClick={() => void api.cancelWatchThen(watch.id).catch(fail)}
          >
            Cancel
          </button>
        </p>
      ))}
    </div>
  );
}
