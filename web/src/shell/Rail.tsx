// SPDX-License-Identifier: Apache-2.0
import { Fragment, useEffect, useState } from 'react';
import { useOfficeStore } from '../data/officeStore.ts';
import { needsTone, whoNeedsYou } from '../office/uiStore.ts';
import { useVee } from '../office/veeStore.ts';
import type { Route } from '../routes.ts';
import { Icon } from './Icon.tsx';
import { navGroups, type NavItem } from './navItems.tsx';
import { useRailStore } from './railStore.ts';

const LIVE_MS = 6000;

/** Everyone who needs you, by the one definition every count uses. Red only when an approval or an
 * error waits; a question alone is calm. */
function NeedsBadge() {
  const count = useOfficeStore((state) => whoNeedsYou(state.office?.agents ?? []).length);
  const tone = useOfficeStore((state) => needsTone(whoNeedsYou(state.office?.agents ?? [])));
  if (!count) return null;
  // A screen reader would say "Agents 2". The digits are for the eye, and the words follow the
  // link's name, so it reads "Agents, 2 need you".
  return (
    <>
      <span className={tone === 'red' ? 'badge' : `badge ${tone}`} aria-hidden="true">
        {count}
      </span>
      <span className="sr">
        , {count} {count === 1 ? 'needs' : 'need'} you
      </span>
    </>
  );
}

/** Replies Mabari relayed while you were on another page. */
function UnreadBadge() {
  const unread = useVee((state) => state.unread);
  if (!unread) return null;
  return (
    <>
      <span className="badge" aria-hidden="true">
        {unread > 9 ? '9+' : unread}
      </span>
      <span className="sr">
        , {unread} new {unread === 1 ? 'reply' : 'replies'}
      </span>
    </>
  );
}

/** True for a few seconds after agents last talked, for the Chats link's "live" badge. */
function useLive() {
  const last = useOfficeStore((state) => state.office?.messages.at(-1)?.time ?? 0);
  const [live, setLive] = useState(false);
  useEffect(() => {
    const check = () => setLive(Date.now() - last < LIVE_MS);
    check();
    const timer = setInterval(check, 1000);
    return () => clearInterval(timer);
  }, [last]);
  return live;
}

/** The visible label must be part of the name, for people who speak to their computer. While
 * the "live" badge shows, the link's own text names it, so the badge is part of the name too. */
function linkName(item: NavItem, live: boolean) {
  if (live || !item.name) return undefined;
  return item.name.toLowerCase().includes(item.label.toLowerCase())
    ? item.name
    : `${item.label}, ${item.name.toLowerCase()}`;
}

function NavLink({ item, current }: { item: NavItem; current: Route | null }) {
  const isCurrent = item.route === current;
  const live = useLive() && item.badge === 'live';
  const collapsed = useRailStore((state) => state.collapsed);
  return (
    <a
      className={isCurrent ? 'nav on' : 'nav'}
      href={`#${item.route}`}
      title={item.title ?? item.label}
      aria-label={linkName(item, live)}
      aria-current={isCurrent ? 'page' : undefined}
    >
      <Icon>{item.icon}</Icon>
      <span className="lbl">{item.label}</span>
      {/* Collapsed, the label is hidden. A link is named from what is inside it, so with a badge
          showing it would be just "2", or "live". This keeps its name for a screen reader. */}
      {collapsed ? <span className="sr">{item.label}</span> : null}
      {item.badge === 'needs' ? <NeedsBadge /> : null}
      {/* Neutral, not amber: amber means a queued instruction, and only red and amber ask for attention. */}
      {live ? <span className="badge calm">live</span> : null}
      {item.badge === 'unread' ? <UnreadBadge /> : null}
    </a>
  );
}

export function Rail({ current }: { current: Route | null }) {
  return (
    <aside className="rail" aria-label="Main">
      {navGroups.map((group, index) => (
        <Fragment key={group.name}>
          {index > 0 ? <div className="navsep" role="separator" /> : null}
          <nav className="navgroup" aria-label={group.name}>
            {group.items.map((item) => (
              <NavLink key={item.route} item={item} current={current} />
            ))}
          </nav>
        </Fragment>
      ))}
    </aside>
  );
}
