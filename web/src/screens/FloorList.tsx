// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import type { Snapshot } from '../gen/models.ts';
import { openRestingFile } from '../office/builderStore.tsx';
import { floorGroups, type FloorEntry } from '../office/floorList.ts';
import { selectAgent, useOfficeUi, type OfficeFilters } from '../office/uiStore.ts';

interface RowProps {
  entry: FloorEntry;
  selected: string | null;
  /** The one line Tab stops on. The arrow keys move between the others. */
  current: boolean;
  onFocus: () => void;
}

function Row({ entry, selected, current, onFocus }: RowProps) {
  const isAgent = entry.kind === 'agent';
  const on = isAgent && selected === entry.id;
  const where = isAgent ? entry.where : null;
  const dim = isAgent && entry.dim;
  return (
    <button
      type="button"
      className={`flrow${on ? ' on' : ''}${dim ? ' dim' : ''}${isAgent ? '' : ' file'}`}
      data-entry={entry.id}
      tabIndex={current ? 0 : -1}
      aria-pressed={isAgent ? on : undefined}
      title={`${entry.name}: ${entry.detail}${where ? ` (${where.name})` : ''}`}
      onFocus={onFocus}
      onClick={() => (isAgent ? selectAgent(entry.agent) : openRestingFile(entry.def.id))}
    >
      <span
        className="fldot"
        style={isAgent ? { background: entry.color } : { borderColor: entry.color }}
        aria-hidden="true"
      />
      <span className="flmain">
        <span className="fltop">
          <span className="flname">{entry.name}</span>
          {where ? (
            <span className="flwhere">
              <i style={{ background: where.color }} aria-hidden="true" />
              {where.name}
            </span>
          ) : null}
        </span>
        <span className="fldet">{entry.detail}</span>
      </span>
    </button>
  );
}

const STEPS: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };

/** Up and down move between lines, Home and End go to the first and last. */
function moveFocus(event: React.KeyboardEvent<HTMLDivElement>) {
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.flrow')];
  const at = rows.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0 || !rows.length) return;
  let next: number;
  if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = rows.length - 1;
  else if (STEPS[event.key]) next = Math.min(rows.length - 1, Math.max(0, at + STEPS[event.key]!));
  else return;
  event.preventDefault();
  rows[next]!.focus();
}

/**
 * Everyone on the floor, beside it: agents who need you, agents at their desks, and the lounge.
 * Clicking a line does what clicking that character on the floor does.
 */
export function FloorList({ office, filters }: { office: Snapshot; filters: OfficeFilters }) {
  const selected = useOfficeUi((state) => state.selected);
  const [focused, setFocused] = useState<string | null>(null);
  const groups = floorGroups(office, filters);
  const ids = groups.flatMap((group) => group.entries.map((entry) => entry.id));
  // Tab comes back to the line last focused, else the selected agent, else the first line.
  const current = [focused, selected].find((id) => id && ids.includes(id)) ?? ids[0];
  return (
    <aside className="flist" id="floorList" aria-label="Everyone on the floor">
      <div className="flhead">
        <b>On the floor</b>
        <span className="help num">{ids.length}</span>
      </div>
      <div className="flbody" onKeyDown={moveFocus}>
        {groups.map((group) => (
          <div
            className={`flgroup fl-${group.id}`}
            key={group.id}
            role="group"
            aria-labelledby={`fl-${group.id}`}
          >
            <div className="mhead" id={`fl-${group.id}`}>
              <span>{group.label}</span>
              <span className="num">{group.entries.length}</span>
            </div>
            {group.entries.map((entry) => (
              <Row
                key={entry.id}
                entry={entry}
                selected={selected}
                current={entry.id === current}
                onFocus={() => setFocused(entry.id)}
              />
            ))}
          </div>
        ))}
        {ids.length ? null : <p className="help flempty">Nobody is on the floor in this view.</p>}
      </div>
    </aside>
  );
}
