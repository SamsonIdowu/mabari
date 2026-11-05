// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test';

// A browser set to English (US) writes 07:38 PM by itself. The app writes 19:38 everywhere.
test.use({ locale: 'en-US' });

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
  await request.post('/api/demo/load');
});

const TWENTY_FOUR_HOUR = /(?<!\d)([01]\d|2[0-3]):[0-5]\d(?! ?[AP]M)/;

test('the project chat and the agent panel show times in 24 hours, as the log does', async ({
  page,
}) => {
  await page.goto('/#projects');
  await page
    .locator('article', { hasText: 'Docs site' })
    .getByRole('button', { name: 'Chat' })
    .click();
  const chat = page.getByRole('complementary', { name: 'Chat with Docs site' });
  await chat.getByLabel('Message Docs site').fill('Fix the typo in the install guide');
  await chat.getByLabel('Message Docs site').press('Enter');
  const meta = chat.locator('.pcm.you .pcmmeta').last();
  await expect(meta).toContainText('To ');
  await expect(meta).toContainText(TWENTY_FOUR_HOUR);
  await expect(chat.locator('.pcm.ai .pcmmeta').last()).toContainText(TWENTY_FOUR_HOUR, {
    timeout: 15_000,
  });
  await expect(chat).not.toContainText(/\d ?[AP]M\b/);

  await page.goto('/#office');
  const tag = page.locator('.tag', { hasText: 'Scout' }).first();
  await expect(tag).toBeVisible();
  const box = (await tag.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y - 24);
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await page.getByLabel('Message', { exact: true }).fill('Add the pricing pages');
  await page.getByRole('button', { name: 'Send instruction' }).click();
  const item = panel.locator('.askitem').first();
  await expect(item.getByTestId('agentReply')).toBeVisible();
  await expect(item).toContainText(TWENTY_FOUR_HOUR);
  await expect(item).not.toContainText(/\d ?[AP]M\b/);
});
