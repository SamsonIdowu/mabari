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

test('on Home, the project picker scopes what Mabari dispatches', async ({ page, request }) => {
  await request.post('/api/demo/load');
  const sent: { text: string; projectId: string }[] = [];
  page.on('request', (call) => {
    if (call.url().endsWith('/api/vee')) sent.push(call.postDataJSON());
  });
  await page.goto('/#home');
  await expect(page.locator('#homeSum')).toContainText('working');
  await page.locator('#hcType').click();
  const box = page.getByLabel('Message Mabari');
  const said = page.locator('#veeSay');
  // With All projects, Mabari asks when nothing tells it which project.
  await box.fill('make it faster');
  await box.press('Enter');
  await expect(said).toContainText('Which project is this for?');
  await said.getByRole('button', { name: 'Docs site' }).click();
  await expect(said).toContainText('in Docs site');
  // Picking a project sends its id with every message, and the dispatch stays inside it.
  await page.locator('#homeProjBtn').click();
  const menu = page.locator('#homeProjMenu');
  await expect(menu.locator('.gmhead')).toHaveText('Send to project');
  await expect(menu.getByRole('button').first()).toHaveText('All projects · Mabari picks');
  await expect(menu.getByRole('button').last()).toHaveText('+ New project');
  await menu.getByRole('button', { name: 'Test coverage' }).click();
  await expect(page.locator('.toast').last()).toContainText(
    'Instructions now go to Test coverage.',
  );
  await expect(page.locator('#homeProjLbl')).toHaveText('Test coverage');
  await box.fill('make it faster');
  const answered = page.waitForResponse((response) => response.url().endsWith('/api/vee'));
  await box.press('Enter');
  // The agent there may reply before this looks, so check what Mabari answered.
  const reply = (await (await answered).json()).reply;
  expect(reply.project.name).toBe('Test coverage');
  expect(reply.text).toContain('in Test coverage');
  const tests = (await (await request.get('/api/snapshot')).json()).projects.find(
    (project: { name: string }) => project.name === 'Test coverage',
  );
  expect(sent.at(-1)).toEqual({ text: 'make it faster', projectId: tests.id });
  // Status questions answer for the project.
  const ask = async (text: string) => {
    await box.fill(text);
    const response = page.waitForResponse((call) => call.url().endsWith('/api/vee'));
    await box.press('Enter');
    return (await (await response).json()).reply as { text: string };
  };
  expect((await ask("what's happening?")).text).toContain('in Test coverage');
  // Naming a project wins over the one picked.
  expect((await ask('send update the changelog to Docs site')).text).toContain('in Docs site');
  await page.locator('#homeProjBtn').click();
  await menu.getByRole('button', { name: /All projects/ }).click();
  await expect(page.locator('#homeProjLbl')).toHaveText('All projects');
});
