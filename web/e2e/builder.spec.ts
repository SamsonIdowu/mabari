// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

interface Def {
  id: string;
  name: string;
  system: boolean;
}

async function defs(request: APIRequestContext): Promise<Def[]> {
  const snapshot = (await (await request.get('/api/snapshot')).json()) as { defs: Def[] };
  return snapshot.defs;
}

// Agent files outlive wipes, so each test removes the ones it made.
async function clearDefs(request: APIRequestContext) {
  for (const def of await defs(request)) {
    if (!def.system) await request.delete(`/api/defs/${encodeURIComponent(def.id)}`);
  }
}

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
  await clearDefs(request);
});
test.afterEach(async ({ request }) => clearDefs(request));

async function builder(page: Page) {
  await page.goto('/#builder');
  await expect(page.getByRole('heading', { name: 'Agent builder' })).toBeVisible();
}

test('Mabari is always there, as the office manager, saved as a file', async ({ page }) => {
  await builder(page);
  await expect(page.locator('.persist')).toContainText('Saved as files on this computer.');
  const mabari = page.locator('.defcard.sys');
  await expect(mabari).toContainText('Always on');
  await expect(mabari).toContainText('Manager');
  await expect(mabari).toContainText(
    'Office manager and the default agent. Knows every project from its map',
  );
  await expect(mabari.locator('.dcskills')).toBeHidden();
  await mabari.click();
  await expect(mabari).toHaveAttribute('aria-expanded', 'true');
  await expect(mabari.locator('.dcskills')).toContainText('agent-creator');
  await expect(mabari.locator('.dcskills')).toContainText('agent-improver');
  await expect(mabari.locator('.dcpath')).toHaveText(/\/agents\/mabari\.md$/);
  await expect(mabari.getByRole('button', { name: 'Delete' })).toHaveCount(0);
});

test('build an agent with Mabari: nothing is saved until Save', async ({ page, request }) => {
  await builder(page);
  await page.locator('.defcard.sys').click();
  await page.getByRole('button', { name: 'Build an agent with Mabari' }).click();
  const dialog = page.getByRole('dialog', { name: 'Build an agent' });
  await expect(dialog.locator('.mbnote')).toContainText('Tell me what the agent should do');
  await dialog.getByLabel('Describe it and draft').fill('write tests for the checkout totals');
  await dialog.getByRole('button', { name: 'Draft', exact: true }).click();
  await expect(dialog.getByLabel('Name')).toHaveValue('test-writer');
  await expect(dialog.locator('#dfMd')).toContainText('name: test-writer');
  await expect(dialog.locator('#dfPath')).toHaveText('~/.claude/agents/test-writer.md');
  expect((await defs(request)).map((def) => def.name)).toEqual(['mabari']);
  await dialog.getByRole('button', { name: 'Save agent' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.defcard', { hasText: 'test-writer' })).toBeVisible();
  expect((await defs(request)).map((def) => def.name)).toEqual(['mabari', 'test-writer']);
});

test('Improve opens the edit dialog with Mabari suggestions', async ({ page, request }) => {
  await request.post('/api/defs', {
    data: {
      def: {
        name: 'test-writer',
        description: 'Writes tests for new code.',
        scope: 'account',
        model: 'haiku',
        tools: ['Read', 'Edit'],
        instructions: 'Write tests.',
        color: '#3FD07F',
      },
      previousId: '',
    },
  });
  await builder(page);
  const tile = page.locator('.defcard', { hasText: 'test-writer' });
  await tile.click();
  await tile.getByRole('button', { name: 'Improve' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit agent' });
  await expect(dialog.locator('.mbnote')).toContainText('I suggest 5 changes to test-writer');
  await expect(dialog.getByLabel('Run commands')).toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  // Cancelled: the file is as it was. The tile is still open.
  await tile.getByRole('button', { name: 'Edit' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Edit agent' }).getByLabel('Run commands'),
  ).not.toBeChecked();
});

test('tiles are one compact size and open across the row, one at a time', async ({
  page,
  request,
}) => {
  for (const name of ['code-reviewer', 'docs-writer']) {
    await request.post('/api/defs', {
      data: {
        def: {
          name,
          description:
            'Use for a long description that goes on and on so that it would need more than two lines in a compact tile, and then some more words.',
          scope: 'account',
          model: 'sonnet',
          tools: ['Read'],
          instructions: 'Do it.',
          color: '#4FB3FF',
        },
        previousId: '',
      },
    });
  }
  await builder(page);
  const tiles = page.locator('.defcard');
  await expect(tiles).toHaveCount(3);
  const heights = await tiles.evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().height),
  );
  expect(new Set(heights).size).toBe(1);
  const grid = (await page.locator('.defgrid').boundingBox())!;
  const reviewer = tiles.filter({ hasText: 'code-reviewer' });
  await reviewer.click();
  expect((await reviewer.boundingBox())!.width).toBeGreaterThan(grid.width - 20);
  await expect(reviewer.getByRole('button', { name: 'Run' })).toBeVisible();
  const docs = tiles.filter({ hasText: 'docs-writer' });
  await docs.click();
  await expect(reviewer).toHaveAttribute('aria-expanded', 'false');
  // A delete confirmation keeps its tile open.
  await docs.getByRole('button', { name: 'Delete' }).click();
  await expect(docs).toContainText('Its file is removed.');
  await docs.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(tiles).toHaveCount(2);
});

test('a file added outside Mabari shows up, and Reload from disk reports it', async ({ page }) => {
  await builder(page);
  const folder = join(process.env.MABARI_E2E_CLAUDE_DIR!, 'agents');
  writeFileSync(
    join(folder, 'notes-taker.md'),
    '---\nname: notes-taker\ndescription: Use to take notes\ntools: Read\n---\nTake notes.\n',
  );
  await expect(page.locator('.defcard', { hasText: 'notes-taker' })).toBeVisible({ timeout: 6000 });
  await page.getByRole('button', { name: 'Reload from disk' }).click();
  await expect(page.getByText(/Loaded 2 agents: 2 from ~\/.claude\/agents/)).toBeVisible();
});

test('Run starts an agent from a built agent straight away', async ({ page, request }) => {
  await request.post('/api/demo/load');
  await request.post('/api/defs', {
    data: {
      def: {
        name: 'docs-writer',
        description: 'Use to keep the docs in sync.',
        scope: 'account',
        model: 'inherit',
        tools: ['Read', 'Edit'],
        instructions: 'Write docs.',
        color: '#FFB547',
      },
      previousId: '',
    },
  });
  await builder(page);
  const tile = page.locator('.defcard', { hasText: 'docs-writer' });
  await tile.click();
  await tile.getByRole('button', { name: 'Run' }).click();
  await expect(page).toHaveURL(/#office$/);
  await expect(page.getByText('docs-writer is walking in, built from docs-writer')).toBeVisible();
});

test('Home asks Mabari to create or improve an agent', async ({ page }) => {
  await page.goto('/#home');
  await page.locator('#hcType').click();
  await page
    .getByLabel('Message Mabari')
    .fill('create an agent that reviews pull requests for security');
  await page.getByLabel('Message Mabari').press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Build an agent' });
  await expect(dialog.locator('.mbnote')).toContainText('I drafted code-reviewer');
  await expect(page).toHaveURL(/#builder$/);
});

test('an agent can be saved to the Codex account as a TOML file', async ({ page }) => {
  const { readFileSync } = await import('node:fs');
  await builder(page);
  await page.getByRole('button', { name: 'Build an agent' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Build an agent' });
  await dialog.getByText('A Codex agent, as TOML').click();
  await expect(dialog.getByText('Codex account')).toBeVisible();
  await expect(dialog.locator('.toolgrid')).toHaveCount(0);
  await dialog.getByLabel('Name').fill('codex-reviewer');
  await dialog.getByLabel('When should Codex use it?').fill('Use to review pull requests');
  await dialog.getByLabel('Model').selectOption('gpt-5-codex');
  await dialog.getByLabel('Instructions').fill('Review the change. Never edit files.');
  await expect(dialog.locator('#dfPath')).toHaveText('~/.codex/agents/codex-reviewer.toml');
  await expect(dialog.locator('#dfMd')).toContainText('developer_instructions = """');
  await dialog.getByRole('button', { name: 'Save agent' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: /^Codex account/ }).click();
  const tile = page.locator('.defcard', { hasText: 'codex-reviewer' });
  await expect(tile).toContainText('Codex account · every project');
  const file = readFileSync(
    `${process.env.MABARI_E2E_CODEX_DIR}/agents/codex-reviewer.toml`,
    'utf8',
  );
  expect(file).toContain('name = "codex-reviewer"');
  expect(file).toContain('model = "gpt-5-codex"');
});
