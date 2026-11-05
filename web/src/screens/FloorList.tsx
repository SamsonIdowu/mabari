// SPDX-License-Identifier: Apache-2.0
import { useLayoutEffect, useRef, useState } from 'react';
import type { Snapshot } from '../gen/models.ts';
import { floorGroups, type FloorEntry } from '../office/floorList.ts';
import { selectAgent, selectResting, useOfficeUi, type OfficeFilters } from '../office/uiStore.ts';

interface RowProps {
  entry: FloorEntry;
  selected: string | null;
  /** The one line Tab stops on. The arrow keys move between the others. */
  current: boolean;
  onFocus: () => void;
}

function Row({ entry, selected, current, onFocus }: RowProps) {
  const isAgent = entry.kind === 'agent';
  const on = selected === entry.id;
  const where = isAgent ? entry.where : null;
  const dim = isAgent && entry.dim;
  const red = isAgent && entry.red;
  const amber = isAgent && entry.amber;
  const queuedNote = isAgent ? entry.queuedNote : null;
  return (
    <button
      type="button"
      className={`flrow${on ? ' on' : ''}${dim ? ' dim' : ''}${red ? ' red' : ''}${amber ? ' amber' : ''}${isAgent ? '' : ' file'}`}
      data-entry={entry.id}
      tabIndex={current ? 0 : -1}
      aria-pressed={on}
      title={`${entry.name}: ${entry.detail}${queuedNote ? `, ${queuedNote}` : ''}${where ? ` (${where.name})` : ''}`}
      onFocus={onFocus}
      onClick={() => (isAgent ? selectAgent(entry.agent) : selectResting(entry.id))}
    >
      <span
        className="fldot"
        style={isAgent ? { background: entry.color } : { borderColor: entry.color }}
        aria-hidden="true"
      />
      <span className="flmain">
        <span className="fltop">
          <span className="flname">{entry.name}</span>
          {queuedNote ? <span className="flq">{queuedNote}</span> : null}
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
  const body = useRef<HTMLDivElement>(null);
  // Whether a line had focus. An agent moving to another group gets a new line, so its focus
  // is put back on the new one.
  const inside = useRef(false);
  useLayoutEffect(() => {
    const list = body.current;
    if (!list || !inside.current || !focused || list.contains(document.activeElement)) return;
    list.querySelector<HTMLButtonElement>(`.flrow[data-entry="${CSS.escape(focused)}"]`)?.focus();
  });
  const groups = floorGroups(office, filters);
  const ids = groups.flatMap((group) => group.entries.map((entry) => entry.id));
  // Tab comes back to the line last focused, else the selected agent, else the first line.
  const current = [focused, selected].find((id) => id && ids.includes(id)) ?? ids[0];
  return (
    <aside className="flist" id="floorList" aria-label="Everyone on the floor">
      <div className="flhead">
        <b>On the floor</b>
        <span className="help num">{ids.length}</span>
        <span className="sr" id="flKeys">
          Tab stops on one agent. The up and down arrow keys move between agents, and Home and End
          go to the first and last.
        </span>
      </div>
      {/* A toolbar is the pattern for one Tab stop with arrow keys inside it. */}
      <div
        className="flbody"
        role="toolbar"
        aria-label="Pick an agent"
        aria-orientation="vertical"
        aria-describedby="flKeys"
        ref={body}
        onKeyDown={moveFocus}
        onFocus={() => (inside.current = true)}
        onBlur={(event) => {
          // Focus leaving the list, not a line taken away from under it as its agent moves.
          const row = event.target;
          queueMicrotask(() => {
            inside.current =
              !row.isConnected || (body.current?.contains(document.activeElement) ?? false);
          });
        }}
      >
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
