// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
  await request.post('/api/demo/load');
});

const panel = (page: Page) => page.getByRole('complementary', { name: 'Agent details' });
const list = (page: Page) => page.getByRole('complementary', { name: 'Everyone on the floor' });
const entry = (page: Page, name: string) =>
  list(page)
    .getByRole('button')
    .filter({ has: page.locator('.flname', { hasText: new RegExp(`^${name}$`) }) });

const projectMenu = (page: Page) => page.locator('.obar2 .dd', { hasText: 'Project' }).first();

async function office(page: Page) {
  await page.goto('/#office');
  await expect(page.locator('.tag .nt').first()).toBeVisible();
}

test('the office filters come back after a reload', async ({ page }) => {
  await office(page);
  const status = page.getByRole('group', { name: 'Agent status' });
  await status.getByRole('button', { name: /Working/ }).click();
  await projectMenu(page).click();
  await page.getByRole('menuitemradio', { name: /Checkout revamp/ }).click();
  await expect(status.getByRole('button', { name: /Working/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.reload();
  await expect(page.locator('.tag .nt').first()).toBeVisible();
  await expect(status.getByRole('button', { name: /Working/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(projectMenu(page)).toContainText('Checkout revamp');
  // Clearing them is remembered too.
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.reload();
  await expect(status.getByRole('button', { name: /Everyone/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(projectMenu(page)).toContainText('All projects');
});

test('a remembered project or model the office no longer has is dropped', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'mabari.view',
      JSON.stringify({ project: 'deleted-project', model: 'a-model-nobody-uses', status: 'needs' }),
    );
  });
  await page.goto('/#office');
  await expect(projectMenu(page)).toContainText('All projects');
  await expect(page.locator('.obar2 .dd', { hasText: 'Models' })).toContainText('All models');
  // The floor is not left empty: it shows everyone, and the list beside it has the agents.
  await expect(list(page).getByRole('button').first()).toBeVisible();
  // What is still valid stays.
  await expect(
    page.getByRole('group', { name: 'Agent status' }).getByRole('button', { name: /Needs me/ }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('the Projects and Conversations tabs come back after a reload', async ({ page }) => {
  await page.goto('/#projects');
  const shown = page.getByRole('group', { name: 'Show projects' });
  await shown.getByRole('button', { name: /^Open/ }).click();
  await page.reload();
  await expect(shown.getByRole('button', { name: /^Open/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.goto('/#conversations');
  await page.locator('.ptab', { hasText: 'Docs site' }).click();
  await page.reload();
  await expect(page.locator('.ptab', { hasText: 'Docs site' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('the agent that is open is in the address: reload keeps it, Back closes it, a link opens it', async ({
  page,
  context,
}) => {
  await office(page);
  await entry(page, 'Ledger').click();
  await expect(panel(page).getByRole('heading', { name: 'Ledger', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#office\?agent=/);
  const link = page.url();

  await page.reload();
  await expect(panel(page).getByRole('heading', { name: 'Ledger', exact: true })).toBeVisible();

  // Back closes the panel, and Forward opens it again.
  await page.goBack();
  await expect(panel(page)).toBeHidden();
  await expect(page).toHaveURL(/#office$/);
  await page.goForward();
  await expect(panel(page).getByRole('heading', { name: 'Ledger', exact: true })).toBeVisible();

  // The panel's own close takes the step back out of history, as Back does.
  await panel(page).getByRole('button', { name: 'Close panel' }).click();
  await expect(panel(page)).toBeHidden();
  await expect(page).toHaveURL(/#office$/);
  await page.goBack();
  await expect(page).not.toHaveURL(/agent=/);

  // A link opens the agent in a new tab, and a bare #office still works there.
  const other = await context.newPage();
  await other.goto(link);
  await expect(panel(other).getByRole('heading', { name: 'Ledger', exact: true })).toBeVisible();
  await other.goto('/#office');
  await expect(other.locator('.tag .nt').first()).toBeVisible();
  await expect(panel(other)).toBeHidden();
  await other.close();
});

test('opening an agent from Home puts it in the address and Back returns to Home', async ({
  page,
}) => {
  await page.goto('/#home');
  await page.locator('#hcType').click();
  await page.getByLabel('Message Mabari').fill('status');
  await page.getByLabel('Message Mabari').press('Enter');
  await page.locator('#veeSay .linkbtn').first().click();
  await expect(page).toHaveURL(/#office\?agent=/);
  await expect(panel(page)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#home$/);
});

test('a link to an agent that is not here opens nothing and tidies the address', async ({
  page,
}) => {
  await page.goto('/#office?agent=nobody');
  await expect(page.locator('.tag .nt').first()).toBeVisible();
  await expect(panel(page)).toBeHidden();
  await expect(page).toHaveURL(/#office$/);
});

test('the project chat is in the address too', async ({ page }) => {
  await page.goto('/#projects');
  await page
    .locator('article', { hasText: 'Docs site' })
    .getByRole('button', { name: 'Chat' })
    .click();
  const chat = page.getByRole('complementary', { name: 'Chat with Docs site' });
  await expect(chat).toBeVisible();
  await expect(page).toHaveURL(/#projects\?chat=/);
  const link = page.url();

  await page.reload();
  await expect(chat).toBeVisible();
  await page.goBack();
  await expect(chat).toBeHidden();
  await expect(page).toHaveURL(/#projects$/);

  await page.goto(link);
  await expect(chat).toBeVisible();
});
