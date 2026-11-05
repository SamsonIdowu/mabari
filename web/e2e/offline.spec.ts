// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
  await request.post('/api/demo/load');
});

/** Every call to Mabari's API fails, as it does when the server has stopped. */
async function cutOff(page: Page) {
  await page.route(/\/api\//, (route) => route.abort());
}

test('a message that cannot be sent says so and keeps the words in the box', async ({ page }) => {
  await page.goto('/#home');
  await page.locator('#hcType').click();
  const box = page.getByLabel('Message Mabari');
  await box.fill('Please summarise todays work for the team');
  await cutOff(page);
  await box.press('Enter');
  await expect(page.locator('#veeSay')).toContainText(
    "Can't reach Mabari. Your message was not sent.",
  );
  await expect(page.locator('#veeSay')).not.toContainText('Failed to fetch');
  // The message can be sent again without typing it out.
  await expect(box).toHaveValue('Please summarise todays work for the team');
  await expect(page.locator('#youSaid')).toHaveText('Please summarise todays work for the team');
});

test('a setting that cannot be saved says it was not saved', async ({ page }) => {
  await page.goto('/#preferences');
  const toggle = page.getByRole('checkbox', { name: /Read agent replies aloud/ });
  await expect(toggle).toBeVisible();
  await cutOff(page);
  await toggle.click();
  await expect(page.locator('.toast').first()).toHaveText(
    "Can't reach Mabari. Your change was not saved.",
  );
});

test('an approval that cannot be sent says it was not sent, and is still waiting', async ({
  page,
}) => {
  await page.goto('/#office');
  await expect(page.locator('.tag .nt').first()).toBeVisible();
  await page
    .getByRole('complementary', { name: 'Everyone on the floor' })
    .getByRole('button', { name: /^Atlas Needs approval/ })
    .click();
  const dialog = page.getByRole('dialog', { name: /Atlas/ });
  await expect(dialog).toBeVisible();
  await cutOff(page);
  await dialog.getByRole('button', { name: 'Allow once' }).click();
  await expect(page.locator('.toast').first()).toHaveText(
    "Can't reach Mabari. Your decision was not sent. The approval is still waiting.",
  );
  await expect(page.locator('.toast')).not.toContainText('Failed to fetch');
  // The decision never arrived, so Atlas is still waiting for it.
  await expect(
    page
      .getByRole('complementary', { name: 'Everyone on the floor' })
      .getByRole('button', { name: /^Atlas Needs approval/ }),
  ).toBeVisible();
});
