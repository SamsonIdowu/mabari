// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { api, type VeeLine, type VeeReply } from '../data/api.ts';
import { exploreDemo } from '../data/demo.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import { clockText, minsText, shortMinutes } from '../format.ts';
import type { Snapshot } from '../gen/models.ts';
import { openAgent, useOfficeUi } from '../office/uiStore.ts';
import {
  drawMascot,
  GESTURE_LABELS,
  IDLE_GESTURES,
  POKE_GESTURES,
  veeFrame,
} from '../office/vee.ts';
import { detect } from '../office/voice.ts';
import { listen, type Listener } from '../office/speech.ts';
import { useVee, VEE_HELLO } from '../office/veeStore.ts';
import { Icon } from '../shell/Icon.tsx';
import { useEscape } from '../shell/useEscape.ts';
import { useThemeStore } from '../theme/themeStore.ts';
import { ApprovalCard } from './Approvals.tsx';

const LOOK_EASE = 0.08;
const IDLE_MIN_MS = 7000;
const IDLE_SPREAD_MS = 5000;

const anyOf = (items: string[]) => items[Math.floor(Math.random() * items.length)]!;

function greeting(hour: number) {
  if (hour < 12) return 'Morning';
  return hour < 18 ? 'Afternoon' : 'Evening';
}

function Summary({ office }: { office: Snapshot }) {
  const { agents } = office;
  if (!agents.length) return <p id="homeSum">No agents yet</p>;
  const working = agents.filter((agent) => agent.estimate);
  const need = agents.filter((a) => a.state === 'approval' || a.state === 'error').length;
  const finish = Math.max(0, ...working.map((agent) => agent.estimate?.finishAt ?? 0));
  return (
    <p id="homeSum">
      {working.length} working
      {need ? (
        <>
          {' · '}
          <b style={{ color: 'var(--red)' }}>{need} need you</b>
        </>
      ) : null}
      {working.length ? ` · done around ${clockText(finish)}` : ''}
    </p>
  );
}

function openAgentById(id: string) {
  const agents = useOfficeStore.getState().office?.agents ?? [];
  const agent = agents.find((item) => item.id === id);
  if (agent) openAgent(agent, agents);
}

function Dot({ hue }: { hue: string }) {
  return <span className="idot" style={{ ['--ac' as string]: hue }} />;
}

function NeedLine({ line }: { line: VeeLine }) {
  const review = () => useOfficeUi.getState().set({ reviewing: line.approvalId });
  return (
    <li>
      <Dot hue={line.hue} />
      <b>{line.name}</b> {line.summary}{' '}
      {line.approvalId ? (
        <button type="button" className="btn sm danger-out" onClick={review}>
          Review
        </button>
      ) : (
        <button type="button" className="btn sm" onClick={() => openAgentById(line.agentId)}>
          Open
        </button>
      )}
    </li>
  );
}

function Lines({ reply }: { reply: VeeReply }) {
  const lines = reply.lines ?? [];
  if (reply.kind === 'needs') {
    return (
      <>
        <p>
          {reply.need} thing{reply.need === 1 ? ' needs' : 's need'} you:
        </p>
        <ul className="hclist">
          {lines.map((line) => (
            <NeedLine line={line} key={line.agentId} />
          ))}
        </ul>
        <p className="help">
          I never approve risky actions for you. You always decide with a click.
        </p>
      </>
    );
  }
  if (reply.kind === 'when') {
    return (
      <>
        <p>
          Everything should be done in about <b>{minsText(reply.estimate?.secondsLeft ?? 0)}</b>,
          around <b>{clockText(reply.estimate?.finishAt ?? 0)}</b>.
        </p>
        <ul className="hclist">
          {lines.map((line) => (
            <li key={line.agentId}>
              <Dot hue={line.hue} />
              <b>{line.name}</b> about {minsText(line.estimate?.secondsLeft ?? 0)}
            </li>
          ))}
        </ul>
      </>
    );
  }
  return (
    <>
      <p>
        <b>{reply.working}</b> of {reply.total} agents are working
        {reply.need ? (
          <>
            {' '}
            and <b>{reply.need}</b> need you
          </>
        ) : null}
        .
      </p>
      <ul className="hclist">
        {lines.map((line) => (
          <li key={line.agentId}>
            <button type="button" className="linkbtn" onClick={() => openAgentById(line.agentId)}>
              <Dot hue={line.hue} />
              <b>{line.name}</b>
            </button>{' '}
            {line.state}: {line.task}
            {line.estimate ? (
              <span className="muted"> ({shortMinutes(line.estimate.secondsLeft)})</span>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

function Said({ reply }: { reply: VeeReply }) {
  const sendToTeam = useVee((state) => state.sendToTeam);
  switch (reply.kind) {
    case 'needs':
    case 'when':
    case 'status':
      return <Lines reply={reply} />;
    case 'office':
      return (
        <p>
          Here you go.{' '}
          <a className="btn sm" href="#office">
            Open the office
          </a>
        </p>
      );
    case 'empty':
      return (
        <>
          <p>The office is empty for now.</p>
          <p>
            <a className="btn sm" href="#accounts">
              Connect an account
            </a>{' '}
            <button type="button" className="btn sm" onClick={() => void exploreDemo()}>
              Explore a demo office
            </button>
          </p>
        </>
      );
    case 'dispatch':
      return (
        <>
          <p>{reply.text}</p>
          <p>
            <button
              type="button"
              className="btn sm primary"
              onClick={() => void sendToTeam(reply.message)}
            >
              Send to the team
            </button>
          </p>
        </>
      );
    default:
      return <p>{reply.text}</p>;
  }
}

/** Paints Vee every frame and keeps the speech bubble at Vee's mouth. */
function useVeeStage(
  canvas: React.RefObject<HTMLCanvasElement | null>,
  bubble: React.RefObject<HTMLDivElement | null>,
) {
  const dark = useThemeStore((state) => state.theme) === 'dark';
  useEffect(() => {
    const view = canvas.current;
    const context = view?.getContext('2d');
    if (!view || !context) return undefined;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const look = { x: 0, y: 0 };
    const lookAt = { x: 0, y: 0 };
    let nextIdle = 0;
    let frame = 0;

    const onMove = (event: MouseEvent) => {
      const box = view.getBoundingClientRect();
      const clamp = (value: number) => Math.max(-1, Math.min(1, value));
      lookAt.x = clamp((event.clientX - (box.left + box.width / 2)) / (box.width * 0.9));
      lookAt.y = clamp((event.clientY - (box.top + box.height * 0.35)) / (box.height * 0.9));
    };

    const paint = (t: number) => {
      frame = requestAnimationFrame(paint);
      look.x += (lookAt.x - look.x) * LOOK_EASE;
      look.y += (lookAt.y - look.y) * LOOK_EASE;
      const vee = useVee.getState();
      vee.settle(t);
      if (vee.state === 'idle' && !vee.gesture && t > nextIdle) {
        if (nextIdle && !still) vee.play(anyOf(IDLE_GESTURES));
        nextIdle = t + IDLE_MIN_MS + Math.random() * IDLE_SPREAD_MS;
      }
      const pose = veeFrame(vee.state, look, vee.gesture, t);
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const shownW = view.clientWidth;
      const shownH = view.clientHeight;
      const w = Math.round(shownW * dpr);
      const h = Math.round(shownH * dpr);
      if (!w || !h) return;
      if (view.width !== w || view.height !== h) {
        view.width = w;
        view.height = h;
      }
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, w, h);
      context.imageSmoothingEnabled = true;
      const scale = Math.min(w / 34, h / 45);
      const ox = (w - 32 * scale) / 2;
      const oy = h - 40.5 * scale;
      context.setTransform(scale, 0, 0, scale, ox, oy);
      drawMascot(context, t, { ...pose, scarf: '#F4F4F4', laptop: '#8E8E93', dark });

      const say = bubble.current;
      if (!say) return;
      const mouthX = (ox + (27.6 + (pose.rig.turn ?? 0) * 1.5) * scale) / dpr;
      const mouthY = (oy + 15.6 * scale) / dpr;
      const right = mouthX + 24 + say.offsetWidth < shownW - 8;
      say.classList.toggle('left', !right);
      const x = Math.max(8, right ? mouthX + 24 : (ox + 4.4 * scale) / dpr - 24 - say.offsetWidth);
      const y = Math.max(
        8,
        Math.min(shownH - say.offsetHeight - 8, mouthY - say.offsetHeight * 0.55),
      );
      say.style.left = `${x}px`;
      say.style.top = `${y}px`;
      say.style.setProperty(
        '--ty',
        `${Math.max(14, Math.min(say.offsetHeight - 14, mouthY - y))}px`,
      );
    };

    document.addEventListener('mousemove', onMove);
    frame = requestAnimationFrame(paint);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('mousemove', onMove);
    };
  }, [canvas, bubble, dark]);
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

/**
 * Hold the mic, or Space when not typing, to talk to Vee. Speech stays on this computer. On
 * release a question goes straight to Vee, and an instruction waits in the box for Enter or
 * Send (decisions 15 and 16), so nothing is sent to an agent by voice alone.
 */
function useHomeMic(setText: (text: string) => void, send: (text: string) => void) {
  const toast = useOfficeStore((state) => state.toast);
  const [listening, setListening] = useState(false);
  const listener = useRef<Listener | null>(null);
  const heard = useRef('');
  const active = useRef(false);
  const finish = useRef(() => {});
  const start = () => {
    if (active.current) return;
    active.current = true;
    heard.current = '';
    setListening(true);
    listener.current = listen({
      onText: (text) => {
        heard.current = text;
        setText(text);
      },
      onError: (message) => {
        toast(message);
        active.current = false;
        setListening(false);
        listener.current = null;
      },
      onEnd: () => finish.current(),
    });
  };
  useEffect(() => {
    finish.current = () => {
      if (!active.current) return;
      active.current = false;
      setListening(false);
      listener.current?.stop();
      listener.current = null;
      const text = heard.current.trim();
      heard.current = '';
      if (!text) {
        useVee.getState().say({
          ...VEE_HELLO,
          text: "I didn't catch that. Hold the mic and try again.",
          gesture: 'shrug',
        });
        return;
      }
      const office = useOfficeStore.getState().office;
      if (detect(text, office?.agents ?? [], null).mode === 'query') {
        setText('');
        send(text);
      } else {
        setText(text);
        toast('Press Enter to send it, or edit it first.');
      }
    };
  });
  useEffect(() => {
    const up = () => finish.current();
    const down = (event: globalThis.KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat) return;
      const focused = document.activeElement as HTMLElement | null;
      if (focused?.id === 'hcText' && (focused as HTMLTextAreaElement).value) return;
      if (
        focused &&
        focused.id !== 'hcText' &&
        /INPUT|TEXTAREA|SELECT|BUTTON/.test(focused.tagName)
      )
        return;
      event.preventDefault();
      start();
    };
    const keyUp = (event: globalThis.KeyboardEvent) => {
      if (event.code === 'Space') finish.current();
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', keyUp, true);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', keyUp, true);
    };
  });
  // Leaving Home stops listening. Only on leaving: the effect above runs after every render.
  useEffect(
    () => () => {
      active.current = false;
      listener.current?.abort();
    },
    [],
  );
  return { listening, start };
}

function ChatBox({ spoken }: { spoken: boolean }) {
  const hear = useVee((state) => state.hear);
  const [text, setText] = useState('');
  const [gestures, setGestures] = useState(false);
  const mic = useHomeMic(setText, (heard) => void hear(heard));
  const send = () => {
    const message = text.trim();
    if (!message) return;
    setText('');
    void hear(message);
  };
  const toggleVoice = () => {
    if (spoken) window.speechSynthesis?.cancel();
    void api.updateSettings({ spokenReplies: !spoken });
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    send();
  };
  return (
    <form className="h2box" id="hcForm" autoComplete="off" onSubmit={submit}>
      <label className="sr" htmlFor="hcText">
        Message Vee
      </label>
      <textarea
        id="hcText"
        rows={2}
        placeholder="Ask Vee anything"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKey}
      />
      <div className="h2row">
        <div className="ddwrap">
          <button
            type="button"
            className="h2ic"
            aria-label="Gestures"
            title="Gestures"
            aria-expanded={gestures}
            onClick={() => setGestures(!gestures)}
          >
            <Icon>
              <path d="M12 5v14M5 12h14" />
            </Icon>
          </button>
          {gestures ? <GestureMenu close={() => setGestures(false)} /> : null}
        </div>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          id="hcMic"
          className={mic.listening ? 'h2ic on' : 'h2ic'}
          aria-label="Hold to talk"
          aria-pressed={mic.listening}
          title="Hold to talk"
          onPointerDown={(event) => {
            event.preventDefault();
            mic.start();
          }}
        >
          <Icon>
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </Icon>
        </button>
        <button
          type="button"
          className="h2ic"
          id="hcVoiceOut"
          aria-label="Spoken replies"
          aria-pressed={spoken}
          title={spoken ? 'Vee speaks replies: on' : 'Vee speaks replies: off'}
          onClick={toggleVoice}
        >
          <Icon>
            <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
          </Icon>
        </button>
      </div>
    </form>
  );
}

/** Waits for the office, because the stage needs its canvas on the page when it starts. */
export function Home() {
  const office = useOfficeStore((state) => state.office);
  return office ? <HomeScreen office={office} /> : null;
}

function HomeScreen({ office }: { office: Snapshot }) {
  const thinking = useVee((state) => state.state === 'think');
  const said = useVee((state) => state.said);
  const heard = useVee((state) => state.heard);
  const play = useVee((state) => state.play);
  const canvas = useRef<HTMLCanvasElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  useVeeStage(canvas, bubble);
  return (
    <section data-screen="home">
      <div className="home2">
        <div className="h2head">
          <h1>
            <span id="homeGreet">{greeting(new Date().getHours())}</span>
          </h1>
          <Summary office={office} />
        </div>
        <div className="h2stage">
          <canvas
            id="veeHome"
            ref={canvas}
            aria-label="Vee, the Mabari mascot"
            onClick={() => play(anyOf(POKE_GESTURES))}
          />
          <div className="veesay2" id="veeSay" aria-live="polite" ref={bubble}>
            {thinking ? (
              <div className="typing">
                <i />
                <i />
                <i />
              </div>
            ) : (
              <Said reply={said} />
            )}
          </div>
        </div>
        <div className="h2bottom">
          {heard ? (
            <div className="yousaid" id="youSaid">
              {heard}
            </div>
          ) : null}
          <ChatBox spoken={office.settings.spokenReplies} />
          <div className="h2under">
            <span>Enter to send · hold the mic or Space to talk</span>
            <span id="voiceLbl">{office.settings.spokenReplies ? 'Voice on' : 'Voice off'}</span>
          </div>
        </div>
      </div>
      <ApprovalCard office={office} />
    </section>
  );
}
