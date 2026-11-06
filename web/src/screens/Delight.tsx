// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { useOfficeStore } from '../data/officeStore.ts';
import { agoText, dateText, minsText } from '../format.ts';
import { playAgain, useShipped } from '../office/shipped.ts';
import { drawTrophy, TROPHY } from '../office/trophies.ts';
import { useTrophy } from '../office/trophyLayer.ts';
import { useThemeStore } from '../theme/themeStore.ts';
import { Icon } from '../shell/Icon.tsx';
import { Modal } from '../shell/Modal.tsx';
import { useEscape } from '../shell/useEscape.ts';
import { AgentCardHover } from './AgentCard.tsx';

const CHECK = 'M5 13l4 4L19 7';

function Check() {
  return (
    <Icon>
      <path d={CHECK} />
    </Icon>
  );
}

/** The trophy itself, large, in its project's colour: the same one that stands on the shelf. */
function TrophyPicture({ id, color }: { id: string; color: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useThemeStore((state) => state.theme);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, TROPHY.width, TROPHY.height);
    drawTrophy(context, id, color, 0, 0, theme);
  }, [id, color, theme]);
  return (
    <canvas
      ref={canvas}
      className="trophypic"
      width={TROPHY.width}
      height={TROPHY.height}
      aria-hidden="true"
    />
  );
}

/** A completed project's summary, opened from its trophy: what shipped, by whom, and at what cost. */
function TrophyDialog({ id }: { id: string }) {
  const project = useOfficeStore((state) => state.office?.projects.find((item) => item.id === id));
  const [now] = useState(() => Date.now());
  // A party never plays over an approval, so while one waits the button says so and stays off.
  const waiting = useOfficeStore((state) =>
    (state.office?.agents ?? []).some((agent) => agent.state === 'approval' && agent.approval),
  );
  const close = () => useTrophy.getState().show(null);
  useEscape(close);
  // A project that was reopened or deleted has no trophy any more.
  useEffect(() => {
    if (!project?.done) close();
  }, [project?.done]);
  if (!project?.done) return null;
  const { done } = project;
  return (
    <Modal>
      <div
        className="dialog trophydlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trophyTitle"
        tabIndex={-1}
      >
        <div className="dhd">
          <div className="trophyhead">
            <TrophyPicture id={project.id} color={project.color} />
            <div>
              <h2 id="trophyTitle">{project.name}</h2>
              <p className="help">
                Shipped {agoText(done.at, now)}, {dateText(done.at)}
              </p>
            </div>
          </div>
          <button type="button" className="btn ghost sm" aria-label="Close" onClick={close}>
            <Icon>
              <path d="M6 6l12 12M18 6 6 18" />
            </Icon>
          </button>
        </div>
        <div className="counters">
          <div className="cnt">
            <b className="num">{done.agents}</b>
            <span>Agents involved</span>
          </div>
          <div className="cnt">
            <b className="num">{minsText(done.mins * 60)}</b>
            <span>Time taken</span>
          </div>
          <div className="cnt">
            <b className="num">${done.cost.toFixed(2)}</b>
            <span>Cost</span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="flabel">What got done</span>
          {done.tasks.length ? (
            done.tasks.map((task) => (
              <div className="doneitem" key={task}>
                <Check />
                <span>{task}</span>
              </div>
            ))
          ) : (
            <p className="help">No tasks recorded.</p>
          )}
        </div>
        {waiting ? (
          <p className="help" id="partyWait">
            An approval is waiting for you, so the party can&apos;t play now. Decide it, then play
            it.
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn"
            disabled={waiting}
            aria-describedby={waiting ? 'partyWait' : undefined}
            title="Watch the team celebrate shipping this project, again"
            onClick={() => {
              close();
              playAgain(project);
            }}
          >
            Play the party
          </button>
          <a className="btn" href="#projects" onClick={close}>
            Open in Projects
          </a>
          <button type="button" className="btn primary" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * "Shipped", in a bubble like the floor's own, while a project's party lasts. It is the one
 * announcement of it, so a screen reader hears it too, and it takes no clicks, so it never covers
 * a control.
 */
function ShippedBanner() {
  const phase = useShipped((state) => state.phase);
  const current = useShipped((state) => state.current);
  // What it took, from the server's own numbers: agents, time and cost, on a line under the name.
  const done = useOfficeStore(
    (state) => state.office?.projects.find((item) => item.id === current?.id)?.done,
  );
  const stats = done
    ? [
        `${done.agents} agent${done.agents === 1 ? '' : 's'}`,
        minsText(done.mins * 60),
        '$' + done.cost.toFixed(2),
      ].join(' · ')
    : '';
  return (
    <div className="shippedwrap" role="status">
      {phase === 'party' && current ? (
        <div className="shipped" style={{ ['--pc' as string]: current.color }}>
          <i aria-hidden="true" />
          <b>Shipped</b>
          <span>{current.name}</span>
          {stats ? <small>{stats}</small> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the office floor adds to be a place worth opening: the agent card on a name, the banner for
 * a shipped project, and the summary a trophy opens. It also tells the celebrations the floor is
 * on screen, which is the only place they play.
 */
export function Delight() {
  const open = useTrophy((state) => state.open);
  useEffect(() => {
    useShipped.getState().watch(true);
    return () => {
      useShipped.getState().watch(false);
      useTrophy.getState().show(null);
    };
  }, []);
  return (
    <>
      <AgentCardHover />
      <ShippedBanner />
      {open ? <TrophyDialog id={open} /> : null}
    </>
  );
}
