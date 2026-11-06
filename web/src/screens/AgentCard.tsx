// SPDX-License-Identifier: Apache-2.0
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import type { LiveAgent } from '../gen/models.ts';
import { costText, workedText } from '../office/cardText.ts';
import { drawPortrait, PORTRAIT } from '../office/portrait.ts';
import { providers, type ProviderName } from '../shared/tokens.ts';

/** How long the pointer rests on a name before its card shows, and how long a card lingers. */
const DWELL_MS = 320;
const GRACE_MS = 140;
const CARD = { width: 264, height: 132, gap: 8 };

function Portrait({ agent }: { agent: LiveAgent }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (context) drawPortrait(context, agent);
  }, [agent]);
  return (
    <canvas
      ref={canvas}
      width={PORTRAIT.width}
      height={PORTRAIT.height}
      className="aportrait"
      aria-hidden="true"
    />
  );
}

interface Shown {
  id: string;
  /** Where to put the card: the viewport corner of the name it belongs to, and which side. */
  left: number;
  top: number;
  below: boolean;
}

/** The card for the agent whose name is hovered or focused, a small trading card. */
function CardFor({ shown }: { shown: Shown }) {
  const agent = useOfficeStore((state) => state.office?.agents.find((item) => item.id === shown.id));
  // The numbers are the server's, asked for each time the card is wanted afresh.
  const { data: card } = useQuery({
    queryKey: ['agent-card', shown.id],
    queryFn: () => api.agentCard(shown.id),
    staleTime: 4000,
    retry: false,
  });
  if (!agent || !card) return null;
  const provider = providers[agent.provider as ProviderName] ?? providers.custom;
  return (
    <div
      className={`acard ${provider.cssClass}`}
      id="agentCard"
      role="tooltip"
      style={{
        left: shown.left,
        top: shown.top,
        transform: shown.below ? undefined : 'translateY(-100%)',
        ['--ac' as string]: agent.hue,
      }}
    >
      <div className="ahead">
        <Portrait agent={agent} />
        <div className="atitle">
          <h3>{card.name}</h3>
          <span className="arole">{card.role}</span>
        </div>
      </div>
      <dl className="acnts">
        <div className="acnt">
          <dt>Finished today</dt>
          <dd className="num">{card.finishedToday}</dd>
        </div>
        <div className="acnt">
          <dt>Worked today</dt>
          <dd className="num">{workedText(card.workedSeconds)}</dd>
        </div>
        <div className="acnt">
          <dt>{card.costBasis === 'plan' ? 'Est. at API price' : 'Est. cost'}</dt>
          <dd className="num">{costText(card)}</dd>
        </div>
      </dl>
    </div>
  );
}

/** Where a card goes for a name on the floor, below it or above if there's no room below. */
function underTag(box: DOMRect): Pick<Shown, 'left' | 'top' | 'below'> {
  const left = Math.min(
    window.innerWidth - CARD.width - CARD.gap,
    Math.max(CARD.gap, box.left + box.width / 2 - CARD.width / 2),
  );
  const below = box.bottom + CARD.gap + CARD.height < window.innerHeight;
  return { left, top: below ? box.bottom + CARD.gap : box.top - CARD.gap, below };
}

/** Where a card goes for a line in the list: beside it, on the floor's side. */
function besideRow(box: DOMRect): Pick<Shown, 'left' | 'top' | 'below'> {
  const top = Math.min(window.innerHeight - CARD.height - CARD.gap, Math.max(CARD.gap, box.top));
  return { left: Math.max(CARD.gap, box.left - CARD.width - CARD.gap), top, below: true };
}

/**
 * Hover an agent's name, on the floor or in the list, and a small card shows its portrait, role,
 * tasks finished today, time worked and estimated cost. A line in the list shows it on focus too,
 * and Escape puts it away. It takes no clicks, so it never covers a control.
 */
export function AgentCardHover() {
  const [shown, setShown] = useState<Shown | null>(null);
  useEffect(() => {
    let dwell: ReturnType<typeof setTimeout> | undefined;
    let away: ReturnType<typeof setTimeout> | undefined;
    let over: string | null = null;
    let current: Shown | null = null;
    const show = (next: Shown | null) => {
      current = next;
      setShown(next);
    };
    const hide = () => {
      clearTimeout(dwell);
      clearTimeout(away);
      over = null;
      if (current) show(null);
    };
    /** The agent whose name or line the pointer is on, and where its card goes. */
    const find = (target: EventTarget | null, x: number, y: number) => {
      const row = (target as Element | null)?.closest?.<HTMLElement>('.flrow[data-entry]');
      if (row) return { id: row.dataset.entry!, place: besideRow(row.getBoundingClientRect()) };
      if ((target as Element | null)?.id !== 'floor') return null;
      for (const tag of document.querySelectorAll<HTMLElement>('#stage [data-o]:not([hidden])')) {
        const name = tag.querySelector<HTMLElement>('.tag .nt');
        const box = name?.getBoundingClientRect();
        if (box && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
          return { id: tag.dataset.o!, place: underTag(box) };
        }
      }
      return null;
    };
    const onMove = (event: PointerEvent) => {
      if (event.buttons) return hide();
      const found = find(event.target, event.clientX, event.clientY);
      if (!found) {
        over = null;
        clearTimeout(dwell);
        if (current && !away) {
          away = setTimeout(() => {
            away = undefined;
            hide();
          }, GRACE_MS);
        }
        return;
      }
      clearTimeout(away);
      away = undefined;
      if (found.id === over) {
        // The tag moves with a walking agent, so the card follows it.
        if (current && current.id === found.id) {
          const moved =
            Math.abs(current.left - found.place.left) > 2 ||
            Math.abs(current.top - found.place.top) > 2;
          if (moved) show({ id: found.id, ...found.place });
        }
        return;
      }
      over = found.id;
      clearTimeout(dwell);
      dwell = setTimeout(() => show({ id: found.id, ...found.place }), current ? 0 : DWELL_MS);
    };
    const onFocus = (event: FocusEvent) => {
      const row = (event.target as Element | null)?.closest?.<HTMLElement>('.flrow[data-entry]');
      if (!row || !row.matches(':focus-visible')) return;
      over = row.dataset.entry!;
      // A screen reader hears the card with the line it describes.
      row.setAttribute('aria-describedby', 'agentCard');
      show({ id: over, ...besideRow(row.getBoundingClientRect()) });
    };
    const onBlur = (event: FocusEvent) => {
      const row = (event.target as Element | null)?.closest?.('.flrow[data-entry]');
      if (!row) return;
      row.removeAttribute('aria-describedby');
      hide();
    };
    const onKey = (event: KeyboardEvent) => {
      // Escape puts the card away and does nothing else, as it should for a hover.
      if (event.key === 'Escape' && current) {
        event.stopImmediatePropagation();
        hide();
      }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerdown', hide);
    document.addEventListener('wheel', hide, { passive: true });
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', onBlur);
    window.addEventListener('keydown', onKey, true);
    return () => {
      hide();
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerdown', hide);
      document.removeEventListener('wheel', hide);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', onBlur);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);
  return shown ? <CardFor shown={shown} /> : null;
}
