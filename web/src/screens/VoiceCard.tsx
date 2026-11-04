// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from 'react';
import { useOfficeStore } from '../data/officeStore.ts';
import { useVoice } from '../office/voiceStore.ts';
import { useEscape } from '../shell/useEscape.ts';

const BARS = 60;

function Wave({ live }: { live: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return undefined;
    const colour =
      getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#8E8E93';
    let frame = 0;
    const paint = (t: number) => {
      frame = requestAnimationFrame(paint);
      context.clearRect(0, 0, 480, 56);
      context.fillStyle = colour;
      for (let i = 0; i < BARS; i++) {
        const swing =
          (Math.sin(t / 120 + i * 0.6) * 0.5 + 0.5) * (Math.sin(t / 300 + i * 0.2) * 0.5 + 0.5);
        const height = live ? swing * 44 + 4 : 4;
        context.fillRect(i * 8 + 2, 28 - height / 2, 4, height);
      }
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [live]);
  return <canvas className="wave" id="wave" ref={canvas} width="480" height="56" />;
}

function Card() {
  const phase = useVoice((state) => state.phase);
  const text = useVoice((state) => state.text);
  const heard = useVoice((state) => state.heard);
  const engine = useVoice((state) => state.engine);
  const transcribing = useVoice((state) => state.transcribing);
  const send = useVoice((state) => state.send);
  const cancel = useVoice((state) => state.cancel);
  useEscape(cancel);

  useEffect(() => {
    const release = () => useVoice.getState().stop();
    document.addEventListener('pointerup', release);
    return () => document.removeEventListener('pointerup', release);
  }, []);

  const agent = heard?.agent ?? null;
  const instruct = (heard?.mode ?? 'instruct') === 'instruct';
  const name = agent?.name ?? 'the team';
  const outcome = !instruct
    ? `Answered from the log. ${name} is not interrupted.`
    : !agent
      ? 'Mabari picks the best agent for it.'
      : agent.provider === 'claude'
        ? `Will be queued for ${agent.name}'s next checkpoint.`
        : `Goes straight into ${agent.name}'s session.`;

  return (
    <div className="voice" role="dialog" aria-label="Voice input">
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}
      >
        <b id="vTitle">
          {phase === 'listen'
            ? 'Listening… take your time, release when done'
            : transcribing
              ? 'Turning it into text on this computer…'
              : 'Ready to send'}
        </b>
        <span className="help">
          {engine === 'whisper' ? 'Local Whisper' : 'Browser speech, on device'}
        </span>
      </div>
      <Wave live={phase === 'listen'} />
      <div className="transcript" id="vText">
        {text}
        {phase === 'listen' || transcribing ? <span className="ghost"> …</span> : null}
      </div>
      {heard ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="help">Detected</span>
          <span className={`chip${agent ? ` p-${agent.provider}` : ''}`}>
            {agent ? <span className="pdot" /> : null}
            {agent?.name ?? 'Auto dispatch'}
          </span>
          <span className={instruct ? 'chip accent' : 'chip query'}>
            {instruct ? 'Instruct' : 'Query'}
          </span>
          {heard.approval ? <span className="chip red">Approvals still need a click</span> : null}
        </div>
      ) : null}
      {phase === 'confirm' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="grow" style={{ flex: 1 }}>
            {outcome}
          </span>
          <button type="button" className="btn" onClick={cancel}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!text} onClick={send}>
            Send
          </button>
        </div>
      ) : (
        <span className="help">
          Holding Space or the mic button. Say an agent&apos;s name to pick who hears it.
        </span>
      )}
    </div>
  );
}

export function VoiceCard() {
  const open = useVoice((state) => state.phase !== null);
  const office = useOfficeStore((state) => state.office);
  return open && office ? <Card /> : null;
}
