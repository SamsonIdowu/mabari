// SPDX-License-Identifier: Apache-2.0
// The quick switcher: Ctrl K or Command K opens a search box over any screen. Type to jump to an
// agent, a project or a screen, or to run a plain action. What it can find comes from the sources
// registered in switcher.ts, so a new kind of result needs nothing here.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useOfficeStore } from '../data/officeStore.ts';
import { isQuiet, useLayers } from '../office/layers.ts';
import { openAgent, useOfficeUi } from '../office/uiStore.ts';
import { useVee } from '../office/veeStore.ts';
import { useVoice } from '../office/voiceStore.ts';
import { useThemeStore } from '../theme/themeStore.ts';
import { Icon } from './Icon.tsx';
import { Modal } from './Modal.tsx';
import { focusPanel, openDialogList } from './modalStack.ts';
import {
  boxUsesKey,
  countText,
  flatten,
  isSwitcherKey,
  onMac,
  search,
  shortcutText,
  stepIndex,
  type KeyTarget,
  type SwitcherContext,
  type SwitcherResult,
} from './switcher.ts';
// Registers the kinds of result that ship with Mabari.
import './switcherSources.ts';
import '../chat/conversationsSource.ts';
import { useSwitcher } from './switcherStore.ts';
import { useEscape } from './useEscape.ts';

const NOT_TEXT = new Set([
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'range',
  'color',
  'file',
  'image',
]);

/** What the key was pressed in, for boxUsesKey. */
function describeTarget(target: EventTarget | null): KeyTarget {
  if (!(target instanceof HTMLElement)) return { claimed: false, textField: false };
  return {
    claimed: target.isContentEditable || target.closest('[data-uses-ctrl-k]') !== null,
    textField:
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement && !NOT_TEXT.has(target.type)),
  };
}

/**
 * Ctrl K or Command K toggles the switcher, from any screen. It stays out of a box that uses the key
 * (see boxUsesKey), out of the way of another dialog, whose page behind it is out of reach, and of
 * push to talk while it is listening. Space is never touched: nothing here reads it outside the
 * switcher's own box.
 */
function useShortcut() {
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!isSwitcherKey(event) || event.defaultPrevented || event.isComposing) return;
      const { open, show, hide } = useSwitcher.getState();
      // The switcher's own box has no use for the key, so it closes from inside it.
      if (open) {
        event.preventDefault();
        if (!event.repeat) hide();
        return;
      }
      if (boxUsesKey(describeTarget(event.target), event, onMac())) return;
      // Push to talk is on Home's mic or the floor's card, and either is listening or confirming.
      const talking = useVoice.getState().phase !== null || useVee.getState().listening;
      if (openDialogList().length > 0 || talking) return;
      event.preventDefault();
      if (!event.repeat) show();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** What the sources are given: the office, and what the plain actions do. */
function useSwitcherContext(): SwitcherContext {
  const office = useOfficeStore((state) => state.office);
  const quietOn = useLayers((state) => isQuiet(state.layers));
  const theme = useThemeStore((state) => state.theme);
  return useMemo(
    () => ({
      office,
      openAgent: (agent) => openAgent(agent, office?.agents ?? []),
      controls: {
        quietOn,
        theme,
        toggleQuiet: () => useLayers.getState().quiet(),
        toggleTheme: () => useThemeStore.getState().toggle(),
        newAgent: () => {
          // In a project's view the new agent starts in that project, as the header's button does.
          const ui = useOfficeUi.getState();
          ui.set({ newAgent: ui.project === 'all' ? {} : { project: ui.project } });
        },
        newProject: () => useOfficeUi.getState().set({ newProject: true }),
      },
    }),
    [office, quietOn, theme],
  );
}

const SEARCH = 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3';
const ARROW = 'M5 12h14M13 6l6 6-6 6';
const BOLT = 'M13 3 4 14h7l-1 7 9-11h-7z';

const optionId = (result: SwitcherResult) => `qs-${result.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;

function Mark({ result }: { result: SwitcherResult }) {
  if (result.glyph) {
    return (
      <span
        className={result.glyph === 'dot' ? 'qsmark dot' : 'qsmark'}
        style={{ background: result.color ?? 'var(--muted)' }}
        aria-hidden="true"
      />
    );
  }
  return (
    <span className="qsmark icon" aria-hidden="true">
      <Icon>
        <path d={result.href ? ARROW : BOLT} />
      </Icon>
    </span>
  );
}

function Option(props: {
  result: SwitcherResult;
  active: boolean;
  choose: (result: SwitcherResult) => void;
  point: (result: SwitcherResult) => void;
}) {
  const { result, active, choose, point } = props;
  const body = (
    <>
      <Mark result={result} />
      <span className="qsmain">
        <span className="qsname">{result.label}</span>
        {result.detail ? <span className="qsdet">{result.detail}</span> : null}
      </span>
      {result.chip ? (
        <span className={result.chip.tone ? `chip ${result.chip.tone}` : 'chip'}>
          {result.chip.text}
        </span>
      ) : null}
    </>
  );
  const common = {
    id: optionId(result),
    role: 'option',
    'aria-selected': active,
    tabIndex: -1,
    className: active ? 'qsrow on' : 'qsrow',
    // Only a mouse that moved chooses a row. A list scrolling under a still mouse, as it does for the
    // arrow keys, must not take the choice back.
    onMouseMove: (event: MouseEvent) => {
      if (event.movementX !== 0 || event.movementY !== 0) point(result);
    },
  } as const;
  // A result that opens a page is that page's own link, so it can be copied or opened in a new
  // tab. A plain click or Enter goes through the switcher, which closes first.
  if (result.href) {
    return (
      <a
        {...common}
        href={result.href}
        onClick={(event: MouseEvent) => {
          if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
          event.preventDefault();
          choose(result);
        }}
      >
        {body}
      </a>
    );
  }
  return (
    <div {...common} onClick={() => choose(result)}>
      {body}
    </div>
  );
}

function Dialog() {
  const hide = useSwitcher((state) => state.hide);
  const context = useSwitcherContext();
  const [query, setQuery] = useState('');
  // The result the arrows are on, by id, so it stays put when the list changes under it.
  const [chosen, setChosen] = useState<string | null>(null);
  const groups = useMemo(() => search(context, query), [context, query]);
  const results = flatten(groups);
  const at = Math.max(
    0,
    results.findIndex((result) => result.id === chosen),
  );
  const active = results[at];
  useEscape(hide);
  // Focus goes to the box once the dialog has made the page behind it inert. That has to come
  // after, or the control that opened it, losing focus to the inert page, takes it back to the page.
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus({ preventScroll: true }), []);

  const activeDomId = active ? optionId(active) : undefined;
  useEffect(() => {
    if (activeDomId) document.getElementById(activeDomId)?.scrollIntoView({ block: 'nearest' });
  }, [activeDomId]);

  const choose = (result: SwitcherResult) => {
    hide();
    // After the dialog has closed and focus has gone back, so a dialog an action opens remembers
    // the control that was in use, and the address changes under the page, not under a dialog.
    window.setTimeout(() => {
      if (result.run) result.run();
      else if (result.href) window.location.hash = result.href;
      // An agent's panel opens beside the page, so focus has to be taken there. A dialog takes it.
      requestAnimationFrame(() => {
        if (!openDialogList().length) focusPanel();
      });
    }, 0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = stepIndex(at, results.length, event.key === 'ArrowDown' ? 1 : -1);
      setChosen(results[next]?.id ?? null);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (active) choose(active);
    }
  };

  return (
    <Modal>
      <div className="dialog qs" role="dialog" aria-modal="true" aria-labelledby="qsTitle">
        <h2 id="qsTitle" className="sr">
          Jump to
        </h2>
        <div className="qsbar">
          <Icon>
            <path d={SEARCH} />
          </Icon>
          <input
            id="qsInput"
            className="qsin"
            type="text"
            role="combobox"
            aria-label="Jump to an agent, project, screen or action"
            aria-describedby="qsHelp"
            aria-autocomplete="list"
            aria-expanded={results.length > 0}
            {...(results.length ? { 'aria-controls': 'qsList' } : {})}
            {...(activeDomId ? { 'aria-activedescendant': activeDomId } : {})}
            placeholder="Jump to an agent, project, screen or action…"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            ref={field}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setChosen(null);
            }}
            onKeyDown={onKeyDown}
          />
          <button type="button" className="btn ghost sm" aria-label="Close" onClick={hide}>
            <Icon>
              <path d="M6 6l12 12M18 6 6 18" />
            </Icon>
          </button>
        </div>
        <p className="sr" id="qsHelp">
          Type to search. The up and down arrow keys move through the results, Enter opens one, and
          Escape closes this.
        </p>
        {results.length ? (
          <div className="qslist" id="qsList" role="listbox" aria-label="Results">
            {groups.map((group) => (
              <div key={group.id} role="group" aria-labelledby={`qsg-${group.id}`}>
                <div className="mhead" id={`qsg-${group.id}`}>
                  {group.heading}
                </div>
                {group.results.map((result) => (
                  <Option
                    key={result.id}
                    result={result}
                    active={result.id === active?.id}
                    choose={choose}
                    point={(entry) => setChosen(entry.id)}
                  />
                ))}
              </div>
            ))}
          </div>
        ) : (
          <p className="help qsnone">Try a name, a project or a screen.</p>
        )}
        <div className="qsfoot">
          <span className="help num" role="status">
            {countText(results.length, query)}
          </span>
          <span className="help" aria-hidden="true">
            ↑ ↓ move · Enter open · Esc close
          </span>
        </div>
      </div>
    </Modal>
  );
}

/** Mounted once, in the shell: listens for the shortcut and draws the dialog while it is open. */
export function QuickSwitcher() {
  useShortcut();
  const open = useSwitcher((state) => state.open);
  return open ? <Dialog /> : null;
}

/** The button in the top bar, for people who reach for the mouse and as the shortcut's hint. */
export function SwitcherButton() {
  const show = useSwitcher((state) => state.show);
  const key = shortcutText();
  return (
    <button
      type="button"
      className="tbtn jump"
      aria-haspopup="dialog"
      title={`Jump to an agent, project or screen (${key})`}
      onClick={show}
    >
      <Icon>
        <path d={SEARCH} />
      </Icon>
      <span className="lbl">Jump to</span>
      <kbd className="kbd" aria-hidden="true">
        {key}
      </kbd>
    </button>
  );
}
