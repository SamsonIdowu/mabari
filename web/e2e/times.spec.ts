// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test';
import { wipe } from './support/page.ts';

// A browser set to English (US) writes 07:38 PM by itself. The app writes 19:38 everywhere.
test.use({ locale: 'en-US' });

test.beforeEach(async ({ request }) => {
  await wipe(request);
  await request.post('/api/demo/load');
});

const TWENTY_FOUR_HOUR = /(?<!\d)([01]\d|2[0-3]):[0-5]\d(?! ?[AP]M)/;

test('the project chat and the agent panel show times in 24 hours, as the log does', async ({
  page,
}) => {
  await page.goto('/#projects');
  await page
    .locator('article', { hasText: 'Docs site' })
    .getByRole('link', { name: 'Chat' })
    .click();
  const chat = page.getByRole('log', { name: 'Messages with Docs site' });
  const message = page.getByRole('textbox', { name: 'Message Docs site' });
  await message.fill('Fix the typo in the install guide');
  await message.press('Enter');
  const mine = chat.getByTestId('chatYou').filter({ hasText: 'Fix the typo in the install guide' });
  await expect(mine.locator('.mmeta')).toContainText('You to ', { timeout: 15_000 });
  await expect(mine.locator('.mmeta')).toContainText(TWENTY_FOUR_HOUR);
  await expect(chat.getByTestId('chatAgent').last().locator('.mby')).toContainText(
    TWENTY_FOUR_HOUR,
    { timeout: 15_000 },
  );
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
