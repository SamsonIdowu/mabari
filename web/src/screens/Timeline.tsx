// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { catchUp, localDay } from '../data/catchUp.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import type { LiveAgent, Timeline as TimelineData, TimelineLane } from '../gen/models.ts';
import { openAgent } from '../office/uiStore.ts';
import {
  axisFor,
  blockBox,
  blockTitle,
  dayName,
  kindLabel,
  laneText,
  markerTitle,
  neighbourDay,
  percent,
  summaryText,
} from '../timeline.ts';
import '../styles/catchup.css';

const REFRESH_MS = 60_000;
/** After an agent changes what it is doing, the chart waits this long for more before reading again. */
const SETTLE_MS = 800;
const KINDS = ['working', 'approval', 'question', 'error'] as const;

/** What each agent is doing, for what the timeline cares about, so it is read again when that changes. */
function phaseKey(agents: LiveAgent[] | undefined): string {
  return (agents ?? [])
    .filter((agent) => agent.leadId === null)
    .map((agent) => {
      const phase = agent.question
        ? 'question'
        : agent.state === 'approval' || agent.state === 'error'
          ? agent.state
          : agent.working
            ? 'working'
            : 'rest';
      return `${agent.id}:${phase}`;
    })
    .join('|');
}

function openLane(lane: TimelineLane) {
  const agents = useOfficeStore.getState().office?.agents ?? [];
  const agent = agents.find((item) => item.id === lane.agentId);
  if (agent) openAgent(agent, agents);
}

/**
 * One day of the office, an agent to a row: when it worked, waited on you, or stopped with an error,
 * with a mark for each approval and instruction, and a line at now. The server works all of it out;
 * this draws it with plain markup and says it again in words for a screen reader.
 */
export function Timeline() {
  const ready = useOfficeStore((state) => state.office !== null);
  const phases = useOfficeStore((state) => phaseKey(state.office?.agents));
  const [day, setDay] = useState(() => localDay(new Date()));
  const [data, setData] = useState<TimelineData | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const today = day === localDay(new Date());

  // The line at now moves, and open blocks grow, with a read each minute.
  useEffect(() => {
    const timer = setInterval(() => setTick((count) => count + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!ready) return undefined;
    let current = true;
    const timer = setTimeout(() => {
      catchUp
        .timeline(day)
        .then((found) => {
          if (!current) return;
          setData(found);
          setFailed(false);
        })
        .catch(() => current && setFailed(true));
    }, SETTLE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [day, ready, phases, tick]);

  const axis = data ? axisFor(data) : null;
  const heading = today ? "Today's timeline" : `Timeline for ${dayName(day)}`;
  return (
    <section className="tlcard" aria-labelledby="tlTitle" data-testid="timeline">
      <div className="tlhead">
        <h2 id="tlTitle">{heading}</h2>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => setDay(neighbourDay(day, -1))}
        >
          ‹ Day before
        </button>
        <button
          type="button"
          className="btn sm ghost"
          disabled={today}
          onClick={() => setDay(neighbourDay(day, 1))}
        >
          Day after ›
        </button>
      </div>
      {failed ? (
        <p className="help">The timeline can't be read just now. It tries again in a minute.</p>
      ) : null}
      {data && axis ? (
        <>
          <p className="sr">{summaryText(data, today)}</p>
          <div className="tl">
            <div className="tlrow tlaxis" aria-hidden="true">
              <span />
              <div className="tltrack">
                {axis.ticks.map((tick) => {
                  const at = percent(axis, tick.at);
                  // The labels at either end stay inside the chart.
                  const shift = at > 96 ? 'translateX(-100%)' : at < 4 ? 'none' : undefined;
                  return (
                    <span
                      className="tltick"
                      key={tick.at}
                      style={{ left: `${at}%`, transform: shift }}
                    >
                      {tick.label}
                    </span>
                  );
                })}
              </div>
            </div>
            {data.lanes.map((lane) => (
              <div className="tlrow" key={lane.agentId} data-agent={lane.agentId}>
                {lane.present ? (
                  <button type="button" className="tllabel" onClick={() => openLane(lane)}>
                    <span className={`pdot p-${lane.provider}`} />
                    <span className="tlname">{lane.agent}</span>
                  </button>
                ) : (
                  <span className="tllabel gone" title="This agent has left the office">
                    <span className={`pdot p-${lane.provider || 'custom'}`} />
                    <span className="tlname">{lane.agent}</span>
                  </span>
                )}
                {/* Each row is a picture with its own words, so it is read as the sentence it says.
                    Its blocks are for the mouse; the name beside it opens the agent from the keyboard. */}
                <div className="tltrack" role="img" aria-label={laneText(lane)}>
                  {lane.blocks.map((block) => {
                    const box = blockBox(axis, block);
                    return (
                      <div
                        key={`${block.kind}-${block.from}`}
                        className={`tlblock ${block.kind}${lane.present ? ' clickable' : ''}`}
                        data-testid="tl-block"
                        data-kind={block.kind}
                        style={{ left: `${box.left}%`, width: `${box.width}%` }}
                        title={blockTitle(lane, block)}
                        onClick={lane.present ? () => openLane(lane) : undefined}
                      />
                    );
                  })}
                  {lane.markers.map((marker, index) => (
                    <span
                      key={`${marker.kind}-${marker.time}-${index}`}
                      className={`tlmark ${marker.kind}`}
                      data-testid="tl-marker"
                      data-kind={marker.kind}
                      style={{ left: `${percent(axis, marker.time)}%` }}
                      title={markerTitle(lane, marker)}
                      onClick={lane.present ? () => openLane(lane) : undefined}
                    />
                  ))}
                </div>
              </div>
            ))}
            {today && data.now >= axis.start && data.now <= axis.end ? (
              <div className="tlplot" aria-hidden="true">
                <span
                  className="tlnow"
                  data-testid="tl-now"
                  style={{ left: `${percent(axis, data.now)}%` }}
                />
              </div>
            ) : null}
          </div>
          <ul className="tllegend" aria-hidden="true">
            {KINDS.map((kind) => (
              <li key={kind}>
                <span className={`tlswatch ${kind}`} /> {kindLabel(kind)}
              </li>
            ))}
            <li>
              <span className="tlmark approval static" /> Approval asked
            </li>
            <li>
              <span className="tlmark instruction static" /> Instruction sent
            </li>
            <li>
              <span className="tlswatch now" /> Now
            </li>
          </ul>
        </>
      ) : data ? (
        <p className="help" data-testid="timeline-empty">
          {today
            ? 'No agent has worked yet today. When one does, its hours show here.'
            : 'No agent worked on this day.'}
        </p>
      ) : null}
    </section>
  );
}
