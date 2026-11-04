// SPDX-License-Identifier: Apache-2.0
// Records the prototype's demo office, for the simulator's golden test. Run with `make golden`.
//
// It runs the prototype's own code in Chromium with a seeded Math.random and a virtual clock, so
// the Go port must draw the same random numbers in the same order to match.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const SEED = 20261104;
const START = 1_800_000_000_000;
const TICKS = 900;
const EVERY = 15;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(root, 'internal/connectors/simulator/testdata/golden.json');

// The prototype's state is private to its script, so expose it just for this recording.
const marker = '})();\n</script>';
const source = readFileSync(resolve(root, 'design/mabari-prototype.html'), 'utf8');
if (source.split(marker).length !== 2) throw new Error('Could not find the end of the script');
const page = source.replace(marker, 'window.__mabari={S,tick,loadDemo};\n' + marker);

const browser = await chromium.launch();
const context = await browser.newContext();
await context.route('**/fonts.googleapis.com/**', (route) => route.abort());
const tab = await context.newPage();
tab.on('pageerror', (error) => {
  throw error;
});
await tab.addInitScript(() => {
  // Nothing moves on its own: the recording below drives every tick and timer.
  window.setInterval = () => 0;
  window.requestAnimationFrame = () => 0;
  window.__timers = [];
  window.setTimeout = (work, delay = 0) => {
    window.__timers.push({ at: Date.now() + delay, work });
    return 0;
  };
});
await context.route('http://mabari.test/', (route) =>
  route.fulfill({ contentType: 'text/html', body: page }),
);
await tab.goto('http://mabari.test/', { waitUntil: 'domcontentloaded' });

const frames = await tab.evaluate(
  ({ seed, start, ticks, every }) => {
    let now = start;
    Date.now = () => now;
    let state = seed;
    Math.random = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const runTimers = () => {
      const due = window.__timers.filter((timer) => timer.at <= now);
      window.__timers = window.__timers.filter((timer) => timer.at > now);
      due.sort((a, b) => a.at - b.at).forEach((timer) => timer.work());
    };
    const { S, tick, loadDemo } = window.__mabari;
    // The hub token is Stage 6, so the demo must not draw random numbers for it here.
    S.acc.token = 'recording';
    window.__timers = [];
    loadDemo();
    runTimers();

    const record = (index) => ({
      tick: index,
      agents: S.agents.map((a) => ({
        name: a.name,
        state: a.state,
        task: a.task,
        desk: a.desk,
        progress: a.progress,
        rate: a.rate,
        elapsed: a.elapsed,
        tin: a.tin,
        tout: a.tout,
        hue: a.hue,
        skin: a.skin,
        hair: a.hair,
        top: a.feed[0] ? `${a.feed[0].tool}|${a.feed[0].sum}` : '',
        feed: a.feed.length,
        queued: a.queued.length,
      })),
      messages: S.msgs.length,
      lastText: S.msgs[S.msgs.length - 1].text,
      log: S.log.length,
    });

    const recorded = [record(0)];
    for (let index = 1; index <= ticks; index++) {
      now += 1000;
      runTimers();
      tick();
      if (index % every === 0) recorded.push(record(index));
    }
    return recorded;
  },
  { seed: SEED, start: START, ticks: TICKS, every: EVERY },
);
await browser.close();

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(frames, null, 1) + '\n');
console.log(`Wrote ${frames.length} frames to ${output}`);
