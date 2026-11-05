// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from '@playwright/test';

const EMPTY_DESK = { x: 23 * 32 + 30, y: 16 * 32 + 20 };

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
});

async function loadDemo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.locator('.tag .nt').first()).toBeVisible();
}

/** Where a point in the office is on screen at 100% zoom. The floor grows with the office. */
async function onScreen(page: Page, point: { x: number; y: number }) {
  const box = (await page.locator('#floor').boundingBox())!;
  const world = await page.locator('#floor').getAttribute('data-world');
  const [width, height] = (world ?? '').split('x').map(Number);
  const WORLD = { width: width || 1216, height: height || 704 };
  // The office covers the view when the shapes are within 10%, and fits inside otherwise.
  const across = box.width / WORLD.width;
  const down = box.height / WORLD.height;
  const scale =
    Math.max(across, down) / Math.min(across, down) <= 1.1
      ? Math.max(across, down)
      : Math.min(across, down);
  return {
    x: box.x + (box.width - WORLD.width * scale) / 2 + point.x * scale,
    y: box.y + (box.height - WORLD.height * scale) / 2 + point.y * scale,
  };
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Create a new agent' });

/** The Agents page has no New agent button now (the builder is where agents are made), so the
 * dialog is opened from Accounts. Creating an agent there takes you to the office. */
async function openNewAgent(page: Page) {
  await page.goto('/#accounts');
  await page.getByRole('button', { name: 'New agent' }).click();
  await expect(dialog(page)).toBeVisible();
}

test('New agent replaces Start agent everywhere', async ({ page }) => {
  await loadDemo(page);
  await expect(page.locator('.ohead').getByRole('button', { name: 'New agent' })).toHaveCount(0);
  for (const route of ['#office', '#projects', '#accounts']) {
    await page.goto(`/${route}`);
    await expect(page.locator('main')).not.toContainText(/Start (an )?agent/);
  }
  await page.goto('/#accounts');
  await page.getByRole('button', { name: 'New agent' }).click();
  await expect(dialog(page)).toBeVisible();
});

test('creates an agent that walks into the office', async ({ page }) => {
  await loadDemo(page);
  await openNewAgent(page);
  const form = dialog(page);
  await form.getByLabel('Name').fill('Juniper');
  await form.getByLabel('Instructions').fill('Keep the docs tidy');
  await form.getByLabel('Working folder').fill('~/code/docs');
  await form.getByRole('button', { name: 'Create agent' }).click();
  await expect(form).toBeHidden();
  await expect(page.getByText('Juniper is walking in')).toBeVisible();
  await expect(page.locator('.tag .nt', { hasText: 'Juniper' })).toBeVisible();
});

test('a role fills the form without overwriting what you typed', async ({ page }) => {
  await loadDemo(page);
  await openNewAgent(page);
  const form = dialog(page);
  await expect(form.locator('.rolebtn b')).toHaveText([
    'Coder',
    'Tester',
    'Reviewer',
    'Docs writer',
    'Researcher',
    'Blank',
  ]);
  await form.getByRole('button', { name: /^Coder/ }).click();
  await expect(form.getByRole('button', { name: /^Coder/ })).toHaveClass(/on/);
  await expect(form.getByLabel('Name')).toHaveValue('Juniper');
  await expect(form.getByLabel('Instructions')).toHaveValue(/Keep changes small and add tests/);
  await expect(form.getByLabel('Run shell commands')).toBeChecked();

  await form.getByRole('button', { name: /^Reviewer/ }).click();
  await expect(form.getByLabel('Name')).toHaveValue('Hazel');
  await expect(form.getByLabel('Edit files')).not.toBeChecked();

  await form.getByLabel('Name').fill('Bramble');
  await form.getByLabel('Instructions').fill('My own words');
  await form.getByRole('button', { name: /^Tester/ }).click();
  await expect(form.getByLabel('Name')).toHaveValue('Bramble');
  await expect(form.getByLabel('Instructions')).toHaveValue('My own words');

  await form.getByLabel('Name').fill('');
  await form.getByRole('button', { name: /^Docs writer/ }).click();
  await expect(form.getByLabel('Name')).toHaveValue('Wren');
});

test('a role picks a free name', async ({ page }) => {
  await loadDemo(page);
  await openNewAgent(page);
  await dialog(page)
    .getByRole('button', { name: /^Coder/ })
    .click();
  await dialog(page).getByRole('button', { name: 'Create agent' }).click();
  await expect(page.locator('.tag .nt', { hasText: 'Juniper' })).toBeVisible();
  await openNewAgent(page);
  await dialog(page)
    .getByRole('button', { name: /^Coder/ })
    .click();
  await expect(dialog(page).getByLabel('Name')).toHaveValue('Juniper 2');
});

test('the server turns down a name already in use', async ({ page }) => {
  await loadDemo(page);
  await openNewAgent(page);
  const form = dialog(page);
  await form.getByLabel('Name').fill('Ledger');
  await form.getByRole('button', { name: 'Create agent' }).click();
  await expect(form.getByRole('alert')).toContainText('There is already an agent called Ledger.');
});

test('clicking an empty desk does nothing: the builder is where agents are made', async ({
  page,
}) => {
  await loadDemo(page);
  const desk = await onScreen(page, EMPTY_DESK);
  await page.mouse.move(desk.x, desk.y);
  await expect(page.locator('#floor')).not.toHaveCSS('cursor', 'pointer');
  await page.mouse.click(desk.x, desk.y);
  await expect(dialog(page)).toBeHidden();
});

test('the model starts on the agent settings and follows a lead', async ({ page }) => {
  await loadDemo(page);
  await openNewAgent(page);
  const model = dialog(page).getByLabel('Model');
  await expect(model.locator('option').first()).toHaveText(/^From agent settings \(.+\)$/);
  await dialog(page)
    .getByLabel('Desk')
    .selectOption({ label: "In Ledger's office, as a subagent" });
  await expect(model.locator('option').first()).toHaveText(/^From Ledger's agent settings \(.+\)$/);
});

test('a desk with an agent never opens the dialog', async ({ page }) => {
  await loadDemo(page);
  const tag = (await page.locator('.tag', { hasText: 'Ledger' }).boundingBox())!;
  await page.mouse.click(tag.x + tag.width / 2, tag.y - 24);
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByRole('complementary', { name: 'Agent details' })).toBeVisible();
});

test('New agent here starts in that project', async ({ page }) => {
  await loadDemo(page);
  await page.goto('/#projects');
  const card = page.locator('article', { hasText: 'Docs site' });
  await card.getByRole('button', { name: 'New agent here' }).click();
  await expect(dialog(page).getByLabel('Project')).toHaveValue('docs');
});

test('with no account the dialog sends you to Accounts', async ({ page, request }) => {
  await request.post('/api/demo/load');
  await request.post('/api/wipe', { data: { confirm: true } });
  await page.goto('/#accounts');
  await page.getByRole('button', { name: 'New agent' }).click();
  const form = dialog(page);
  await expect(form).toContainText('Connect ChatGPT or add an API key first.');
  await expect(form.getByRole('button', { name: 'Create agent' })).toBeDisabled();
});

test('Mark as complete moves a finished project to Completed, and Reopen undoes it', async ({
  page,
  request,
}) => {
  await request.post('/api/demo/load');
  // Rune has finished, so the Docs project is ready once its other agents have stopped.
  const snapshot = (await (await request.get('/api/snapshot')).json()) as {
    agents: { id: string; name: string }[];
  };
  for (const name of ['Scout', 'Mori']) {
    const agent = snapshot.agents.find((item) => item.name === name)!;
    await request.post(`/api/agents/${agent.id}/stop`);
  }
  await page.goto('/#projects');
  const card = page.locator('article', { hasText: 'Docs site' });
  await card.getByRole('button', { name: 'Mark as complete' }).click();
  await page.getByRole('button', { name: /^Completed/ }).click();
  await expect(card).toContainText('What got done');
  await expect(card.getByRole('button', { name: 'New agent here' })).toHaveCount(0);
  await card.getByRole('button', { name: 'Reopen' }).click();
  await expect(page.getByText('Docs site is open again')).toBeVisible();
});

test('a project that cannot be completed says why', async ({ page, request }) => {
  await request.post('/api/demo/load');
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch();
    const snapshot = (await response.json()) as { projects: { id: string; status: string }[] };
    for (const project of snapshot.projects) {
      if (project.id === 'docs') project.status = 'ready';
    }
    await route.fulfill({ response, json: snapshot });
  });
  await page.goto('/#projects');
  await page
    .locator('article', { hasText: 'Docs site' })
    .getByRole('button', { name: 'Mark as complete' })
    .click();
  await expect(page.getByText('this project still has work in progress')).toBeVisible();
});
