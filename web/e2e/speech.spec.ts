// SPDX-License-Identifier: Apache-2.0
// Playwright's headless Chromium takes the whole page down if its own speech engine is asked to
// listen (NEW-2). The page has to refuse, with a message, before it asks.
import { expect, test, type Page } from '@playwright/test';
import { wipe } from './support/page.ts';

test.beforeEach(async ({ request }) => {
  await wipe(request);
  await request.post('/api/demo/load');
});

const MESSAGE =
  "This browser is run by a program, with no microphone, so it can't listen. Nothing was recorded.";

/** Home, with the browser's own speech engine in place, as it is in a real browser. */
async function openHome(page: Page) {
  await page.goto('/#home');
  await expect(page.locator('#hcMic')).toBeVisible();
  const own = await page.evaluate(() => {
    const speech = (window as unknown as { webkitSpeechRecognition?: object })
      .webkitSpeechRecognition;
    return !!speech && /\[native code\]/.test(Function.prototype.toString.call(speech));
  });
  expect(own, "the browser's own speech engine is on the page").toBe(true);
}

test('holding Space on Home does not crash the page, and says why nothing was heard', async ({
  page,
}) => {
  let crashed = false;
  page.on('crash', () => (crashed = true));
  await openHome(page);
  await page.locator('.home2').click({ position: { x: 5, y: 5 } });
  await page.keyboard.down('Space');
  await expect(page.getByText(MESSAGE)).toBeVisible();
  await page.keyboard.up('Space');
  expect(crashed).toBe(false);
  // The page still answers.
  await expect(page.locator('#hcMic')).toBeVisible();
  // The demo has agents who need you, so the title leads with how many (features round 1, item 1).
  expect(await page.evaluate(() => document.title)).toMatch(/^(\(\d+\) )?Home · Mabari$/);
});

test('holding the mic button does not crash the page either', async ({ page }) => {
  let crashed = false;
  page.on('crash', () => (crashed = true));
  await openHome(page);
  const box = (await page.locator('#hcMic').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.getByText(MESSAGE)).toBeVisible();
  await page.mouse.up();
  expect(crashed).toBe(false);
  await expect(page.locator('#hcMic')).toBeVisible();
});
