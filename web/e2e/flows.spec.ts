// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
});

async function loadDemo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.locator('.tag .nt').first()).toBeVisible();
}

const message = (page: Page) => page.getByLabel('Message', { exact: true });

/** Clicks an agent on the floor, which opens its panel with Instruct and Query at the bottom. */
async function target(page: Page, name: string) {
  const tag = (await page.locator('.tag', { hasText: name }).first().boundingBox())!;
  await page.mouse.click(tag.x + tag.width / 2, tag.y - 24);
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await expect(panel.getByRole('heading', { name, exact: true })).toBeVisible();
}

test('flow a: an instruction reaches an agent straight away', async ({ page }) => {
  await loadDemo(page);
  await target(page, 'Scout');
  await message(page).fill('Add the pricing pages');
  await page.getByRole('button', { name: 'Send instruction' }).click();
  await expect(page.getByText('Sent to Scout')).toBeVisible();
  await expect(page.locator('.bub.reply')).toContainText("Got it. I'll add the pricing pages.");
});

test('the reply to an instruction can be read in full in the agent panel', async ({ page }) => {
  await loadDemo(page);
  await target(page, 'Scout');
  await message(page).fill('Add the pricing pages');
  await page.getByRole('button', { name: 'Send instruction' }).click();
  // Sending to one agent opens its panel, and the reply shows there as it lands.
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await expect(panel.getByRole('heading', { name: 'Scout', exact: true })).toBeVisible();
  const item = panel.locator('.askitem').first();
  await expect(item).toContainText('“Add the pricing pages”');
  await expect(item.getByTestId('agentReply')).toHaveText("Got it. I'll add the pricing pages.");
  // So the toast that points to the reply doesn't repeat it: "Sent to Scout" is the one toast.
  await expect(page.getByText('Sent to Scout')).toBeVisible();
  await expect(page.getByText('Scout replied. Open Scout to read it.')).toHaveCount(0);
  await page.getByRole('link', { name: 'Activity log' }).click();
  await expect(page.locator('tr', { hasText: 'Add the pricing pages' })).toContainText('Replied');
});

test('an instruction to an agent stopped by an error starts it, so its reply is true', async ({
  page,
}) => {
  await loadDemo(page);
  await target(page, 'Mori');
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await expect(panel).toContainText('Lost connection to the embedding service');
  await expect(panel.getByRole('button', { name: 'Retry' })).toBeVisible();
  await message(page).fill('Index the docs again without the embedding service');
  await page.getByRole('button', { name: 'Send instruction' }).click();
  await expect(panel.getByTestId('agentReply')).toContainText('Got it');
  // It said it had the instruction, and it did what it said: the error is gone and it is working.
  await expect(panel).not.toContainText('Lost connection to the embedding service');
  await expect(panel.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  await expect(page.locator('.tag', { hasText: 'Mori' })).not.toContainText('stopped');
});

test('flow b: instructions to busy Claude agents wait for a checkpoint', async ({ page }) => {
  await loadDemo(page);
  await target(page, 'Ledger');
  await message(page).fill('Round to whole cents');
  await page.getByRole('button', { name: 'Send instruction' }).click();
  await expect(page.getByText('Queued for Ledger.')).toBeVisible();
  const tag = page.locator('[data-o]', { hasText: 'Ledger' }).locator('.qd');
  await expect(tag).toBeVisible();
  await expect(page.locator('.tag .qd:visible')).toHaveCount(2);
  await page.getByRole('link', { name: 'Activity log' }).click();
  await expect(page.locator('tr', { hasText: 'Round to whole cents' })).toContainText(
    'Waiting for checkpoint',
  );
});

test('flow c: a query is answered from the log, with links to the events', async ({ page }) => {
  await loadDemo(page);
  await target(page, 'Ledger');
  await page.getByRole('button', { name: 'Query' }).click();
  await message(page).fill('How is it going?');
  await page.locator('.cmdbar').getByRole('button', { name: 'Ask', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  const answer = panel.locator('.answer');
  await expect(answer).toContainText('Answered from the log');
  await expect(answer).toContainText('How is it going?');
  await expect(answer).toContainText('Ledger was not interrupted.');
  await answer.locator('.evlink').first().click();
  await expect(panel.locator('.fe.hl')).toBeVisible();
  await answer.getByRole('button', { name: 'Dismiss' }).click();
  await expect(answer).toBeHidden();
});

test('flow d: approving and denying from the notice board', async ({ page }) => {
  await loadDemo(page);
  await page.locator('.bitem').click();
  const card = page.getByRole('dialog');
  await expect(card).toContainText('Atlas wants to run a command');
  await expect(card).toContainText('$ npm run db:migrate -- --env=staging');
  await expect(card).toContainText('Risky');
  await card.getByRole('button', { name: 'Allow once' }).click();
  await expect(card).toBeHidden();
  await expect(page.getByText('Atlas is continuing')).toBeVisible();
  // Nothing is waiting, so the card goes back to a grey bell.
  await expect(page.getByRole('button', { name: 'Nothing needs approval' })).toBeVisible();
  await page.getByRole('link', { name: 'Activity log' }).click();
  await expect(page.locator('tr', { hasText: 'db:migrate' })).toContainText('Allowed');
});

test('denying sends the agent back to thinking', async ({ page }) => {
  await loadDemo(page);
  await page.locator('.bitem').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Deny' }).click();
  await expect(page.locator('.bub.reply')).toContainText("Understood. I'll find another way.");
});

test('flow e: low risk auto approve leaves risky actions waiting', async ({ page }) => {
  await loadDemo(page);
  await page.getByRole('button', { name: 'Auto approve' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Turn on auto approve' }).click();
  await expect(page.getByRole('button', { name: 'Auto approve: low risk' })).toBeVisible();
  await expect(page.locator('.banner.amber')).toContainText('Risky actions still wait for you.');
  await expect(page.locator('.board')).toContainText('Atlas');
  await page.locator('.bitem').click();
  await expect(page.getByRole('dialog')).toContainText(
    'Auto approve skips risky actions, so this one still needs you.',
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await page.locator('.banner.amber').getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByRole('button', { name: 'Auto approve', exact: true })).toBeVisible();
});

test('the auto approve banner can be hidden and the header keeps showing it is on', async ({
  page,
}) => {
  await loadDemo(page);
  await page.getByRole('button', { name: 'Auto approve' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn on auto approve' }).click();
  await page.getByRole('button', { name: 'Hide this message' }).click();
  await expect(page.locator('.banner.amber')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Auto approve: low risk' })).toBeVisible();
});

test('the auto approve banner goes away by itself', async ({ page }) => {
  await loadDemo(page);
  await page.clock.install();
  await page.getByRole('button', { name: 'Auto approve' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn on auto approve' }).click();
  await expect(page.locator('.banner.amber')).toBeVisible();
  await page.clock.fastForward(8100);
  await expect(page.locator('.banner.amber')).toBeHidden();
});

test('approving everything needs the box ticked', async ({ page }) => {
  await loadDemo(page);
  await page.getByRole('button', { name: 'Auto approve' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Everything, including risky actions').click();
  const confirm = dialog.getByRole('button', { name: 'Turn on auto approve' });
  await expect(confirm).toBeDisabled();
  await dialog.getByText('I understand agents can delete files').click();
  await confirm.click();
  await expect(page.getByText('Auto approve is on. 1 waiting approval was approved')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nothing needs approval' })).toBeVisible();
});

test('Instruct and Query live in the agent panel and address that agent', async ({ page }) => {
  await loadDemo(page);
  // No message bar under the office until an agent is chosen, and none after.
  await expect(page.locator('.cmdbar')).toHaveCount(0);
  await target(page, 'Scout');
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await expect(panel.locator('.cmdbar')).toHaveCount(1);
  await expect(panel.getByRole('group', { name: 'Message type' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Interrupt' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect(page.getByLabel('Send to')).toHaveCount(0);
  await expect(message(page)).toHaveAttribute('placeholder', 'Tell Scout what to do');
  await message(page).fill('Look at the docs');
  await page.getByRole('button', { name: 'Send instruction' }).click();
  await expect(page.getByText('Sent to Scout')).toBeVisible();
  await expect(panel.locator('.fe').first()).toContainText('Received: Look at the docs');
  await page.keyboard.press('Escape');
  await expect(page.locator('.cmdbar')).toHaveCount(0);
});

test('escape closes an open approval card', async ({ page }) => {
  await loadDemo(page);
  await page.locator('.bitem').click();
  await expect(page.getByRole('dialog')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('.board')).toContainText('Atlas');
});

test('escape closes one layer at a time', async ({ page }) => {
  await loadDemo(page);
  // Atlas needs an approval, so choosing it opens the card over its panel.
  const tag = (await page.locator('.tag', { hasText: 'Atlas' }).first().boundingBox())!;
  await page.mouse.click(tag.x + tag.width / 2, tag.y - 24);
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});

test('an approval card closes when its approval is settled elsewhere', async ({
  page,
  request,
}) => {
  await loadDemo(page);
  await page.locator('.bitem').click();
  const card = page.getByRole('dialog');
  await expect(card).toBeVisible();
  await request.post('/api/auto-approve', {
    data: { on: true, scope: 'all', acknowledged: true },
  });
  await expect(card).toBeHidden();
  await request.post('/api/auto-approve', {
    data: { on: false, scope: 'all', acknowledged: false },
  });
});

test('clicking an agent that needs approval opens the card', async ({ page }) => {
  await loadDemo(page);
  const tag = (await page.locator('.tag', { hasText: 'Atlas' }).first().boundingBox())!;
  await page.mouse.click(tag.x + tag.width / 2, tag.y - 24);
  await expect(page.getByRole('dialog')).toContainText('Atlas wants to run a command');
});
