// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from 'react';
import { type VeeLine, type VeeReply } from '../data/api.ts';
import { exploreDemo } from '../data/demo.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import { clockText, minsText, shortMinutes } from '../format.ts';
import type { Snapshot } from '../gen/models.ts';
import { openAgent, useOfficeUi } from '../office/uiStore.ts';
import { mascotBox, MouseGestures } from '../office/mouseGestures.ts';
import { drawMascot, IDLE_GESTURES, POKE_GESTURES, veeFrame } from '../office/vee.ts';
import { useVee } from '../office/veeStore.ts';
import { whereWorking } from '../office/where.ts';
import { useThemeStore } from '../theme/themeStore.ts';
import { ApprovalCard } from './Approvals.tsx';
import { HomeDock } from './HomeDock.tsx';

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
  // Questions wait on you too, but calmly: they are not approvals, so they aren't red.
  const asking = agents.filter((agent) => agent.question).length;
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
      {asking ? ` · ${asking} asking you a question` : ''}
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
      ) : line.questionId ? (
        <button type="button" className="btn sm" onClick={() => openAgentById(line.agentId)}>
          Answer
        </button>
      ) : (
        <button type="button" className="btn sm" onClick={() => openAgentById(line.agentId)}>
          Open
        </button>
      )}
    </li>
  );
}

/** " in Shop": where a workflow sub-agent works, so its line says whose work it is. */
function workplace(agentId: string): string {
  const office = useOfficeStore.getState().office;
  const agent = office?.agents.find((item) => item.id === agentId);
  const where = agent ? whereWorking(agent, office?.projects ?? []) : null;
  return where ? ` in ${where.name}` : '';
}

function Lines({ reply }: { reply: VeeReply }) {
  const lines = reply.lines ?? [];
  // A reply about the project picked in the dock says so, as its counts are for that project.
  const where = reply.project ? ` in ${reply.project.name}` : '';
  if (reply.kind === 'needs') {
    return (
      <>
        <p>
          {reply.need} thing{reply.need === 1 ? ' needs' : 's need'} you{where}:
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
          Everything{where} should be done in about{' '}
          <b>{minsText(reply.estimate?.secondsLeft ?? 0)}</b>, around{' '}
          <b>{clockText(reply.estimate?.finishAt ?? 0)}</b>.
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
        <b>{reply.working}</b> of {reply.total} agents{where} are working
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
            {line.label ? (
              <span className="muted">
                {' '}
                · {line.label}
                {workplace(line.agentId)}
              </span>
            ) : null}{' '}
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
  // The theme is read each frame, so changing it doesn't restart the stage and its detector,
  // which keeps the 8 s wave and 1.8 s gap as they were.
  const darkNow = useRef(dark);
  useEffect(() => {
    darkNow.current = dark;
  }, [dark]);
  const gestureState = useRef<MouseGestures | null>(null);
  useEffect(() => {
    const view = canvas.current;
    const context = view?.getContext('2d');
    if (!view || !context) return undefined;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const look = { x: 0, y: 0 };
    const lookAt = { x: 0, y: 0 };
    let nextIdle = 0;
    let frame = 0;
    gestureState.current ??= new MouseGestures(Date.now());
    const gestures = gestureState.current;

    const onMove = (event: MouseEvent) => {
      const box = view.getBoundingClientRect();
      const clamp = (value: number) => Math.max(-1, Math.min(1, value));
      lookAt.x = clamp((event.clientX - (box.left + box.width / 2)) / (box.width * 0.9));
      lookAt.y = clamp((event.clientY - (box.top + box.height * 0.35)) / (box.height * 0.9));
      // Mabari reacts to the pointer too, but not over a dialog, and never while it listens or a
      // gesture is still playing.
      if (document.querySelector('.scrim')) return;
      const vee = useVee.getState();
      const playing = !!vee.gesture && performance.now() - vee.gesture.start < vee.gesture.dur;
      const point = { x: event.clientX, y: event.clientY, t: Date.now() };
      const gesture = gestures.move(point, mascotBox(box), vee.listening || playing);
      if (gesture) vee.play(gesture);
    };
    const onLeave = () => gestures.leave();

    const paint = (t: number) => {
      frame = requestAnimationFrame(paint);
      look.x += (lookAt.x - look.x) * LOOK_EASE;
      look.y += (lookAt.y - look.y) * LOOK_EASE;
      const vee = useVee.getState();
      vee.settle(t);
      // Random idle gestures wait while the pointer moves, so they don't talk over its own.
      if (
        vee.state === 'idle' &&
        !vee.listening &&
        !vee.gesture &&
        t > nextIdle &&
        !gestures.moving(Date.now())
      ) {
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
      drawMascot(context, t, {
        ...pose,
        scarf: '#F4F4F4',
        laptop: '#8E8E93',
        dark: darkNow.current,
      });

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
    document.documentElement.addEventListener('mouseleave', onLeave);
    frame = requestAnimationFrame(paint);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('mousemove', onMove);
      document.documentElement.removeEventListener('mouseleave', onLeave);
    };
  }, [canvas, bubble]);
}

/** Waits for the office, because the stage needs its canvas on the page when it starts. */
export function Home() {
  const office = useOfficeStore((state) => state.office);
  return office ? <HomeScreen office={office} /> : null;
}

function HomeScreen({ office }: { office: Snapshot }) {
  const thinking = useVee((state) => state.state === 'think');
  const said = useVee((state) => state.said);
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
        <HomeDock spoken={office.settings.spokenReplies} />
      </div>
      <ApprovalCard office={office} />
    </section>
  );
}
