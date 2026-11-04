// SPDX-License-Identifier: Apache-2.0
import { Icon } from './Icon.tsx';
import { LocalStatus } from './LocalStatus.tsx';
import { RailToggle } from './RailToggle.tsx';
import { ThemeButton } from './ThemeButton.tsx';

export function Topbar() {
  return (
    <header className="topbar">
      <RailToggle />
      <a className="brandmark" href="#home" aria-label="Mabari, go home">
        <span className="bm-name">Mabari</span>
      </a>
      <div className="topright">
        <LocalStatus />
        <label className="tbtn" title="Show notes that explain interactions">
          <input
            type="checkbox"
            id="notesToggle"
            className="sr"
            onChange={(event) => document.body.classList.toggle('notes', event.target.checked)}
          />
          <Icon>
            <path d="M4 4h16v12H8l-4 4z" />
            <path d="M8 9h8M8 12h5" />
          </Icon>
          <span className="lbl">Notes</span>
        </label>
        <ThemeButton />
      </div>
    </header>
  );
}
