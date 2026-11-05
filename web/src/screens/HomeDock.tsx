// SPDX-License-Identifier: Apache-2.0
// Home's dock, as in design/mabari-prototype.html: a row of round buttons under Mabari for the
// project, typing, the mic, spoken replies and gestures. The mic is push to talk, and locks on
// like Snapchat: hold it for 2 s while a ring fills, or swipe up past 60 px, and it keeps
// listening until it is tapped again.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { api } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import { useOfficeUi } from '../office/uiStore.ts';
import { GESTURE_LABELS } from '../office/vee.ts';
import { listen, type Listener } from '../office/speech.ts';
import { useVee, VEE_HELLO } from '../office/veeStore.ts';
import { Icon } from '../shell/Icon.tsx';
import { useEscape } from '../shell/useEscape.ts';

/** Holding the mic this long locks it on. */
export const LOCK_HOLD_MS = 2000;
/** Swiping up this far from where the press started locks it on. */
export const SWIPE_LOCK_PX = 60;
/** A press shorter than this is a tap, which only shows how the mic works. */
export const TAP_MS = 350;
/** A locked mic gives up after this long, sending nothing, so it is never left listening. */
export const LOCKED_MAX_MS = 2 * 60 * 1000;
/** The Type field grows with what is typed, up to this many pixels. */
const BOX_MAX_PX = 120;

const toast = (text: string) => useOfficeStore.getState().toast(text);

/** The mic's states, as the dock shows them. */
export interface Mic {
  listening: boolean;
  locked: boolean;
  /** The press is held and the ring is filling. */
  pressing: boolean;
  /** Released, and waiting for the engine's final text, as Local Whisper takes a moment. */
  sending: boolean;
  heard: string;
}

const IDLE: Mic = { listening: false, locked: false, pressing: false, sending: false, heard: '' };

/**
 * Hold the mic, or Space when not typing, to talk to Mabari. Speech stays on this computer.
 * Releasing sends what was heard, unless the mic was locked on: then tapping it sends, and Esc
 * cancels without sending. Each session has its own number, so a late event from one that was
 * cancelled can't end the next.
 */
function useHomeMic() {
  const [mic, setMic] = useState<Mic>(IDLE);
  const listener = useRef<Listener | null>(null);
  const heard = useRef('');
  const session = useRef(0);
  const active = useRef(false);
  const locked = useRef(false);
  const sending = useRef(false);
  const press = useRef<{ at: number; y: number; timer: number; started: boolean } | null>(null);
  const limit = useRef(0);
  const update = (patch: Partial<Mic>) => setMic((current) => ({ ...current, ...patch }));

  /** Ends the session, everywhere it shows. */
  const reset = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
    window.clearTimeout(limit.current);
    active.current = false;
    locked.current = false;
    sending.current = false;
    listener.current = null;
    heard.current = '';
    useVee.getState().setListening(false);
    setMic(IDLE);
  };

  const finish = useRef<(id: number) => void>(() => {});
  // Set after each render, as it reads state through refs only.
  useEffect(() => {
    finish.current = (id) => {
      if (!active.current || id !== session.current) return;
      const text = heard.current.trim();
      reset();
      if (!text) {
        useVee.getState().say({
          ...VEE_HELLO,
          text: "I didn't catch that. Hold the mic and try again.",
          gesture: 'shrug',
        });
        return;
      }
      void useVee.getState().hear(text);
    };
  });

  /** Starts a session, and reports whether one is running: the engine may refuse at once. */
  const start = (): boolean => {
    if (active.current) return !sending.current;
    session.current += 1;
    const id = session.current;
    active.current = true;
    heard.current = '';
    useVee.getState().setListening(true);
    update({ listening: true, heard: '' });
    const current = listen(
      {
        onText: (text) => {
          if (id !== session.current) return;
          heard.current = text;
          update({ heard: text });
        },
        onError: (message) => {
          if (id !== session.current) return;
          toast(message);
          cancel();
        },
        onEnd: () => finish.current(id),
      },
      useOfficeStore.getState().office?.settings.voiceEngine,
    );
    if (id === session.current && active.current) listener.current = current;
    return id === session.current && active.current;
  };
  /** Stops listening and sends. The text is final once the engine ends, which for Local Whisper
   * is after it has turned the recording into text. */
  const send = () => {
    if (!active.current || sending.current) return;
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
    window.clearTimeout(limit.current);
    locked.current = false;
    sending.current = true;
    update({ locked: false, pressing: false, sending: true });
    if (listener.current) listener.current.stop();
    else finish.current(session.current);
  };
  /** Stops listening and sends nothing. */
  const cancel = () => {
    const current = listener.current;
    const was = active.current;
    session.current += 1;
    reset();
    if (was) current?.abort();
  };
  const lock = () => {
    if (!active.current || locked.current || sending.current) return;
    locked.current = true;
    if (press.current) window.clearTimeout(press.current.timer);
    window.clearTimeout(limit.current);
    limit.current = window.setTimeout(() => {
      if (!locked.current) return;
      cancel();
      toast('The mic turned off after 2 minutes. Nothing was sent.');
    }, LOCKED_MAX_MS);
    update({ locked: true, pressing: false });
  };

  const down = (event: PointerEvent) => {
    // Only the main button: a right click opens the menu, which takes the release.
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    if (sending.current) return;
    if (locked.current && active.current) {
      send();
      return;
    }
    const started = !active.current;
    if (!start()) return;
    press.current = {
      at: Date.now(),
      y: event.clientY,
      timer: window.setTimeout(lock, LOCK_HOLD_MS),
      started,
    };
    update({ pressing: true });
  };
  /** The padlock locks the mic on directly, or unlocks it and sends. */
  const toggleLock = () => {
    if (sending.current) return;
    if (locked.current && active.current) {
      send();
      return;
    }
    if (start()) lock();
  };

  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      if (press.current && press.current.y - event.clientY > SWIPE_LOCK_PX) lock();
    };
    const up = () => {
      const held = press.current;
      if (!held) return;
      window.clearTimeout(held.timer);
      press.current = null;
      update({ pressing: false });
      if (locked.current) return;
      if (Date.now() - held.at < TAP_MS) {
        // A tap only explains; it never throws away a session it didn't start.
        if (held.started) cancel();
        toast('Hold the mic to talk, or swipe up to lock it on.');
        return;
      }
      send();
    };
    /** The browser took the pointer, say to scroll: nothing is sent unless the mic is locked. */
    const lost = () => {
      if (!press.current) return;
      if (!locked.current) cancel();
      else {
        window.clearTimeout(press.current.timer);
        press.current = null;
        update({ pressing: false });
      }
    };
    /** Leaving the page loses the Space or pointer release, so an unlocked mic stops unsent. */
    const away = (event: Event) => {
      if (event.type === 'visibilitychange' && document.visibilityState !== 'hidden') return;
      if (active.current && !locked.current && !sending.current) cancel();
    };
    const keyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && active.current && !sending.current) {
        cancel();
        return;
      }
      if (event.code !== 'Space' || event.repeat || active.current) return;
      const focused = document.activeElement as HTMLElement | null;
      if (focused?.id === 'hcText' && (focused as HTMLTextAreaElement).value) return;
      const dock = focused?.id === 'hcMic' || focused?.id === 'hcLock';
      if (
        focused &&
        !dock &&
        focused.id !== 'hcText' &&
        /INPUT|TEXTAREA|SELECT|BUTTON/.test(focused.tagName)
      )
        return;
      event.preventDefault();
      start();
    };
    const keyUp = (event: globalThis.KeyboardEvent) => {
      if (event.code !== 'Space' || !active.current) return;
      event.preventDefault();
      if (!locked.current && !press.current) send();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', lost);
    window.addEventListener('blur', away);
    document.addEventListener('visibilitychange', away);
    window.addEventListener('keydown', keyDown, true);
    window.addEventListener('keyup', keyUp, true);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', lost);
      window.removeEventListener('blur', away);
      document.removeEventListener('visibilitychange', away);
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('keyup', keyUp, true);
    };
  });
  // Leaving Home stops listening, and sends nothing.
  useEffect(
    () => () => {
      const current = listener.current;
      session.current += 1;
      if (press.current) window.clearTimeout(press.current.timer);
      window.clearTimeout(limit.current);
      active.current = false;
      current?.abort();
      useVee.getState().setListening(false);
    },
    [],
  );
  return { mic, down, toggleLock };
}

function GestureMenu({ close }: { close: () => void }) {
  const play = useVee((state) => state.play);
  useEscape(close);
  return (
    <div className="menu up" id="gestMenu">
      <div className="gmhead">Gestures</div>
      {GESTURE_LABELS.map(([name, label]) => (
        <button
          type="button"
          className="mi"
          key={name}
          onClick={() => {
            play(name);
            close();
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Which project Home's messages go to: one project, or all of them for Mabari to pick from. */
function ProjectMenu({ close }: { close: () => void }) {
  const projects = useOfficeStore((state) => state.office?.projects ?? []).filter(
    (project) => !project.done,
  );
  const picked = useVee((state) => state.project);
  const setProject = useVee((state) => state.setProject);
  useEscape(close);
  const choose = (id: string, name: string) => {
    setProject(id);
    close();
    toast(id ? `Instructions now go to ${name}.` : 'Mabari will pick the project.');
  };
  const all = !projects.some((project) => project.id === picked);
  return (
    <div className="menu up" id="homeProjMenu">
      <div className="gmhead">Send to project</div>
      <button
        type="button"
        className={all ? 'mi on' : 'mi'}
        aria-pressed={all}
        onClick={() => choose('', '')}
      >
        <span className="pdot" style={{ background: 'var(--fg2)' }} />
        All projects <span className="muted">· Mabari picks</span>
      </button>
      {projects.map((project) => (
        <button
          type="button"
          key={project.id}
          className={picked === project.id ? 'mi on' : 'mi'}
          aria-pressed={picked === project.id}
          onClick={() => choose(project.id, project.name)}
        >
          <span className="pdot" style={{ background: project.color }} />
          {project.name}
        </button>
      ))}
      <button
        type="button"
        className="mi"
        onClick={() => {
          close();
          useOfficeUi.getState().set({ newProject: true });
        }}
      >
        + New project
      </button>
    </div>
  );
}

/**
 * The compact field Type shows above the dock. Enter sends; Esc hides it. It stays on the page
 * while hidden, as in the prototype, so a draft survives hiding it.
 */
function TypeField({ shown, hide }: { shown: boolean; hide: () => void }) {
  const hear = useVee((state) => state.hear);
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = box.current;
    if (!field || !shown) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, BOX_MAX_PX)}px`;
  }, [text, shown]);
  useEffect(() => {
    if (shown) box.current?.focus();
  }, [shown]);
  const send = () => {
    const message = text.trim();
    if (!message) return;
    setText('');
    void hear(message);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      hide();
    } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    send();
  };
  return (
    <form className="h2type" id="hcForm" autoComplete="off" onSubmit={submit} hidden={!shown}>
      <label className="sr" htmlFor="hcText">
        Message Mabari
      </label>
      <textarea
        id="hcText"
        ref={box}
        rows={1}
        placeholder="Type to Mabari"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKey}
      />
      <button type="submit" className="h2send" aria-label="Send" title="Send (Enter)">
        <Icon>
          <path d="M5 12h14M13 6l6 6-6 6" />
        </Icon>
      </button>
    </form>
  );
}

/**
 * The ring that fills round the mic while it is held, 2 s to lock. It sits beside the mic's
 * circle, not in it, so the listening pulse doesn't fade it.
 */
function MicRing() {
  return (
    <svg className="micring" viewBox="0 0 80 80" aria-hidden="true">
      <circle cx="40" cy="40" r="37" pathLength="100" />
    </svg>
  );
}

export function HomeDock({ spoken }: { spoken: boolean }) {
  const [typing, setTyping] = useState(false);
  const [menu, setMenu] = useState<'project' | 'gestures' | null>(null);
  const heardLast = useVee((state) => state.heard);
  const picked = useVee((state) => state.project);
  const project = useOfficeStore((state) =>
    state.office?.projects.find((item) => item.id === picked && !item.done),
  );
  const { mic, down, toggleLock } = useHomeMic();
  const toggleVoice = () => {
    if (spoken) window.speechSynthesis?.cancel();
    void api.updateSettings({ spokenReplies: !spoken });
  };
  const micLabel = mic.sending
    ? 'Sending…'
    : mic.listening
      ? mic.locked
        ? 'Tap to send'
        : 'Listening…'
      : 'Hold to talk';
  // Buttons the mic uses keep focus off, so Space stays push to talk and never clicks them.
  const keepFocus = (event: React.MouseEvent) => event.preventDefault();
  const said = mic.listening ? mic.heard || 'Listening…' : heardLast;
  return (
    <div className={mic.pressing ? 'h2bottom pressing' : 'h2bottom'}>
      {said ? (
        <div className="yousaid" id="youSaid">
          {said}
        </div>
      ) : null}
      <TypeField shown={typing} hide={() => setTyping(false)} />
      <div className="h2dock" role="toolbar" aria-label="Talk to Mabari">
        <div className="ddwrap">
          <button
            type="button"
            className="dkbtn"
            id="homeProjBtn"
            aria-expanded={menu === 'project'}
            title="Which project is this for?"
            onClick={() => setMenu(menu === 'project' ? null : 'project')}
          >
            <span
              className="dkic"
              id="homeProjDot"
              style={{ ['--pjc' as string]: project ? project.color : 'var(--fg2)' }}
            >
              <Icon>
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </Icon>
            </span>
            <span className="dklbl" id="homeProjLbl">
              {project ? project.name : 'All projects'}
            </span>
          </button>
          {menu === 'project' ? <ProjectMenu close={() => setMenu(null)} /> : null}
        </div>
        <button
          type="button"
          className="dkbtn"
          id="hcType"
          aria-pressed={typing}
          title="Type a message"
          onClick={() => setTyping(!typing)}
        >
          <span className="dkic">
            <Icon>
              <path d="M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M7 14h10" />
            </Icon>
          </span>
          <span className="dklbl">Type</span>
        </button>
        <div className={mic.pressing ? 'micwrap pressing' : 'micwrap'}>
          <button
            type="button"
            className="miclock"
            id="hcLock"
            aria-pressed={mic.locked}
            aria-label={mic.locked ? 'Unlock and send' : 'Lock the mic on'}
            title={mic.locked ? 'Unlock and send' : 'Lock the mic on'}
            onMouseDown={keepFocus}
            onClick={toggleLock}
          >
            <Icon>
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </Icon>
          </button>
          <span className="micup" aria-hidden="true">
            <Icon>
              <path d="M12 19V5M6 11l6-6 6 6" />
            </Icon>
          </span>
          <button
            type="button"
            className={`dkbtn dkmain${mic.listening ? ' on' : ''}${mic.locked ? ' locked' : ''}`}
            id="hcMic"
            aria-pressed={mic.listening}
            title="Hold to talk, or swipe up to lock it on (Space works too)"
            onPointerDown={down}
            onMouseDown={keepFocus}
            onContextMenu={keepFocus}
          >
            {mic.pressing ? <MicRing /> : null}
            <span className="dkic">
              <Icon>
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
              </Icon>
            </span>
            <span className="dklbl">{micLabel}</span>
          </button>
        </div>
        <button
          type="button"
          className="dkbtn"
          id="hcVoiceOut"
          aria-pressed={spoken}
          title={spoken ? 'Mabari speaks replies: on' : 'Mabari speaks replies: off'}
          onClick={toggleVoice}
        >
          <span className="dkic">
            <Icon>
              <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
            </Icon>
          </span>
          <span className="dklbl" id="voiceLbl">
            {spoken ? 'Voice on' : 'Voice off'}
          </span>
        </button>
        <div className="ddwrap">
          <button
            type="button"
            className="dkbtn"
            aria-expanded={menu === 'gestures'}
            title="Gestures"
            onClick={() => setMenu(menu === 'gestures' ? null : 'gestures')}
          >
            <span className="dkic">
              <Icon>
                <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11.5v-2a1.5 1.5 0 0 1 3 0V12M14 10.5a1.5 1.5 0 0 1 3 0V12M17 11.5a1.5 1.5 0 0 1 3 0V16a6 6 0 0 1-6 6h-2a6 6 0 0 1-5-2.7L4.3 15a1.5 1.5 0 0 1 2.4-1.8L8 15" />
              </Icon>
            </span>
            <span className="dklbl">Gestures</span>
          </button>
          {menu === 'gestures' ? <GestureMenu close={() => setMenu(null)} /> : null}
        </div>
      </div>
    </div>
  );
}
