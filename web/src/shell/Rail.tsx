// SPDX-License-Identifier: Apache-2.0
import { Fragment } from 'react';
import type { Route } from '../routes.ts';
import { Icon } from './Icon.tsx';
import { navGroups, type NavItem } from './navItems.tsx';

function NavLink({ item, current }: { item: NavItem; current: Route }) {
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
      {item.badge === 'needs' ? (
        <span className="badge" hidden>
          0
        </span>
      ) : null}
      {item.badge === 'live' ? (
        <span className="badge amber" hidden>
          live
        </span>
      ) : null}
    </a>
  );
}

export function Rail({ current }: { current: Route }) {
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
