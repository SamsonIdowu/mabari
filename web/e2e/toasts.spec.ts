// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from '@playwright/test';
import { wipe } from './support/page.ts';

test.beforeEach(async ({ request }) => {
  await wipe(request);
  await request.post('/api/demo/load');
});

/** Opens an agent's panel by clicking it on the floor. */
async function open(page: Page, name: string) {
  await page.goto('/#office');
  const tag = page.locator('.tag', { hasText: name }).first();
  await expect(tag).toBeVisible();
  const box = (await tag.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y - 24);
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await expect(panel.getByRole('heading', { name, exact: true })).toBeVisible();
  return panel;
}

for (const width of [1440, 1100]) {
  test(`toasts keep clear of the panel's message box at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page, 'Bolt');
    await page.getByLabel('Message', { exact: true }).fill('also add a summary line');
    await page.getByRole('button', { name: 'Send instruction' }).click();
    const toast = page.locator('.toast', { hasText: 'Sent to Bolt' });
    await expect(toast).toBeVisible();

    // Every toast, the whole message box and its Send button: none overlaps another.
    const overlap = await page.evaluate(() => {
      const hits = (a: DOMRect, b: DOMRect) =>
        a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const toasts = [...document.querySelectorAll('.toast')].map((node) =>
        node.getBoundingClientRect(),
      );
      const targets = ['#cmdBar', '#cmdBar button[type="submit"]', '#cmdBar input'].map((query) =>
        document.querySelector(query)!.getBoundingClientRect(),
      );
      return toasts.some((toast) => targets.some((target) => hits(toast, target)));
    });
    expect(overlap).toBe(false);
  });
}

test('the reply is not announced twice when the panel already shows it', async ({ page }) => {
  const panel = await open(page, 'Bolt');
  await page.getByLabel('Message', { exact: true }).fill('also add a summary line');
  await page.getByRole('button', { name: 'Send instruction' }).click();
  await expect(panel.getByTestId('agentReply').first()).toBeVisible();
  await expect(page.locator('.toast', { hasText: 'Sent to Bolt' })).toBeVisible();
  await expect(page.locator('.toast', { hasText: 'Bolt replied' })).toHaveCount(0);
});

test('a reply from an agent whose panel is closed is still announced', async ({
  page,
  request,
}) => {
  await page.goto('/#activity');
  const snapshot = (await (await request.get('/api/snapshot')).json()) as {
    agents: { id: string; name: string }[];
  };
  const bolt = snapshot.agents.find((agent) => agent.name === 'Bolt')!;
  await request.post('/api/messages', {
    data: {
      text: 'also add a summary line',
      mode: 'instruct',
      target: bolt.id,
      projectId: 'all',
      teamId: '',
    },
  });
  await expect(
    page.locator('.toast', { hasText: 'Bolt replied. Open Bolt to read it.' }),
  ).toBeVisible();
});
