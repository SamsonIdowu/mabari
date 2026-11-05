// SPDX-License-Identifier: Apache-2.0
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
  await request.post('/api/demo/load');
});

test('a brief, a file and a folder become a team that waits for its plan', async ({ page }) => {
  await page.goto('/#office');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await expect(dialog).toContainText('What should the team work on?');

  // A CLAUDE.md becomes the instructions.
  await dialog.locator('#bFileInput').setInputFiles({
    name: 'CLAUDE.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# How we work\n- Run the tests before every commit.'),
  });
  await expect(dialog.locator('#bInstr')).toHaveValue(/Run the tests before every commit/);
  await expect(dialog.locator('#bInstrNote')).toContainText('Taken from CLAUDE.md');

  // A local folder is looked at on the server; nothing is cloned.
  await dialog.locator('#bRepoSrc').fill(resolve('.'));
  await dialog.getByRole('button', { name: 'Attach', exact: true }).click();
  await expect(dialog.locator('.repocard')).toContainText('TypeScript');

  await dialog.getByRole('button', { name: /landing page for our coffee shop/ }).click();
  const card = dialog.locator('.plancard');
  await expect(card).toContainText('Estimated time to completion: about');
  await expect(dialog).toContainText('I read 1 file, the web repository');
  const start = card.getByRole('button', { name: /Start project with 3 agents/ });
  await expect(start).toBeVisible();

  // Unticking someone changes the team and the server's estimate.
  const before = await card.locator('.eta b').textContent();
  await card.locator('.prow input[type="checkbox"]').first().uncheck();
  await expect(card.getByRole('button', { name: /Start project with 2 agents/ })).toBeVisible();
  await expect(card.locator('.eta b')).not.toHaveText(before ?? '');

  // A follow-up renames it.
  await dialog.locator('#briefText').fill('call it Bean counter');
  await dialog.locator('#briefText').press('Enter');
  await expect(dialog.locator('#bpName')).toHaveValue('Bean counter');

  await card.getByRole('button', { name: /Start project with/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.dd').first()).toContainText('Bean counter');
  // Plan first: the lead posts its plan before anyone else joins.
  await expect(page.locator('.board')).toContainText('Approve the plan for Bean counter', {
    timeout: 15_000,
  });
  await expect(page.locator('.tag .nt:visible')).toHaveCount(1);
  await page.locator('.board').getByText('Approve the plan for Bean counter').click();
  const approval = page.getByRole('dialog');
  await expect(approval).toContainText('Review everything together before calling it done');
  await approval.getByRole('button', { name: /Allow/ }).click();
  await expect(page.locator('.tag .nt:visible')).toHaveCount(2, { timeout: 15_000 });
});

test('the project can start right away, and a bad folder is explained', async ({ page }) => {
  await page.goto('/#office');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.locator('#bRepoSrc').fill('code/shop');
  await dialog.getByRole('button', { name: 'Attach', exact: true }).click();
  await expect(dialog.locator('#bRepoSrcHint')).toContainText('Use a full path');
  await dialog.getByRole('button', { name: 'Start right away' }).click();
  await dialog
    .locator('#briefText')
    .fill('Build an internal dashboard that shows weekly sales by region');
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await dialog
    .locator('.plancard')
    .getByRole('button', { name: /Start project with 3 agents/ })
    .click();
  await expect(page.locator('.tag .nt:visible')).toHaveCount(3, { timeout: 15_000 });
});
