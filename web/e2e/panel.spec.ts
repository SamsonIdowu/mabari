// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
});

async function open(page: Page, name: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  const tag = page.locator('.tag', { hasText: name }).first();
  await expect(tag).toBeVisible();
  const box = (await tag.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y - 24);
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await expect(panel.getByRole('heading', { name, exact: true })).toBeVisible();
  // Clicking an agent that needs approval also opens its card.
  const card = page.getByRole('dialog');
  if (await card.isVisible()) await card.getByRole('button', { name: 'Close' }).click();
  return panel;
}

test('clicking an agent on the floor opens its panel', async ({ page }) => {
  const panel = await open(page, 'Ledger');
  await expect(panel).toContainText('Refactor invoice totals to use whole cents');
  await expect(panel).toContainText('Checkout revamp');
  await expect(panel).toContainText('~/code/shop');
  await expect(panel).toContainText('Running for');
  await expect(panel).toContainText(/About \d+ min left, done around \d\d:\d\d/);
  await expect(panel).toContainText(/Likely between \d+ and \d+ min\./);
  await expect(panel).toContainText('Est. at API price');
  await expect(panel.locator('.toolchip').first()).toBeVisible();
  await panel.getByRole('button', { name: 'Close panel' }).click();
  await expect(panel).toBeHidden();
});

test('a lead shows its whole team estimate and its office', async ({ page }) => {
  const panel = await open(page, 'Atlas');
  await expect(panel).toContainText('Paused until you decide on the approval');
  await expect(panel).toContainText(/Whole team: Atlas and its subagents should be done in about/);
  await panel.getByRole('button', { name: "Open Atlas's office" }).click();
  await expect(page.locator('.tag .nt:visible')).toHaveCount(2);
  await expect(page.locator('.banner', { hasText: 'Inside' })).toContainText('1 subagent');
  await expect.poll(async () => page.locator('#zoomPct').textContent()).not.toBe('100%');
  await page.getByRole('button', { name: 'Back to the full floor' }).click();
  await expect(page.locator('.banner', { hasText: 'Inside' })).toBeHidden();
});

test('a subagent links back to its lead', async ({ page }) => {
  const panel = await open(page, 'Atlas');
  await panel.getByRole('button', { name: /Atlas scribe/ }).click();
  await expect(panel).toContainText('Helper of Atlas');
  await expect(panel.getByRole('button', { name: /Atlas's office/ })).toBeVisible();
});

test('the decision trail is built from real events', async ({ page }) => {
  const panel = await open(page, 'Ledger');
  await panel.getByRole('button', { name: 'Decision trail' }).click();
  await expect(panel).toContainText('How Ledger got here');
  await expect(panel.locator('.tstep').first()).toContainText('Refactor invoice totals');
  await expect(panel.locator('.tstep', { hasText: 'Read src/billing/totals.ts' })).toBeVisible();
  await expect(panel.locator('.tstep').last()).toContainText('Now');
});

test('the conversations tab shows who the agent talks to', async ({ page }) => {
  const panel = await open(page, 'Ledger');
  await panel.getByRole('button', { name: 'Conversations' }).click();
  await expect(panel).toContainText("Ledger's conversations");
  await expect(panel.getByRole('link', { name: /Sage · \d+/ })).toBeVisible();
  await expect(panel.locator('.cmsg').first()).toContainText('Are you touching src/api/routes.ts');
});

test('adding subagents stops at three', async ({ page }) => {
  const panel = await open(page, 'Atlas');
  const add = async (name: string) => {
    await panel.getByRole('button', { name: 'Add subagent' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByLabel('Task').fill('Help out');
    await dialog.getByRole('button', { name: 'Add subagent' }).click();
    return dialog;
  };
  await (await add('One')).waitFor({ state: 'hidden' });
  await expect(page.getByText("One joined Atlas's office")).toBeVisible();
  await (await add('Two')).waitFor({ state: 'hidden' });
  const fourth = await add('Three');
  await expect(fourth).toContainText("Atlas's office is full. Three subagents at most.");
  await fourth.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.tag .nt:visible')).toHaveCount(12);
});

test('duplicate subagent names are refused', async ({ page }) => {
  const panel = await open(page, 'Ledger');
  await panel.getByRole('button', { name: 'Add subagent' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Sage');
  await dialog.getByRole('button', { name: 'Add subagent' }).click();
  await expect(dialog).toContainText('There is already an agent called Sage.');
});

test('agent settings save and show in the panel', async ({ page }) => {
  const panel = await open(page, 'Ledger');
  await panel.getByRole('button', { name: 'Agent settings' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Model', { exact: true }).selectOption('claude-opus-4-1');
  await dialog.getByLabel('Project').selectOption('docs');
  await dialog.getByLabel('Working folder').fill('~/code/next');
  await dialog.getByText('Browse the web').click();
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText("Ledger's settings saved")).toBeVisible();
  await expect(panel).toContainText('claude-opus-4-1');
  await expect(panel).toContainText('Docs site');
  await expect(panel).toContainText('~/code/next');
});

test('a bad folder is explained', async ({ page }) => {
  const panel = await open(page, 'Ledger');
  await panel.getByRole('button', { name: 'Agent settings' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Working folder').fill('not a folder');
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(dialog).toContainText("That doesn't look like a folder path.");
});

test('interrupt pauses an agent', async ({ page }) => {
  const panel = await open(page, 'Ledger');
  await panel.getByRole('button', { name: 'Interrupt' }).click();
  await expect(panel).toContainText('Interrupted, waiting for your instruction');
  await expect(panel.getByRole('button', { name: 'Interrupt' })).toBeDisabled();
});

test('stop asks first, and the agent leaves the office', async ({ page }) => {
  const panel = await open(page, 'Ledger');
  await panel.getByRole('button', { name: 'Stop' }).click();
  await panel.getByRole('button', { name: 'Keep running' }).click();
  await panel.getByRole('button', { name: 'Stop' }).click();
  await expect(panel).toContainText('Stop Ledger? This ends the session.');
  await panel.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByText('Ledger stopped and left the office')).toBeVisible();
  await expect(panel).toBeHidden();
  await expect(page.locator('.tag', { hasText: 'Ledger' })).toHaveCount(0, { timeout: 12_000 });
});

test('retry clears an error', async ({ page }) => {
  const panel = await open(page, 'Mori');
  await expect(panel).toContainText('Lost connection to the embedding service');
  await panel.getByRole('button', { name: 'Retry' }).click();
  await expect(panel).toContainText('Thinking');
});

test('the panel shows a queued instruction', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await page.locator('.subrow', { hasText: 'Sage' }).first().click();
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await expect(panel.locator('.queued')).toContainText('Also add a changelog entry');
});
