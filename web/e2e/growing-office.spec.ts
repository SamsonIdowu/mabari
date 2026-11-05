// SPDX-License-Identifier: Apache-2.0
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

interface Def {
  id: string;
  system: boolean;
}

// Agent files outlive wipes, so each test removes the ones it made.
async function clearDefs(request: APIRequestContext) {
  const snapshot = (await (await request.get('/api/snapshot')).json()) as { defs: Def[] };
  for (const def of snapshot.defs) {
    if (!def.system) await request.delete(`/api/defs/${encodeURIComponent(def.id)}`);
  }
}

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
  await clearDefs(request);
});
test.afterEach(async ({ request }) => clearDefs(request));

async function loadDemo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.locator('.tag .nt').first()).toBeVisible();
}

/** Reports agents through the hub, which seats each one at the next free desk. */
async function hubAgents(request: APIRequestContext, agents: { name: string; state: string }[]) {
  const { token } = (await (await request.post('/api/accounts/hub/token')).json()) as {
    token: string;
  };
  for (const [index, agent] of agents.entries()) {
    // Vite proxies only /api and /ws, so the hub is called on the Go server directly.
    const seated = await request.post(
      `http://127.0.0.1:${process.env.MABARI_API_PORT ?? '4327'}/hub/v1/events`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { agent: `grow-${index}`, name: agent.name, state: agent.state, task: 'Grow' },
      },
    );
    expect(seated.status(), await seated.text()).toBe(200);
  }
}

async function world(page: Page) {
  const value = (await page.locator('#floor').getAttribute('data-world')) ?? '';
  const [width, height] = value.split('x').map(Number);
  return { width: width!, height: height! };
}

test("the office grows only sideways, keeps its agents' size, and scrolls along", async ({
  page,
  request,
}) => {
  await loadDemo(page);
  await expect(page.locator('.tag .nt')).toHaveCount(10);
  const before = await world(page);
  expect(before.height).toBe(704);
  const ledger = page.locator('.tag .nt', { hasText: 'Ledger' });
  const tagHeight = (await ledger.boundingBox())!.height;
  // The demo has ten agents. Twelve more need twenty-two desks: six columns of four.
  await hubAgents(
    request,
    Array.from({ length: 12 }, (_, index) => ({ name: `Grower ${index}`, state: 'editing' })),
  );
  await expect(page.locator('.tag .nt')).toHaveCount(22);
  await expect.poll(async () => (await world(page)).width).toBeGreaterThan(before.width);
  expect((await world(page)).height).toBe(704);
  await expect(page.locator('#officeClock')).toContainText('22 agents');
  // Nobody got smaller to make room.
  expect((await ledger.boundingBox())!.height).toBeCloseTo(tagHeight, 0);
  const stage = (await page.locator('.stage').boundingBox())!;
  for (const tag of await page.locator('.tag .nt').all()) {
    const box = (await tag.boundingBox())!;
    expect(box.y).toBeGreaterThan(stage.y);
    expect(box.y + box.height).toBeLessThan(stage.y + stage.height + 2);
  }
  // The rest of the office is a sideways scroll away, and the bar under the floor says so.
  await expect(page.locator('.oscroll')).toBeVisible();
  const rooms = await page.evaluate(() => {
    const thumb = document.querySelector<HTMLElement>('.oscroll span')!;
    return thumb.style.left;
  });
  expect(parseFloat(rooms)).toBe(0);
  const last = page.locator('.tag .nt', { hasText: 'Grower 11' });
  const from = (await last.boundingBox())!.x;
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.wheel(600, 0);
  await expect.poll(async () => (await last.boundingBox())!.x).toBeLessThan(from - 100);
  // Back to 100% returns to the start of the office.
  await page.keyboard.press('0');
  await expect.poll(async () => Math.abs((await last.boundingBox())!.x - from)).toBeLessThan(30);
});

test('idle agents and agent files with nothing running rest in the lounge', async ({
  page,
  request,
}) => {
  await request.post('/api/defs', {
    data: {
      def: {
        name: 'lounge-reader',
        description: 'Use to read the docs.',
        scope: 'account',
        model: 'inherit',
        tools: ['Read'],
        instructions: 'Read the docs.',
        color: '#7FA8FF',
      },
      previousId: '',
    },
  });
  await loadDemo(page);
  await hubAgents(request, [{ name: 'Napper', state: 'idle' }]);
  const resting = page.locator('.tag.rest', { hasText: 'lounge-reader' });
  await expect(resting).toBeVisible();
  // Mabari's own file never rests there.
  await expect(page.locator('.tag.rest')).toHaveCount(1);
  // An agent file isn't an agent: it isn't counted or tagged like one.
  await expect(page.locator('#officeClock')).toContainText('11 agents');

  // The idle agent walks out of the work area to the lounge, where the agent file rests too.
  const napper = page.locator('.tag .nt', { hasText: 'Napper' });
  const desks = page.locator('.tag .nt', { hasText: 'Ledger' });
  await expect
    .poll(async () => {
      const [mine, file, desk] = await Promise.all([
        napper.boundingBox(),
        resting.boundingBox(),
        desks.boundingBox(),
      ]);
      // Both are out of the work area, roaming the open floor round the lounge.
      return !!mine && !!file && !!desk && mine.x > desk.x + 300 && file.x > desk.x + 300;
    })
    .toBe(true);
  expect((await world(page)).height).toBe(704);

  // Clicking a resting agent file opens it in the builder.
  const tag = (await resting.boundingBox())!;
  await page.mouse.click(tag.x + tag.width / 2, tag.y - 20);
  await expect(page).toHaveURL(/#builder$/);
  await expect(page.locator('.defcard.open', { hasText: 'lounge-reader' })).toBeVisible();
});
