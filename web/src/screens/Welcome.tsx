// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from 'react';
import { exploreDemo } from '../data/demo.ts';
import { paintHero } from '../office/scene.ts';
import { useThemeStore } from '../theme/themeStore.ts';

export function Welcome() {
  const hero = useRef<HTMLCanvasElement>(null);
  const theme = useThemeStore((state) => state.theme);

  useEffect(() => {
    const context = hero.current?.getContext('2d');
    if (!context) return;
    paintHero(context, theme);
  }, [theme]);

  return (
    <section data-screen="welcome">
      <div className="page">
        <div className="hero">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
            <span className="chip accent" style={{ alignSelf: 'flex-start' }}>
              Open source · runs on your computer
            </span>
            <h1>See your AI agents at work, in a little office.</h1>
            <p style={{ fontSize: 17, color: 'var(--fg2)', maxWidth: '52ch' }}>
              Mabari shows every agent session as a character at a desk. Watch what each one is
              doing, ask questions without interrupting, and send instructions by typing or by
              voice.
            </p>
            <div className="steps">
              <div>
                <b>1</b>
                <span>
                  <strong>Connect an account.</strong> Sign in with ChatGPT, or attach the Claude
                  Code you already use.
                </span>
              </div>
              <div>
                <b>2</b>
                <span>
                  <strong>Your agents take a desk.</strong> Running sessions appear on the floor.
                  Subagents sit next to their lead.
                </span>
              </div>
              <div>
                <b>3</b>
                <span>
                  <strong>Instruct or ask.</strong> Instructions go into the agent&apos;s session.
                  Questions are answered from the log.
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <a className="btn primary lg" href="#accounts">
                Connect your first account
              </a>
              <button type="button" className="btn lg" onClick={() => void exploreDemo()}>
                Explore a demo office
              </button>
            </div>
            <p className="help">
              Nothing leaves this computer unless you turn on LAN access in Settings.
            </p>
          </div>
          <div className="herowrap">
            <canvas
              id="heroCanvas"
              ref={hero}
              width="1216"
              height="704"
              aria-label="Preview of the pixel office"
            />
          </div>
        </div>
      </div>
    </section>
  );
}
