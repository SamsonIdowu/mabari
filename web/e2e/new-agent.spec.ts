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

/** Where a point in the office is on screen at 100% zoom, with the view at rest. */
async function onScreen(page: Page, point: { x: number; y: number }) {
  const box = (await page.locator('#floor').boundingBox())!;
  // The office is drawn at the prototype office's scale, its floor under the 58 px wall bar with
  // the 44 px back wall beneath it, and from its left end.
  const across = box.width / 1216;
  const down = box.height / 704;
  const base =
    Math.max(across, down) / Math.min(across, down) <= 1.1
      ? Math.max(across, down)
      : Math.min(across, down);
  const scale = Math.min(base, (box.height - 58) / (704 - 44));
  const top = Math.max((box.height - 704 * scale) / 2, 58 - 44 * scale);
  return { x: box.x + point.x * scale, y: box.y + top + point.y * scale };
}

/** The one free desk on the floor, in the office's own pixels. */
async function freeDesk(page: Page) {
  const value = (await page.locator('#floor').getAttribute('data-free-desk')) ?? '';
  const [x, y] = value.split(',').map(Number);
  return { x: x!, y: y! };
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Create a new agent' });

/** The dialog is opened from Accounts here, so creating an agent takes you to the office. The
 * Agents header opens it too. */
async function openNewAgent(page: Page) {
  await page.goto('/#accounts');
  await page.getByRole('button', { name: 'New agent' }).click();
  await expect(dialog(page)).toBeVisible();
}

test('New agent replaces Start agent everywhere', async ({ page }) => {
  await loadDemo(page);
  // The Agents header has it, next to New project (DAILY-6).
  await expect(page.locator('.ohead').getByRole('button', { name: 'New agent' })).toBeVisible();
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

/** Waits until the free desk takes a click, then clicks it. */
async function clickFreeDesk(page: Page) {
  await expect(page.locator('.tag .nt')).toHaveCount(10);
  // Once everyone has sat down and the view has settled, the free desk takes a click.
  let desk = { x: 0, y: 0 };
  await expect
    .poll(async () => {
      desk = await onScreen(page, await freeDesk(page));
      await page.mouse.move(desk.x, desk.y);
      return page.locator('#floor').evaluate((element) => element.style.cursor);
    })
    .toBe('pointer');
  await page.mouse.click(desk.x, desk.y);
}

test('clicking the free desk puts one of your agents to work there', async ({ page, request }) => {
  await request.post('/api/defs', {
    data: {
      def: {
        name: 'desk-reviewer',
        description: 'Use to review changes.',
        scope: 'account',
        model: 'inherit',
        tools: ['Read'],
        instructions: 'Review.',
        color: '#7FA8FF',
      },
      previousId: '',
    },
  });
  try {
    await loadDemo(page);
    await clickFreeDesk(page);
    const form = page.getByRole('dialog', { name: /Start work at desk/ });
    await expect(form).toBeVisible();
    await form.getByLabel('Agent').selectOption({ label: 'desk-reviewer · account' });
    await form.getByLabel('What should it do?').fill('Review the checkout changes.');
    await form.getByRole('button', { name: 'Start' }).click();
    await expect(form).toBeHidden();
    await expect(page.locator('.tag .nt', { hasText: 'desk-reviewer' })).toBeVisible();
  } finally {
    await request.delete(`/api/defs/${encodeURIComponent('account:desk-reviewer')}`);
  }
});

test('from the free desk you can make a new agent instead', async ({ page }) => {
  await loadDemo(page);
  await clickFreeDesk(page);
  await page
    .getByRole('dialog', { name: /Start work at desk/ })
    .getByRole('button', { name: 'Make a new agent instead' })
    .click();
  const form = dialog(page);
  await expect(form).toBeVisible();
  await form.getByLabel('Name').fill('Deskmate');
  await form.getByLabel('Instructions').fill('Tidy the README.');
  await form.getByRole('button', { name: 'Create agent' }).click();
  await expect(page.locator('.tag .nt', { hasText: 'Deskmate' })).toBeVisible();
});

test('the working folder can be picked from this computer with Browse…', async ({ page }) => {
  const folder = process.env.MABARI_E2E_CLAUDE_DIR!;
  // The system's own folder picker can't be driven in a test, so it answers with a folder.
  await page.route('**/api/folders/pick', (route) => route.fulfill({ json: { path: folder } }));
  await loadDemo(page);
  await openNewAgent(page);
  const form = dialog(page);
  await form.getByRole('button', { name: 'Browse…' }).click();
  await expect(form.getByLabel('Working folder')).toHaveValue(folder);
  // A folder that isn't there is said so, before the agent is made.
  await form.getByLabel('Working folder').fill('/no/such/folder/here');
  await form.getByLabel('Working folder').blur();
  await expect(form.getByRole('alert')).toBeVisible();
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
  // No form that can't succeed: the dialog says what an agent needs, and where to get it.
  await expect(form).toContainText(
    'Connect an account first: sign in with ChatGPT or attach Claude Code.',
  );
  await expect(form).not.toContainText('API key');
  await expect(form.getByRole('button', { name: 'Create agent' })).toHaveCount(0);
  await form.getByRole('link', { name: 'Go to Accounts' }).click();
  await expect(form).toBeHidden();
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
