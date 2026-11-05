// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
  await request.post('/api/demo/load');
});

async function ask(page: Page, text: string) {
  await page.goto('/#home');
  await expect(page.locator('#homeSum')).toContainText('working');
  await page.locator('#hcType').click();
  await page.getByLabel('Message Mabari').fill(text);
  await page.getByLabel('Message Mabari').press('Enter');
  await expect(page.locator('#youSaid')).toHaveText(text);
  await expect(page.locator('#veeSay .typing')).toBeHidden();
}

for (const [width, height] of [
  [1440, 900],
  [1024, 768],
  [390, 844],
] as const) {
  test(`a long reply stays clear of the box and the dock, and scrolls, at ${width} px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await ask(page, 'what is the status?');
    const say = page.locator('#veeSay');
    await expect(say.locator('.hclist li').first()).toBeVisible();
    // Let the bubble settle where the stage puts it.
    await page.waitForTimeout(600);

    const boxes = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const send = document.querySelector('.h2send')!;
      const mid = send.getBoundingClientRect();
      const hit = document.elementFromPoint(mid.x + mid.width / 2, mid.y + mid.height / 2);
      const bubble = rect('#veeSay');
      return {
        sendIsSend: !!hit && send.contains(hit),
        bubble: { top: bubble.top, bottom: bubble.bottom, left: bubble.left, right: bubble.right },
        stage: rect('.h2stage').toJSON() as { top: number; bottom: number },
        field: rect('#hcForm').toJSON() as { top: number },
        dock: rect('.h2dock').toJSON() as { top: number },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    });
    // A click on Send reaches Send, not the reply.
    expect(boxes.sendIsSend).toBe(true);
    // The bubble stays inside the stage, above the box and the dock.
    expect(boxes.bubble.top).toBeGreaterThanOrEqual(boxes.stage.top - 1);
    expect(boxes.bubble.bottom).toBeLessThanOrEqual(boxes.stage.bottom + 1);
    expect(boxes.bubble.bottom).toBeLessThanOrEqual(boxes.field.top);
    expect(boxes.bubble.bottom).toBeLessThanOrEqual(boxes.dock.top);
    expect(boxes.bubble.right).toBeLessThanOrEqual(boxes.viewport.width);
    expect(boxes.bubble.left).toBeGreaterThanOrEqual(0);

    // Every line can be read: the bubble scrolls, and the last agent comes into view.
    const scroller = say.locator('.vsay');
    const items = say.locator('.hclist li');
    await expect(items.first()).toBeVisible();
    const last = items.last();
    await scroller.evaluate((node) => node.scrollTo({ top: node.scrollHeight }));
    const inside = await page.evaluate(() => {
      const body = document.querySelector('#veeSay .vsay')!.getBoundingClientRect();
      const row = [...document.querySelectorAll('#veeSay .hclist li')]
        .at(-1)!
        .getBoundingClientRect();
      return row.top >= body.top - 1 && row.bottom <= body.bottom + 1;
    });
    expect(inside).toBe(true);
    await expect(last).toContainText(/:/);
    // When it scrolls, the keyboard can reach it.
    const scrolls = await scroller.evaluate((node) => node.scrollHeight > node.clientHeight + 1);
    if (scrolls) await expect(scroller).toHaveAttribute('tabindex', '0');
  });
}

test('the acknowledgement stays with the reply, and earlier replies can be read again', async ({
  page,
}) => {
  await ask(page, 'the invoice rounding is wrong');
  const say = page.locator('#veeSay');
  await expect(say).toContainText('On it, sent to Ledger (Claude) in Checkout revamp.');
  // The reply lands a moment later, and the acknowledgement is still there above it.
  await expect(say.locator('p').last()).toContainText('Ledger (Claude) replied: Got it.', {
    timeout: 10_000,
  });
  await expect(say.locator('.vack')).toContainText('On it, sent to Ledger (Claude)');
  await expect(say.locator('.vack')).toContainText("I'll read you the reply the moment it lands.");

  // The pager goes back to the acknowledgement alone, and forward to the reply again.
  const pager = say.locator('.vpager');
  await expect(pager).toContainText('2 of 2 · Reply');
  await pager.getByRole('button', { name: 'Earlier update' }).click();
  await expect(pager).toContainText('1 of 2');
  await expect(say).toContainText('On it, sent to Ledger (Claude)');
  await expect(say).not.toContainText('replied:');
  await pager.getByRole('button', { name: 'Later update' }).click();
  await expect(say).toContainText('Ledger (Claude) replied: Got it.');

  // A new message from you shows the newest reply, not the one you were reading.
  await page.getByLabel('Message Mabari').fill('what is the status?');
  await page.getByLabel('Message Mabari').press('Enter');
  await expect(say.locator('.hclist li').first()).toBeVisible();
  await expect(pager).toContainText('3 of 3');
});
