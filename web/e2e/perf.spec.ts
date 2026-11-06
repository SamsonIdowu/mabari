// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from '@playwright/test';
import { wipe } from './support/page.ts';

/** Animation frames a second over a window, counted in the page the way the browser draws. */
function framesPerSecond(page: Page, ms: number) {
  return page.evaluate(
    (window_ms) =>
      new Promise<number>((resolve) => {
        let count = 0;
        const start = performance.now();
        const tick = (now: number) => {
          count++;
          if (now - start < window_ms) requestAnimationFrame(tick);
          else resolve((count * 1000) / (now - start));
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
}

// A full office: 16 agents reporting through the hub while the floor draws. The floor must keep a
// smooth frame rate and the page must keep up with the updates.
//
// This reads about 60 fps or about 10, and little between. A backlog that keeps the page's main
// thread busy for the whole window leaves the browser drawing one frame in about 100 ms, whatever
// the size of the backlog, so a reading near 10 means "the page could not keep up", not "the
// floor is a little slow". It was the page: every message from the server was applied on its own,
// and each one re-rendered the screen. The test's server is Vite's, which runs React's
// development build, several times slower than the shipped app, so a pass here is conservative.
test('the floor stays smooth with 16 busy agents', async ({ page, request }) => {
  test.setTimeout(60_000);
  await wipe(request);
  const { token } = (await (await request.post('/api/accounts/hub/token')).json()) as {
    token: string;
  };
  const hub = (body: object) =>
    // Vite proxies only /api and /ws, so the hub is called on the Go server directly.
    request.post(`http://127.0.0.1:${process.env.MABARI_API_PORT ?? '4327'}/hub/v1/events`, {
      headers: { Authorization: `Bearer ${token}` },
      data: body,
    });
  for (let i = 0; i < 16; i++) {
    const seated = await hub({
      agent: `perf-${i}`,
      name: `Perf ${i}`,
      state: 'running',
      task: 'Load',
    });
    expect(seated.status(), await seated.text()).toBe(200);
  }
  await page.goto('/#office');
  await expect(page.locator('.tag .nt')).toHaveCount(16);
  await expect(page.locator('.flrow .fldet').first()).toContainText('Running tests');

  // The same page with nothing happening. If this is low, the test browser can't draw smoothly
  // and the number under load says nothing about the app.
  const idle = await framesPerSecond(page, 1000);
  console.log(`frame rate with 16 agents, idle: ${idle.toFixed(1)} fps`);
  expect(idle, 'the idle floor, before any load').toBeGreaterThan(50);

  // 2,000 events while measuring frames.
  const frames = framesPerSecond(page, 3000);
  const sends: Promise<unknown>[] = [];
  for (let n = 0; n < 2000; n++) {
    sends.push(
      hub({ agent: `perf-${n % 16}`, state: 'editing', tool: 'edit', summary: `Edit ${n}` }),
    );
    if (sends.length === 32) await Promise.all(sends.splice(0));
  }
  await Promise.all(sends);
  const fps = await frames;
  console.log(`frame rate with 16 agents under load: ${fps.toFixed(1)} fps`);
  expect(fps, 'the floor under load').toBeGreaterThan(30);

  // The page caught up: every agent shows its new state, and the last event of the last agent
  // is the newest in its list.
  await expect(page.locator('.flrow .fldet')).toHaveCount(16);
  for (const detail of await page.locator('.flrow .fldet').all()) {
    await expect(detail).toContainText('Editing');
  }
  await page.locator('.flrow', { hasText: 'Perf 15' }).click();
  await expect(page.getByText('Edit 1999', { exact: true }).first()).toBeVisible();
});
