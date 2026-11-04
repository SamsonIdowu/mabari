// SPDX-License-Identifier: Apache-2.0
import { BrandMark } from './BrandMark.tsx';
import { LocalStatus } from './LocalStatus.tsx';
import { RailToggle } from './RailToggle.tsx';
import { ThemeButton } from './ThemeButton.tsx';

export function Topbar() {
  return (
    <header className="topbar">
      <RailToggle />
      <a className="brandmark" href="#office" aria-label="Mabari, go to the office">
        <BrandMark />
        <span className="bm-name">Mabari</span>
      </a>
      <div className="topright">
        <LocalStatus />
        <ThemeButton />
      </div>
    </header>
  );
}
