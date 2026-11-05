// SPDX-License-Identifier: Apache-2.0
// Every dialog that says aria-modal="true" has to behave like one: focus moves in, Tab and
// Shift+Tab stay in, the page behind cannot be reached, and closing puts focus back where it was.
import { expect, test, type Locator, type Page } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
});

async function loadDemo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.locator('.tag .nt').first()).toBeVisible();
}

const list = (page: Page) => page.getByRole('complementary', { name: 'Everyone on the floor' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Agent details' });

/** A line in the list beside the floor, by the exact name on it. */
const entry = (page: Page, name: string) =>
  list(page)
    .getByRole('button')
    .filter({ has: page.locator('.flname', { hasText: new RegExp(`^${name}$`) }) });

/** Focuses a control and presses Enter, as someone using the keyboard does. */
async function press(page: Page, control: Locator) {
  await control.focus();
  await page.keyboard.press('Enter');
}

/** Where a point in the office is on screen at 100% zoom, with the view at rest. */
async function onScreen(page: Page, point: { x: number; y: number }) {
  const box = (await page.locator('#floor').boundingBox())!;
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

/** Waits until the free desk takes a click, then clicks it. */
async function clickFreeDesk(page: Page) {
  await expect(page.locator('.tag .nt')).toHaveCount(10);
  let desk = { x: 0, y: 0 };
  await expect
    .poll(async () => {
      const value = (await page.locator('#floor').getAttribute('data-free-desk')) ?? '';
      const [x, y] = value.split(',').map(Number);
      desk = await onScreen(page, { x: x!, y: y! });
      await page.mouse.move(desk.x, desk.y);
      return page.locator('#floor').evaluate((element) => element.style.cursor);
    })
    .toBe('pointer');
  await page.mouse.click(desk.x, desk.y);
}

const insideDialog = (page: Page) =>
  page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));

/** The dialog that is open: it moves focus in, holds Tab, shuts the page out and gives focus back. */
async function behavesAsModal(page: Page, opener: Locator | null) {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // Focus moved into it without a click or a key.
  await expect.poll(() => insideDialog(page)).toBe(true);

  // The page behind is inert: nothing in it can take focus.
  const behind = await page.evaluate(() => {
    const control = document.querySelector<HTMLElement>('main button, .rail a, .topbar button');
    control?.focus();
    return {
      inert: document.getElementById('root')?.hasAttribute('inert'),
      tookFocus: !!control && document.activeElement === control,
    };
  });
  expect(behind).toEqual({ inert: true, tookFocus: false });
  // The live regions stay outside what is inert, so a toast or a new approval is still heard.
  for (const live of ['.toasts', '#approvalLive']) {
    expect(
      await page.evaluate((selector) => {
        const element = document.querySelector(selector);
        return element ? !!element.closest('[inert]') : null;
      }, live),
      `${live} is inert behind the dialog`,
    ).toBe(false);
  }

  // Tab and Shift+Tab go round, more times than there are stops, and never get out.
  const stops = await dialog
    .locator(
      'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select, textarea, a[href]',
    )
    .count();
  expect(stops).toBeGreaterThan(0);
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let step = 0; step < stops + 3; step++) {
      await page.keyboard.press(key);
      expect(await insideDialog(page), `${key} ${step + 1} left the dialog`).toBe(true);
    }
  }

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert'))).toBe(
    false,
  );
  if (opener) await expect(opener).toBeFocused();
}

test('the approval dialog holds focus and gives it back to Review', async ({ page }) => {
  await loadDemo(page);
  const review = page.locator('#board .bitem').first();
  await expect(review).toBeVisible();
  await press(page, review);
  await behavesAsModal(page, review);
});

test('the auto approve dialog takes focus when it opens, and gives it back', async ({ page }) => {
  await loadDemo(page);
  const button = page.getByRole('button', { name: 'Auto approve' });
  await press(page, button);
  await expect(page.getByRole('dialog', { name: 'Auto approve for all agents' })).toBeVisible();
  await behavesAsModal(page, button);
});

test('the new project dialog holds focus and gives it back', async ({ page }) => {
  await loadDemo(page);
  const button = page.getByRole('button', { name: 'New project' });
  await press(page, button);
  await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible();
  await behavesAsModal(page, button);
});

test('the edit project dialog holds focus and gives it back', async ({ page }) => {
  await loadDemo(page);
  await page.goto('/#projects');
  const edit = page.getByRole('button', { name: /^Edit / }).first();
  await press(page, edit);
  await behavesAsModal(page, edit);
});

test('the agent builder dialog holds focus and gives it back', async ({ page }) => {
  await loadDemo(page);
  await page.goto('/#builder');
  const build = page.locator('#builderPage .phead').getByRole('button', { name: 'Build an agent' });
  await press(page, build);
  await expect(page.getByRole('dialog', { name: 'Build an agent' })).toBeVisible();
  await behavesAsModal(page, build);
});

test('the new agent dialog holds focus and gives it back', async ({ page }) => {
  await loadDemo(page);
  await page.goto('/#accounts');
  const button = page.getByRole('button', { name: 'New agent' });
  await press(page, button);
  await expect(page.getByRole('dialog', { name: 'Create a new agent' })).toBeVisible();
  await behavesAsModal(page, button);
});

test('the agent settings and add subagent dialogs hold focus and give it back', async ({
  page,
}) => {
  await loadDemo(page);
  await press(page, entry(page, 'Ledger'));
  await expect(panel(page).getByRole('heading', { name: 'Ledger', exact: true })).toBeVisible();

  const settings = panel(page).getByRole('button', { name: 'Agent settings' });
  await press(page, settings);
  await expect(page.getByRole('dialog', { name: /Ledger: agent settings/ })).toBeVisible();
  await behavesAsModal(page, settings);

  const add = panel(page).getByRole('button', { name: 'Add subagent' });
  await press(page, add);
  await expect(page.getByRole('dialog', { name: /Add a subagent to Ledger/ })).toBeVisible();
  await behavesAsModal(page, add);
});

test('the desk dialog holds focus', async ({ page }) => {
  await loadDemo(page);
  await clickFreeDesk(page);
  await expect(page.getByRole('dialog', { name: /Start work at desk/ })).toBeVisible();
  // The desk is clicked on the floor, which nothing can focus, so there is no control to return to.
  await behavesAsModal(page, null);
});

test('a dialog opened over another is the only live one, and closing it wakes the first', async ({
  page,
}) => {
  await loadDemo(page);
  // A spoken "allow" can open an approval while another dialog is up. That can't be set up from
  // the page, so this drives the same module the dialogs use, with two stand-in dialogs.
  const states = await page.evaluate(async () => {
    const path = '/src/shell/modalStack.ts';
    const { holdModal, modalHost } = (await import(
      /* @vite-ignore */ path
    )) as typeof import('../src/shell/modalStack.ts');
    const make = (name: string) => {
      const scrim = document.createElement('div');
      scrim.className = 'scrim';
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-label', name);
      for (const end of ['first', 'last']) {
        const button = document.createElement('button');
        button.textContent = `${name} ${end}`;
        dialog.append(button);
      }
      scrim.append(dialog);
      modalHost().append(scrim);
      return scrim;
    };
    const inert = (element: Element | null) => !!element?.hasAttribute('inert');
    const root = document.getElementById('root');
    const opener = document.querySelector<HTMLElement>('.rail a')!;
    opener.focus();
    const first = make('one');
    const second = make('two');
    const releaseFirst = holdModal(first, opener);
    const afterFirst = { root: inert(root), first: inert(first) };
    const releaseSecond = holdModal(second, document.activeElement as HTMLElement);
    const withBoth = {
      root: inert(root),
      first: inert(first),
      second: inert(second),
      focusInSecond: second.contains(document.activeElement),
    };
    // Tab from the last stop in the newest dialog goes to its own first stop.
    (second.querySelectorAll('button')[1] as HTMLElement).focus();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    const wrapped = document.activeElement?.textContent;
    releaseSecond();
    second.remove();
    const afterSecond = {
      root: inert(root),
      first: inert(first),
      focusInFirst: first.contains(document.activeElement),
    };
    releaseFirst();
    first.remove();
    return {
      afterFirst,
      withBoth,
      wrapped,
      afterSecond,
      end: { root: inert(root), host: modalHost().children.length },
      focusBack: document.activeElement === opener,
    };
  });
  expect(states.afterFirst).toEqual({ root: true, first: false });
  expect(states.withBoth).toEqual({ root: true, first: true, second: false, focusInSecond: true });
  expect(states.wrapped).toBe('two first');
  expect(states.afterSecond).toEqual({ root: true, first: false, focusInFirst: true });
  expect(states.end).toEqual({ root: false, host: 0 });
  expect(states.focusBack).toBe(true);
});

test('Close panel gives focus back to the agent in the list', async ({ page }) => {
  await loadDemo(page);
  const row = entry(page, 'Scout');
  await press(page, row);
  await expect(panel(page).getByRole('heading', { name: 'Scout', exact: true })).toBeVisible();
  await panel(page).getByRole('button', { name: 'Close panel' }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(row).toBeFocused();

  // The same by keyboard.
  await press(page, row);
  await expect(panel(page)).toBeVisible();
  await press(page, panel(page).getByRole('button', { name: 'Close panel' }));
  await expect(panel(page)).toHaveCount(0);
  await expect(row).toBeFocused();
});

test('Escape in the panel leaves focus where it was', async ({ page }) => {
  await loadDemo(page);
  const row = entry(page, 'Scout');
  await press(page, row);
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(row).toBeFocused();
});
