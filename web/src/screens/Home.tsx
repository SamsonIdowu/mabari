// SPDX-License-Identifier: Apache-2.0
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
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
const HOME_SCALE = 0.78;
const IDLE_MIN_MS = 7000;
const IDLE_SPREAD_MS = 5000;

const anyOf = (items: string[]) => items[Math.floor(Math.random() * items.length)]!;

function greeting(hour: number) {
  if (hour < 12) return 'Good morning';
  return hour < 18 ? 'Good afternoon' : 'Good evening';
}

function Summary({ office }: { office: Snapshot }) {
  const { agents } = office;
  if (!agents.length) return <p id="homeSum">No agents yet</p>;
  // Working comes from the server, so sessions that report no progress rate, such as Claude
  // Code's, count too. Only agents with an estimate say when they will be done.
  const working = agents.filter((agent) => agent.working);
  const workflow = working.filter((agent) => agent.workflow).length;
  const estimated = agents.filter((agent) => agent.estimate);
  const need = agents.filter((a) => a.state === 'approval' || a.state === 'error').length;
  const finish = Math.max(0, ...estimated.map((agent) => agent.estimate?.finishAt ?? 0));
  return (
    <p id="homeSum">
      {working.length} working
      {workflow ? ` (${workflow} workflow sub-agent${workflow === 1 ? '' : 's'})` : ''}
      {need ? (
        <>
          {' · '}
          <b style={{ color: 'var(--red)' }}>{need} need you</b>
        </>
      ) : null}
      {estimated.length ? ` · done around ${clockText(finish)}` : ''}
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
            </button>
            {line.label ? <span className="muted"> · {line.label}</span> : null} {line.state}:{' '}
            {line.task}
            {line.estimate ? (
              <span className="muted"> ({shortMinutes(line.estimate.secondsLeft)})</span>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

function Replies({ reply }: { reply: VeeReply }) {
  return (
    <>
      <p>Latest replies from your agents:</p>
      <ul className="hclist">
        {(reply.lines ?? []).map((line, index) => (
          <li key={`${line.agentId}-${index}`}>
            <b>{line.name}</b> <span className="muted">({line.ai})</span>: {line.reply}
          </li>
        ))}
      </ul>
    </>
  );
}

/** Mabari couldn't tell which project a message is for, so it asks, with a button for each. */
function PickProject({ reply }: { reply: VeeReply }) {
  const hear = useVee((state) => state.hear);
  const target = reply.target ?? '';
  return (
    <>
      <p>{reply.text}</p>
      <p className="pickproj">
        {(reply.projects ?? []).map((project) => (
          <button
            type="button"
            className="btn sm"
            key={project.id}
            onClick={() => void hear(target, project.id)}
          >
            <span className="pdot" style={{ background: project.color }} />
            {project.name}
          </button>
        ))}
        <button type="button" className="btn sm ghost" onClick={() => void hear(target, 'any')}>
          Any free agent
        </button>
      </p>
    </>
  );
}

function Said({ reply }: { reply: VeeReply }) {
  switch (reply.kind) {
    case 'pickProject':
      return <PickProject reply={reply} />;
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
    case 'replies':
      return <Replies reply={reply} />;
    case 'relayed': {
      const { agentId } = reply;
      return (
        <>
          <p>{reply.text}</p>
          {agentId ? (
            <p>
              <button type="button" className="btn sm" onClick={() => openAgentById(agentId)}>
                Read it all
              </button>
            </p>
          ) : null}
        </>
      );
    }
    default:
      return <p>{reply.text}</p>;
  }
}

/** Paints Mabari every frame and keeps the speech bubble at its mouth. */
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
      // About 20% smaller than the stage allows, and centred both ways, as in the prototype.
      const scale = Math.min(w / 34, h / 45) * HOME_SCALE;
      const ox = (w - 32 * scale) / 2;
      const oy = (h - 42 * scale) / 2;
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
 * Hold the mic, or Space when not typing, to talk to Mabari. Speech stays on this computer. On
 * release a question goes straight to Mabari, and an instruction waits in the box for Enter or
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
    listener.current = listen(
      {
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
      },
      useOfficeStore.getState().office?.settings.voiceEngine,
    );
  };
  /** Release stops listening. The text is final once the engine ends, which for Local Whisper
   * is after it has turned the recording into text. */
  const release = useRef(() => {});
  useEffect(() => {
    release.current = () => {
      if (!active.current) return;
      setListening(false);
      if (listener.current) listener.current.stop();
      else finish.current();
    };
    finish.current = () => {
      if (!active.current) return;
      active.current = false;
      setListening(false);
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
    const up = () => release.current();
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
      if (event.code === 'Space') release.current();
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

/** The message box starts at one line and grows with what is typed, up to this many pixels. */
const BOX_MAX_PX = 120;

/** The projects a message can go to, picked next to the box. */
function ProjectMenu({ close }: { close: () => void }) {
  const projects = useOfficeStore((state) => state.office?.projects ?? []).filter(
    (project) => !project.done,
  );
  const picked = useVee((state) => state.project);
  const setProject = useVee((state) => state.setProject);
  useEscape(close);
  const choose = (project: string) => {
    setProject(project);
    close();
  };
  return (
    <div className="menu up" id="projMenu">
      <div className="gmhead">Send messages to</div>
      <button
        type="button"
        className={picked === '' ? 'mi on' : 'mi'}
        aria-pressed={picked === ''}
        onClick={() => choose('')}
      >
        Let Mabari pick the project
      </button>
      {projects.map((project) => (
        <button
          type="button"
          key={project.id}
          className={picked === project.id ? 'mi on' : 'mi'}
          aria-pressed={picked === project.id}
          onClick={() => choose(project.id)}
        >
          <span className="pdot" style={{ background: project.color }} />
          {project.name}
        </button>
      ))}
      <button
        type="button"
        className={picked === 'any' ? 'mi on' : 'mi'}
        aria-pressed={picked === 'any'}
        onClick={() => choose('any')}
      >
        Any free agent
      </button>
    </div>
  );
}

/** Which project messages go to, as the chip next to the box shows it. */
function useProjectLabel(): { label: string; color: string } {
  const picked = useVee((state) => state.project);
  const project = useOfficeStore((state) =>
    state.office?.projects.find((item) => item.id === picked && !item.done),
  );
  if (project) return { label: project.name, color: project.color };
  if (picked === 'any') return { label: 'Any agent', color: '' };
  return { label: 'Mabari picks', color: '' };
}

function ChatBox({ spoken }: { spoken: boolean }) {
  const hear = useVee((state) => state.hear);
  const [projects, setProjects] = useState(false);
  const to = useProjectLabel();
  const [text, setText] = useState('');
  const [gestures, setGestures] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const mic = useHomeMic(setText, (heard) => void hear(heard));
  // Fit the box to its text, and back to one line once it is sent.
  useLayoutEffect(() => {
    const field = box.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, BOX_MAX_PX)}px`;
  }, [text]);
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
      <div className="ddwrap">
        <button
          type="button"
          className="h2proj"
          id="hcProject"
          aria-label={`Send to: ${to.label}`}
          title="Which project messages go to"
          aria-expanded={projects}
          onClick={() => setProjects(!projects)}
        >
          {to.color ? <span className="pdot" style={{ background: to.color }} /> : null}
          <span className="h2projname">{to.label}</span>
          <Icon>
            <path d="M7 10l5 5 5-5" />
          </Icon>
        </button>
        {projects ? <ProjectMenu close={() => setProjects(false)} /> : null}
      </div>
      <label className="sr" htmlFor="hcText">
        Message Mabari
      </label>
      <textarea
        id="hcText"
        ref={box}
        rows={1}
        placeholder="Ask Mabari anything"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKey}
      />
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
        title={spoken ? 'Mabari speaks replies: on' : 'Mabari speaks replies: off'}
        onClick={toggleVoice}
      >
        <Icon>
          <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
        </Icon>
      </button>
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
  const setOnHome = useVee((state) => state.setOnHome);
  useEffect(() => {
    setOnHome(true);
    return () => setOnHome(false);
  }, [setOnHome]);
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
            aria-label="Mabari, your office assistant"
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
