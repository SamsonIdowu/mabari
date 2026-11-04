// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { useOfficeStore } from '../data/officeStore.ts';
import { clipWords, promptCards, type PromptCard } from '../office/relay.ts';
import { usePromptTray, type QueryCard } from '../office/trayStore.ts';
import { Icon } from '../shell/Icon.tsx';

/** A query card hides after this long, as in the prototype. */
const QUERY_SHOWN_MS = 12000;
/** A card shows the start of a long reply. The agent's panel has all of it. */
const CARD_REPLY = 220;

const STATUS_LABEL = {
  queued: 'Waiting for its next checkpoint',
  thinking: 'Thinking',
  replied: 'Replied',
  answered: 'Answered from the log',
};

type Shown = (PromptCard & { query?: false }) | (QueryCard & { status: 'answered'; query: true });

function colourOf(provider: string) {
  if (provider === 'claude') return 'var(--claude)';
  if (provider === 'openai') return 'var(--openai)';
  return 'var(--custom)';
}

/** Ticks once a second while cards are showing, so replied cards hide on time. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * Every prompt sent to an agent gets a card at the bottom right of the floor: who it went to,
 * which AI, its status, then the AI's reply. Instructions read "Mabari → Ledger", queries
 * "Asked Ledger".
 */
export function PromptTray() {
  const agents = useOfficeStore((state) => state.office?.agents ?? []);
  const { queries, dismissed, dismiss } = usePromptTray();
  const busy =
    agents.some((agent) => agent.queued?.length || agent.asked?.length) || queries.length > 0;
  const now = useNow(busy);
  const shown: Shown[] = [
    ...promptCards(agents, now, dismissed),
    ...queries
      .filter((query) => now - query.at < QUERY_SHOWN_MS && !dismissed.has(query.id))
      .map((query) => ({ ...query, status: 'answered' as const, query: true as const })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 3);
  return (
    <div className="ptray" id="promptTray" aria-live="polite">
      {shown.map((card) => (
        <div
          key={card.id}
          className={`ptcard st-${card.status}`}
          style={{ ['--pc' as string]: colourOf(card.provider) }}
        >
          <div className="pthead">
            <span className="ptto">
              {card.query ? 'Asked ' : 'Mabari → '}
              <b>{card.agentName}</b> <span className="muted">{card.ai}</span>
            </span>
            <span className="ptst">
              {card.status === 'thinking' ? (
                <span className="dots">
                  <i />
                  <i />
                  <i />
                </span>
              ) : null}
              {STATUS_LABEL[card.status]}
            </span>
            <button
              type="button"
              className="ptx"
              aria-label="Dismiss"
              onClick={() => dismiss(card.id)}
            >
              <Icon>
                <path d="M6 6l12 12M18 6 6 18" />
              </Icon>
            </button>
          </div>
          <div className="ptq">{card.text}</div>
          {card.reply ? <div className="ptr">{clipWords(card.reply, CARD_REPLY)}</div> : null}
        </div>
      ))}
    </div>
  );
}
