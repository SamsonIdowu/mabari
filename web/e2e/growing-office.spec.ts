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

test('the desks grow past sixteen and every agent shows', async ({ page, request }) => {
  await loadDemo(page);
  await expect(page.locator('.tag .nt')).toHaveCount(10);
  expect(await world(page)).toEqual({ width: 1216, height: expect.any(Number) });
  // The demo has ten agents. Twelve more need twenty-two desks: a five by five grid.
  await hubAgents(
    request,
    Array.from({ length: 12 }, (_, index) => ({ name: `Grower ${index}`, state: 'editing' })),
  );
  await expect(page.locator('.tag .nt')).toHaveCount(22);
  await expect.poll(async () => (await world(page)).width).toBe(1216 + 160);
  // The whole floor still fits, so every name tag is inside the office's area.
  const stage = (await page.locator('.stage').boundingBox())!;
  for (const tag of await page.locator('.tag .nt').all()) {
    const box = (await tag.boundingBox())!;
    expect(box.y).toBeGreaterThan(stage.y);
    expect(box.y + box.height).toBeLessThan(stage.y + stage.height + 2);
    expect(box.x + box.width / 2).toBeLessThan(stage.x + stage.width);
  }
  await expect(page.locator('#officeClock')).toContainText('22 agents');
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

  // The idle agent walks to the lounge, below every desk, in the same rows as the agent file.
  const napper = page.locator('.tag .nt', { hasText: 'Napper' });
  const desks = page.locator('.tag .nt', { hasText: 'Ledger' });
  await expect
    .poll(async () => {
      const [mine, file, desk] = await Promise.all([
        napper.boundingBox(),
        resting.boundingBox(),
        desks.boundingBox(),
      ]);
      return !!mine && !!file && !!desk && mine.y > desk.y + 100 && Math.abs(mine.y - file.y) < 120;
    })
    .toBe(true);

  // Clicking a resting agent file opens it in the builder.
  const tag = (await resting.boundingBox())!;
  await page.mouse.click(tag.x + tag.width / 2, tag.y - 20);
  await expect(page).toHaveURL(/#builder$/);
  await expect(page.locator('.defcard.open', { hasText: 'lounge-reader' })).toBeVisible();
});
