// SPDX-License-Identifier: Apache-2.0
import { useThemeStore } from '../theme/themeStore.ts';
import { Icon } from './Icon.tsx';

export function ThemeButton() {
  const theme = useThemeStore((state) => state.theme);
  const toggle = useThemeStore((state) => state.toggle);
  const isDark = theme === 'dark';

  return (
    <button type="button" className="tbtn" title="Switch theme" onClick={toggle}>
      <Icon>
        <path
          d={
            isDark
              ? 'M12 3v2M12 19v2M5 5l1.4 1.4M17.6 17.6 19 19M3 12h2M19 12h2M5 19l1.4-1.4M17.6 6.4 19 5'
              : 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z'
          }
        />
      </Icon>
      <span className="lbl">{isDark ? 'Light' : 'Dark'}</span>
    </button>
  );
}
