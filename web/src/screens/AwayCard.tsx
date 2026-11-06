// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, useSyncExternalStore } from 'react';
import { cardShown, useAway } from '../data/away.ts';
import { catchUp, recapGroups } from '../data/catchUp.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import { minsText } from '../format.ts';
import type { LiveAgent, Recap } from '../gen/models.ts';
import { floorCounts } from '../office/floorList.ts';
import { counted, needsYou, openAgent } from '../office/uiStore.ts';
import '../styles/catchup.css';

function openAgentById(id: string) {
  const agents = useOfficeStore.getState().office?.agents ?? [];
  const agent = agents.find((item) => item.id === id);
  if (agent) openAgent(agent, agents);
}

/**
 * What happened, as lists with a link to each agent still here. Every number comes from the
 * server; the page only words them. A long list is cut and says by how many.
 */
export function RecapBody({ recap }: { recap: Recap }) {
  // Only an approval or an error waiting makes the count red; a question waits calmly.
  const red = useOfficeStore((state) => {
    const agents = state.office?.agents ?? [];
    return floorCounts(counted(agents)).tone === 'red';
  });
  return (
    <div className="recap">
      {recapGroups(recap)
        .filter(({ group }) => group.count > 0)
        .map(({ key, title, group }) => (
          <section className="recapgroup" key={key} data-group={key}>
            <h3>
              {title}{' '}
              <span className={key === 'needs' && red ? 'recapcount red' : 'recapcount'}>
                {group.count}
              </span>
            </h3>
            <ul className="hclist">
              {group.items.map((item, index) => (
                <li key={`${item.agentId}-${item.time}-${index}`}>
                  {item.hue ? (
                    <span className="idot" style={{ ['--ac' as string]: item.hue }} />
                  ) : null}
                  {item.agentId ? (
                    <button
                      type="button"
                      className="linkbtn"
                      onClick={() => openAgentById(item.agentId)}
                    >
                      {item.agent}
                    </button>
                  ) : (
                    <b>{item.agent}</b>
                  )}
                  <span className="recaptext" title={item.text}>
                    {item.text}
                  </span>
                </li>
              ))}
              {group.count > group.items.length ? (
                <li className="muted">and {group.count - group.items.length} more</li>
              ) : null}
            </ul>
          </section>
        ))}
    </div>
  );
}

/** The ids of everyone who needs you, so the card is read again when that changes. */
function needsKey(agents: LiveAgent[] | undefined): string {
  return (agents ?? [])
    .filter(needsYou)
    .map((agent) => agent.id)
    .sort()
    .join(',');
}

/** Where the card sits above Mabari instead of beside it, and has room for little. */
const NARROW = '(max-width: 1100px)';

/**
 * The card folded down to what it says in one line: how many of each kind, in the order of the
 * lists, with the count of what needs you red only when an approval or an error waits. The rows
 * are a tap away.
 */
function RecapSummary({ recap }: { recap: Recap }) {
  const red = useOfficeStore((state) => {
    const agents = state.office?.agents ?? [];
    return floorCounts(counted(agents)).tone === 'red';
  });
  return (
    <p className="recapsum" data-testid="recapsum">
      {recapGroups(recap)
        .filter(({ group }) => group.count > 0)
        .map(({ key, title, group }) => (
          <span key={key}>
            {title}{' '}
            <span className={key === 'needs' && red ? 'recapcount red' : 'recapcount'}>
              {group.count}
            </span>
          </span>
        ))}
    </p>
  );
}

function useNarrow(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(NARROW);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => window.matchMedia(NARROW).matches,
  );
}

/**
 * "While you were away": a calm card on Home after the person comes back from at least 15
 * minutes. It shows only when something happened, and stays dismissed for that absence.
 */
export function AwayCard() {
  const absence = useAway((state) => state.absence);
  const dismiss = useAway((state) => state.dismiss);
  const ready = useOfficeStore((state) => state.office !== null);
  const waiting = useOfficeStore((state) => needsKey(state.office?.agents));
  const [recap, setRecap] = useState<Recap | null>(null);
  // Narrow, the card is a line of counts and opens out to every row on request, so it is never cut
  // off in the middle of a row, and never crowds Mabari's speech bubble or the buttons under it.
  const narrow = useNarrow();
  const [opened, setOpened] = useState(false);
  const from = absence?.from;
  const to = absence?.to;
  const dismissed = absence?.dismissed ?? false;

  // Read when there is an absence to tell, and again when who needs you changes, so the last
  // list on the card is never one that has already been dealt with.
  useEffect(() => {
    if (from === undefined || to === undefined || dismissed || !ready) return undefined;
    let current = true;
    catchUp
      .recap(from, to)
      .then((found) => current && setRecap(found))
      .catch(() => current && setRecap(null));
    return () => {
      current = false;
    };
  }, [from, to, dismissed, ready, waiting]);

  if (!absence || !recap || recap.since !== absence.from || !cardShown(absence, recap.happened)) {
    return null;
  }
  const folded = narrow && !opened;
  return (
    <aside
      className="awaycard"
      aria-labelledby="awayTitle"
      data-testid="away-card"
      data-open={narrow && opened ? 'yes' : undefined}
    >
      <div className="awayhead">
        <h2 id="awayTitle">
          While you were away{' '}
          <span className="muted">· {minsText((recap.until - recap.since) / 1000)}</span>
        </h2>
        <button type="button" className="btn sm ghost" onClick={dismiss}>
          Dismiss
        </button>
      </div>
      {folded ? <RecapSummary recap={recap} /> : <RecapBody recap={recap} />}
      {narrow ? (
        <button
          type="button"
          className="btn sm awaymore"
          aria-expanded={opened}
          onClick={() => setOpened(!opened)}
        >
          {opened ? 'Hide details' : 'Show details'}
        </button>
      ) : null}
    </aside>
  );
}
