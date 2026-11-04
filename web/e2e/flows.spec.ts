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

async function target(page: Page, name: string) {
  await page.getByLabel('Send to').selectOption({ label: name });
}

test('flow a: an instruction reaches an agent straight away', async ({ page }) => {
  await loadDemo(page);
  await target(page, 'Scout');
  await message(page).fill('Add the pricing pages');
  await page.getByRole('button', { name: 'Send instruction' }).click();
  await expect(page.getByText('Sent to Scout')).toBeVisible();
  await expect(page.locator('.bub.reply')).toContainText("Got it. I'll add the pricing pages.");
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
  await page.getByRole('button', { name: 'Query' }).first().click();
  await target(page, 'Ledger');
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

test('a question to everyone shows the whole team', async ({ page }) => {
  await loadDemo(page);
  await page.getByRole('button', { name: 'Query' }).first().click();
  await target(page, 'Everyone');
  await message(page).fill('Status?');
  await page.locator('.cmdbar').getByRole('button', { name: 'Ask', exact: true }).click();
  const popover = page.locator('.popover');
  await expect(popover).toContainText('No agent was interrupted.');
  await expect(popover).toContainText('Ledger');
  await popover.getByRole('button', { name: 'Close' }).click();
  await expect(popover).toBeHidden();
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
  await expect(page.locator('.board')).toContainText('Nothing waiting. Nice.');
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
  await expect(page.locator('.board')).toContainText('Nothing waiting. Nice.');
});

test('flow f: auto dispatch sends to the best agent and says who', async ({ page }) => {
  await loadDemo(page);
  await expect(page.locator('#dispatchHint')).toBeHidden();
  await message(page).fill('the invoice rounding is wrong');
  await page.getByRole('button', { name: 'Send instruction' }).click();
  await expect(page.getByText(/Dispatcher sent it to Ledger/)).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Agent details' })).toContainText('Ledger');
  await expect(page.getByLabel('Send to')).toHaveValue('selected');
});

// The prototype hides the hint with CSS but keeps it. These bring it back, so it can't rot.
test('the dispatcher hint explains its choice when shown', async ({ page }) => {
  await loadDemo(page);
  await page.addStyleTag({ content: '#dispatchHint{display:flex!important}' });
  const hint = page.locator('#dispatchHint');
  await expect(hint).toContainText('Dispatcher on.');
  await message(page).fill('the invoice rounding is wrong');
  await expect(hint).toContainText('Dispatcher will send this to Ledger because');
});

test('choose someone else moves to the picker', async ({ page }) => {
  await loadDemo(page);
  await page.addStyleTag({ content: '#dispatchHint{display:flex!important}' });
  await message(page).fill('fix the docs');
  await page.getByRole('button', { name: 'Choose someone else' }).click();
  await expect(page.getByLabel('Send to')).toBeFocused();
});

test('the panel sends instructions and questions too', async ({ page }) => {
  await loadDemo(page);
  const tag = (await page.locator('.tag', { hasText: 'Scout' }).boundingBox())!;
  await page.mouse.click(tag.x + tag.width / 2, tag.y - 24);
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await panel.getByLabel('Message to Scout').fill('Look at the docs');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Sent to Scout')).toBeVisible();
  await expect(panel.locator('.fe').first()).toContainText('Received: Look at the docs');
});

test('the Send to picker selects the agent it names', async ({ page }) => {
  await loadDemo(page);
  await target(page, 'Scout');
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await expect(panel.getByRole('heading', { name: 'Scout', exact: true })).toBeVisible();
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
  await target(page, 'Atlas');
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await panel.getByRole('button', { name: 'Review' }).click();
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
