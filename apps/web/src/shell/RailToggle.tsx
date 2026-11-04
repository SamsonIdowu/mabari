import { Icon } from './Icon.tsx';
import { useRailStore } from './railStore.ts';

export function RailToggle() {
  const collapsed = useRailStore((state) => state.collapsed);
  const toggle = useRailStore((state) => state.toggle);
  const name = collapsed ? 'Expand menu' : 'Collapse menu';

  return (
    <button
      type="button"
      className="btn ghost"
      style={{ justifyContent: 'flex-start' }}
      aria-label={name}
      aria-expanded={!collapsed}
      title={name}
      onClick={toggle}
    >
      <Icon>
        <path d={collapsed ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6'} />
      </Icon>
      <span className="lbl">Collapse menu</span>
    </button>
  );
}
