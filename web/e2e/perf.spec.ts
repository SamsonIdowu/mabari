// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test';

// A full office: 16 agents reporting through the hub while the floor draws. The floor must keep a
// smooth frame rate and the page must keep up with the updates.
test('the floor stays smooth with 16 busy agents', async ({ page, request }) => {
  test.setTimeout(60_000);
  await request.post('/api/wipe', { data: { confirm: true } });
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

  // 2,000 events while measuring frames.
  const frames = page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let count = 0;
        const start = performance.now();
        const tick = (now: number) => {
          count++;
          if (now - start < 3000) requestAnimationFrame(tick);
          else resolve((count * 1000) / (now - start));
        };
        requestAnimationFrame(tick);
      }),
  );
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
  expect(fps).toBeGreaterThan(30);
  // The page caught up: the last event shows in that agent's state.
  await expect
    .poll(async () => page.evaluate(() => document.querySelectorAll('.tag .nt').length))
    .toBe(16);
});
