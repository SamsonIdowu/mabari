// SPDX-License-Identifier: Apache-2.0
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
});

async function chatWith(page: Page, name: string) {
  await page.goto('/#projects');
  await page.locator('article', { hasText: name }).getByRole('button', { name: 'Chat' }).click();
  const chat = page.getByRole('complementary', { name: `Chat with ${name}` });
  await expect(chat).toBeVisible();
  return chat;
}

test('a project chat sends to the agent working there and shows its reply', async ({
  page,
  request,
}) => {
  await request.post('/api/demo/load');
  const chat = await chatWith(page, 'Docs site');
  await chat.getByLabel('Message Docs site').fill('Fix the typo in the install guide');
  await chat.getByLabel('Message Docs site').press('Enter');
  const messages = chat.getByRole('list', { name: 'Messages' });
  await expect(messages.locator('.pcm.you').last()).toContainText(
    'Fix the typo in the install guide',
  );
  await expect(messages.locator('.pcm.ai').last()).toBeVisible({ timeout: 15_000 });
  await chat.getByRole('button', { name: 'Close the chat' }).click();
  await expect(chat).toBeHidden();
});

test('a slash command opens Claude Code in the project folder', async ({ page, request }) => {
  const created = await (
    await request.post('/api/projects', { data: { name: 'Side shop', color: '#48DBFB' } })
  ).json();
  await request.patch(`/api/projects/${created.id}`, { data: { folder: resolve('.') } });
  const chat = await chatWith(page, 'Side shop');
  await expect(chat).toContainText(resolve('.'));
  await expect(chat.getByRole('button', { name: 'Open Claude Code' })).toBeVisible();
  await chat.getByLabel('Message Side shop').fill('/ux-audit https://example.com/issues/130');
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  // The tests open no terminals, so Mabari says what to run, and keeps no prompt waiting.
  await expect(page.locator('.toast').last()).toContainText(`Run claude in ${resolve('.')}`);
  await expect(chat.locator('.pcm')).toHaveCount(0);
  // A dash could read as a flag, so it is refused.
  await chat.getByLabel('Message Side shop').fill('--dangerously-skip-permissions');
  await chat.getByLabel('Message Side shop').press('Enter');
  await expect(page.locator('.toast').last()).toContainText("A prompt can't start with a dash.");
});

test('a queued instruction can be taken back from the panel', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await page.locator('.subrow', { hasText: 'Sage' }).first().click();
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  const queued = panel.locator('.queued');
  await expect(queued).toContainText('Also add a changelog entry');
  await queued.getByRole('button', { name: /^Remove “Also add a changelog entry/ }).click();
  await expect(queued).toBeHidden();
  await expect(page.locator('.toast').last()).toContainText(
    "Removed from Sage's queue. It won't be delivered.",
  );
});

test('on Home, messages go to the project picked or the one Mabari asks about', async ({
  page,
  request,
}) => {
  await request.post('/api/demo/load');
  await page.goto('/#home');
  await expect(page.locator('#homeSum')).toContainText('working');
  const box = page.getByLabel('Message Mabari');
  // With nothing to go on, Mabari asks which project.
  await box.fill('make it faster');
  await box.press('Enter');
  const said = page.locator('#veeSay');
  await expect(said).toContainText('Which project is this for?');
  await said.getByRole('button', { name: 'Docs site' }).click();
  await expect(said).toContainText('in Docs site');
  // A project picked next to the box takes what follows.
  await page.locator('#hcProject').click();
  await page.locator('#projMenu').getByRole('button', { name: 'Test coverage' }).click();
  await expect(page.locator('#hcProject')).toHaveAccessibleName('Send to: Test coverage');
  await box.fill('make it faster');
  await box.press('Enter');
  await expect(said).toContainText('in Test coverage');
  // Naming a project wins over the one picked.
  await box.fill('send update the changelog to Docs site');
  await box.press('Enter');
  await expect(said).toContainText('in Docs site');
  await page.locator('#hcProject').click();
  await page
    .locator('#projMenu')
    .getByRole('button', { name: 'Let Mabari pick the project' })
    .click();
});
