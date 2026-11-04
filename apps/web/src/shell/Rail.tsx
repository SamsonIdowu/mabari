import type { Route } from '../routes.ts';
import { BrandMark } from './BrandMark.tsx';
import { Icon } from './Icon.tsx';
import { LocalStatus } from './LocalStatus.tsx';
import { mainNav, secondaryNav, type NavItem } from './navItems.tsx';
import { RailToggle } from './RailToggle.tsx';
import { ThemeButton } from './ThemeButton.tsx';

function NavLink({ item, current }: { item: NavItem; current: Route }) {
  const isCurrent = item.route === current;
  return (
    <a
      className={isCurrent ? 'nav on' : 'nav'}
      href={`#${item.route}`}
      title={item.label}
      aria-current={isCurrent ? 'page' : undefined}
    >
      <Icon>{item.icon}</Icon>
      <span className="lbl">{item.label}</span>
    </a>
  );
}

export function Rail({ current }: { current: Route }) {
  return (
    <aside className="rail" aria-label="Main">
      <div className="brand">
        <BrandMark />
        <span>Mabari</span>
      </div>
      {mainNav.map((item) => (
        <NavLink key={item.route} item={item} current={current} />
      ))}
      <div style={{ height: 10 }} />
      {secondaryNav.map((item) => (
        <NavLink key={item.route} item={item} current={current} />
      ))}
      <div className="railfoot">
        <RailToggle />
        <ThemeButton />
        <LocalStatus />
      </div>
    </aside>
  );
}
