// SPDX-License-Identifier: Apache-2.0
import { Fragment, useEffect, useState } from 'react';
import { useOfficeStore } from '../data/officeStore.ts';
import type { Route } from '../routes.ts';
import { Icon } from './Icon.tsx';
import { navGroups, type NavItem } from './navItems.tsx';

const LIVE_MS = 6000;

function NeedsBadge() {
  const count = useOfficeStore(
    (state) =>
      state.office?.agents.filter((agent) => agent.state === 'approval' || agent.state === 'error')
        .length ?? 0,
  );
  return count ? <span className="badge">{count}</span> : null;
}

function LiveBadge() {
  const last = useOfficeStore((state) => state.office?.messages.at(-1)?.time ?? 0);
  const [live, setLive] = useState(false);
  useEffect(() => {
    const check = () => setLive(Date.now() - last < LIVE_MS);
    check();
    const timer = setInterval(check, 1000);
    return () => clearInterval(timer);
  }, [last]);
  return live ? <span className="badge amber">live</span> : null;
}

function NavLink({ item, current }: { item: NavItem; current: Route | null }) {
  const isCurrent = item.route === current;
  return (
    <a
      className={isCurrent ? 'nav on' : 'nav'}
      href={`#${item.route}`}
      title={item.title ?? item.label}
      aria-label={item.name}
      aria-current={isCurrent ? 'page' : undefined}
    >
      <Icon>{item.icon}</Icon>
      <span className="lbl">{item.label}</span>
      {item.badge === 'needs' ? <NeedsBadge /> : null}
      {item.badge === 'live' ? <LiveBadge /> : null}
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
