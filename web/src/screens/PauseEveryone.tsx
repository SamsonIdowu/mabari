// SPDX-License-Identifier: Apache-2.0
// Pause everyone, in the Agents header: pauses every working agent in the view after a
// confirmation, and afterwards becomes Continue everyone, which carries on the agents that pause
// stopped and nobody else. It can never approve or answer anything: the server leaves agents that
// wait on you exactly as they are.
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import type { LiveAgent, Snapshot } from '../gen/models.ts';
import {
  groupFrom,
  keepOnly,
  modelScope,
  namesShown,
  pausable,
  pauseNotes,
  stillStopped,
  usePauseGroup,
  viewScope,
  waitingOnYou,
} from '../office/pauseAll.ts';
import { useOfficeUi, type OfficeFilters } from '../office/uiStore.ts';
import { Icon } from '../shell/Icon.tsx';
import { Modal } from '../shell/Modal.tsx';
import { useEscape } from '../shell/useEscape.ts';

const agentsText = (n: number) => `${n} ${n === 1 ? 'agent' : 'agents'}`;

function PauseDialog(props: {
  office: Snapshot;
  filters: OfficeFilters;
  targets: LiveAgent[];
  close: () => void;
}) {
  const { office, filters, targets, close } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEscape(close);
  // If everyone it was about stops working while it is open, there is nothing left to confirm.
  const nobody = targets.length === 0;
  useEffect(() => {
    if (nobody) close();
  }, [nobody, close]);
  const scope = viewScope(office, filters);
  const narrowed = modelScope(filters);
  const waiting = waitingOnYou(office.agents, filters);
  const notes = pauseNotes(targets);
  // The header counts an agent with an instruction queued under Queued, not Working. It is working,
  // so it pauses, and the count here says so rather than seeming one more than the header.
  const queued = targets.filter((agent) => agent.queued.length > 0).length;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    api
      .pauseEveryone(targets.map((agent) => agent.id))
      .then((reply) => {
        usePauseGroup.getState().remember(groupFrom(reply));
        close();
      })
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
        setBusy(false);
      });
  };

  return (
    <Modal>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pauseTitle"
        autoComplete="off"
        onSubmit={submit}
      >
        <div className="dhd">
          <div>
            <h2 id="pauseTitle" style={{ fontSize: 20 }}>
              Pause everyone in {scope}?
            </h2>
            <p className="help" style={{ marginTop: 2 }}>
              {targets.length === 1
                ? '1 working agent will pause'
                : `${targets.length} working agents will pause`}
              {narrowed ? ` (${narrowed})` : ''}
              {queued ? `, ${queued} with an instruction queued` : ''}. Continue everyone brings
              back the ones this pause stopped.
            </p>
          </div>
          <button type="button" className="btn ghost sm" aria-label="Close" onClick={close}>
            <Icon>
              <path d="M6 6l12 12M18 6 6 18" />
            </Icon>
          </button>
        </div>
        <p id="pauseNames" style={{ fontWeight: 700 }}>
          {namesShown(targets.map((agent) => agent.name))}
        </p>
        <p className="help" id="pauseWaiting">
          {waiting.length
            ? `${namesShown(
                waiting.map((agent) => agent.name),
                4,
              )} ${waiting.length === 1 ? 'is' : 'are'} waiting on you, and stay${waiting.length === 1 ? 's' : ''} waiting. `
            : ''}
          Pausing never approves or answers anything.
        </p>
        {notes.map((note) => (
          <div className="banner" key={note} role="note">
            <Icon>
              <path d="M12 8v5M12 16h.01" />
              <circle cx="12" cy="12" r="9" />
            </Icon>
            <span className="grow">{note}</span>
          </div>
        ))}
        {error ? (
          <p role="alert" style={{ color: 'var(--red)', fontWeight: 700 }} className="help">
            {error}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Pausing…' : `Pause ${agentsText(targets.length)}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The button in the Agents header, and its confirmation. One button changes its words rather than
 * two taking each other's place, so focus stays on it while it changes.
 */
export function PauseEveryone({ office }: { office: Snapshot }) {
  const project = useOfficeUi((state) => state.project);
  const provider = useOfficeUi((state) => state.provider);
  const model = useOfficeUi((state) => state.model);
  const status = useOfficeUi((state) => state.status);
  const team = useOfficeUi((state) => state.team);
  const filters: OfficeFilters = { project, provider, model, status, team };
  const group = usePauseGroup((state) => state.group);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useOfficeStore((state) => state.toast);

  const stopped = stillStopped(group, office.agents);
  const targets = pausable(office.agents, filters);
  const stoppedKey = stopped.join(',');
  const kept = group.stopped.length + group.asked.length;
  // An agent that was continued by hand, finished or left drops out of the pause for good, so one
  // paused by hand again later is not carried on with the rest. Once nothing of the pause is left
  // the button goes back to Pause everyone.
  useEffect(() => {
    const { group: now, remember } = usePauseGroup.getState();
    const next = keepOnly(now, stoppedKey ? stoppedKey.split(',') : []);
    if (next.stopped.length + next.asked.length !== now.stopped.length + now.asked.length) {
      remember(next);
    }
  }, [stoppedKey, kept]);

  const carryOn = () => {
    setBusy(true);
    api
      .continueEveryone(stopped)
      .then(() => usePauseGroup.getState().forget())
      .catch((failure: unknown) => toast(failure instanceof Error ? failure.message : 'Try again'))
      .finally(() => setBusy(false));
  };

  const continuing = stopped.length > 0;
  const title = continuing
    ? `Carry on the ${agentsText(stopped.length)} the last pause stopped`
    : targets.length
      ? `Pause the ${agentsText(targets.length)} working in this view. You confirm first.`
      : 'Nobody in this view is working';
  return (
    <>
      <button
        type="button"
        className={continuing ? 'btn primary' : 'btn'}
        id="pauseAll"
        title={title}
        disabled={continuing ? busy : !targets.length}
        onClick={continuing ? carryOn : () => setConfirming(true)}
      >
        <Icon>
          <path d={continuing ? 'M7 5l11 7-11 7z' : 'M9 5v14M15 5v14'} />
        </Icon>
        {continuing ? 'Continue everyone' : 'Pause everyone'}
      </button>
      {confirming ? (
        <PauseDialog
          office={office}
          filters={filters}
          targets={targets}
          close={() => setConfirming(false)}
        />
      ) : null}
    </>
  );
}
