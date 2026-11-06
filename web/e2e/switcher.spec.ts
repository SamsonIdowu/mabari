// SPDX-License-Identifier: Apache-2.0
// The quick switcher: Ctrl K or Command K opens a search box over any screen, to jump to an agent,
// a project or a screen, or to run a plain action. Every jump here is made from the keyboard alone.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { wipe } from './support/page.ts';

declare global {
  interface Window {
    fakeSpeech: { started: number; local: boolean | null; say: (text: string) => void };
  }
}

test.beforeEach(async ({ request }) => {
  await wipe(request);
});

async function loadDemo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.locator('.tag .nt').first()).toBeVisible();
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Jump to' });
const box = (page: Page) => dialog(page).getByRole('combobox');
const results = (page: Page) => dialog(page).getByRole('option');

/** Opens it from the keyboard, as someone does, and waits for the box to have focus. */
async function open(page: Page, key = 'Control+K') {
  await page.keyboard.press(key);
  await expect(dialog(page)).toBeVisible();
  await expect(box(page)).toBeFocused();
}

/** What the option the arrows are on says, read from the box's pointer to it. */
async function activeOption(page: Page): Promise<string> {
  const id = await box(page).getAttribute('aria-activedescendant');
  expect(id).toBeTruthy();
  return (await page.locator(`[id="${id}"]`).textContent()) ?? '';
}

const panel = (page: Page) => page.getByRole('complementary', { name: 'Agent details' });

test('focus is never left on the page after a jump, or after a dialog a jump opened', async ({
  page,
}) => {
  await loadDemo(page);
  const onBody = () => page.evaluate(() => document.activeElement === document.body);

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await open(page);
  await box(page).fill('Ledger');
  await page.keyboard.press('Enter');
  await expect(panel(page)).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('.panel'))))
    .toBe(true);

  await page.getByRole('button', { name: 'Close panel' }).click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await open(page);
  await box(page).fill('New agent');
  await page.keyboard.press('Enter');
  const form = page.getByRole('dialog', { name: 'Create a new agent' });
  await expect(form).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(form).toBeHidden();
  await expect.poll(onBody).toBe(false);
});

test('Ctrl K opens on every screen, Escape closes it, and focus goes back to where it was', async ({
  page,
}) => {
  await loadDemo(page);
  const screens = [
    '#home',
    '#office',
    '#projects',
    '#builder',
    '#conversations',
    '#accounts',
    '#activity',
    '#preferences',
    '#components',
  ];
  for (const hash of screens) {
    await page.evaluate((value) => {
      window.location.hash = value;
    }, hash);
    await expect(page).toHaveURL(new RegExp(`${hash}$`));
    await open(page);
    await expect(dialog(page).getByRole('listbox', { name: 'Results' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
  }

  // Focus returns to the control that had it.
  await page.evaluate(() => {
    window.location.hash = '#office';
  });
  const projects = page.getByRole('link', { name: 'Projects', exact: true });
  await projects.focus();
  await open(page);
  await page.keyboard.press('Escape');
  await expect(projects).toBeFocused();
  // Ctrl K again closes it, and so does the Close button.
  await open(page);
  await page.keyboard.press('Control+K');
  await expect(dialog(page)).toHaveCount(0);
  await open(page, 'Meta+K');
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await expect(dialog(page)).toHaveCount(0);
});

test('the Jump to button in the top bar opens it too, and the page behind is out of reach', async ({
  page,
}) => {
  await loadDemo(page);
  await page.getByRole('button', { name: 'Jump to', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(box(page)).toBeFocused();
  expect(await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert'))).toBe(
    true,
  );
  // Tab goes round inside it: the box, then Close, then back.
  await page.keyboard.press('Tab');
  await expect(dialog(page).getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(box(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Jump to', exact: true })).toBeFocused();
});

test('typing a name and pressing Enter opens that agent', async ({ page }) => {
  await loadDemo(page);
  await open(page);
  await page.keyboard.type('ledger');
  // The agent, and the chat with it in the Chats group: two ways to the same one.
  await expect(results(page)).toHaveCount(2);
  await expect(results(page).first()).toContainText('Ledger');
  await expect(results(page).first()).toContainText('Checkout revamp');
  await expect(results(page).last()).toContainText('Chat with Ledger');
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/#office\?agent=/);
  await expect(panel(page).getByRole('heading', { name: 'Ledger', exact: true })).toBeVisible();
});

test('an agent on another screen is opened on the floor, with the floor widened to show it', async ({
  page,
}) => {
  await loadDemo(page);
  // Docs site only: Ledger is in Checkout revamp, so the floor hides it.
  await page.getByRole('button', { name: /^Project/ }).click();
  await page.getByRole('menuitemradio', { name: /Docs site/ }).click();
  await page.evaluate(() => {
    window.location.hash = '#accounts';
  });
  await open(page);
  await page.keyboard.type('ledger');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#office\?agent=/);
  await expect(panel(page).getByRole('heading', { name: 'Ledger', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Project/ })).toContainText('All projects');
});

test('typing a project and pressing Enter opens the project', async ({ page }) => {
  await loadDemo(page);
  await open(page);
  await page.keyboard.type('docs site');
  // The project's own name is the best match, so its group is first.
  const first = dialog(page).getByRole('group').first();
  await expect(first).toContainText('Projects');
  await expect(first.getByRole('option').first()).toContainText('Docs site');
  await page.keyboard.press('Enter');
  // A project's chat is its thread on the Chats screen, which the old address leads to.
  await expect(page).toHaveURL(/#conversations\?project=docs$/);
  await expect(page.getByRole('log', { name: 'Messages with Docs site' })).toBeVisible();
});

test('typing a screen and pressing Enter opens it', async ({ page }) => {
  await loadDemo(page);
  await open(page);
  await page.keyboard.type('activity');
  await expect(results(page).first()).toContainText('Activity log');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#activity$/);
  await expect(page.locator('main h1')).toContainText('Activity');
  // The rail's own name for a screen finds it too: Chats is Conversations.
  await open(page);
  await page.keyboard.type('chats');
  await expect(results(page).first()).toContainText('Conversations');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#conversations$/);
});

test('the arrow keys move through the results, round the ends, and Enter opens the one chosen', async ({
  page,
}) => {
  await loadDemo(page);
  await open(page);
  await page.keyboard.type('s');
  const count = await results(page).count();
  expect(count).toBeGreaterThan(3);
  await expect(results(page).first()).toHaveAttribute('aria-selected', 'true');
  const first = await activeOption(page);
  await page.keyboard.press('ArrowDown');
  await expect(results(page).nth(1)).toHaveAttribute('aria-selected', 'true');
  expect(await activeOption(page)).not.toBe(first);
  await page.keyboard.press('ArrowUp');
  expect(await activeOption(page)).toBe(first);
  // Up from the first goes to the last, and down from the last to the first.
  await page.keyboard.press('ArrowUp');
  await expect(results(page).nth(count - 1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(results(page).first()).toHaveAttribute('aria-selected', 'true');
  // Exactly one is chosen at a time.
  await expect(dialog(page).locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
  // Typing starts again from the best match.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('e');
  await expect(results(page).first()).toHaveAttribute('aria-selected', 'true');
});

test('New agent, New project, Quiet mode and Switch theme are plain actions that run from the keyboard', async ({
  page,
}) => {
  await loadDemo(page);

  await open(page);
  await page.keyboard.type('new agent');
  await expect(results(page).first()).toContainText('New agent');
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Create a new agent' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await open(page);
  await page.keyboard.type('new project');
  await expect(results(page).first()).toContainText('New project');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: /project/i })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Quiet mode hides the layers on the floor, and the result says whether it is on.
  const layers = () =>
    page.evaluate(() => JSON.parse(window.localStorage.getItem('mabari.layers') ?? '{}'));
  await open(page);
  await page.keyboard.type('quiet mode');
  await expect(results(page).first()).toContainText('Off');
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toHaveCount(0);
  await expect
    .poll(async () => Object.values(await layers()).every((on) => on === false))
    .toBe(true);
  await open(page);
  await page.keyboard.type('quiet');
  await expect(results(page).first()).toContainText('On');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => Object.values(await layers()).every((on) => on === true))
    .toBe(true);

  // Switch theme flips it, and says which way it will go.
  const theme = () => page.locator('html').getAttribute('data-theme');
  const before = await theme();
  await open(page);
  await page.keyboard.type('switch theme');
  await expect(results(page).first()).toContainText(
    before === 'dark' ? 'light theme' : 'dark theme',
  );
  await page.keyboard.press('Enter');
  await expect.poll(theme).toBe(before === 'dark' ? 'light' : 'dark');
});

test('agents show name, state and project, with those who need you first', async ({ page }) => {
  await loadDemo(page);
  await open(page);
  const agents = dialog(page).getByRole('group', { name: 'Agents' });
  await expect(agents).toBeVisible();
  const names = await agents.getByRole('option').evaluateAll((rows) =>
    rows.map((row) => ({
      name: row.querySelector('.qsname')?.textContent ?? '',
      project: row.querySelector('.qsdet')?.textContent ?? '',
      state: row.querySelector('.chip')?.textContent ?? '',
      red: row.querySelector('.chip.red') !== null,
    })),
  );
  // Atlas waits on an approval and Mori stopped with an error: both are first, in red. The demo's
  // working agents come after.
  const at = (name: string) => names.findIndex((row) => row.name === name);
  expect(at('Atlas')).toBeGreaterThanOrEqual(0);
  expect(at('Mori')).toBeGreaterThanOrEqual(0);
  expect(names[at('Atlas')]).toMatchObject({
    project: 'Checkout revamp',
    state: 'Needs approval',
    red: true,
  });
  expect(names[at('Mori')]).toMatchObject({ project: 'Docs site', state: 'Error', red: true });
  expect(at('Ledger')).toBeGreaterThan(Math.max(at('Atlas'), at('Mori')));
  // Nothing that is not red comes before what is.
  const lastRed = names.map((row) => row.red).lastIndexOf(true);
  expect(names.slice(0, lastRed + 1).every((row) => row.red || row.state === 'Asking you')).toBe(
    true,
  );
  // Name, state and project are all searchable: "approval" finds who waits on one.
  await page.keyboard.type('approval');
  await expect(results(page).first()).toContainText('Atlas');
});

test('the accessibility tree announces the list of results and how many there are', async ({
  page,
}) => {
  await loadDemo(page);
  await open(page);
  await page.keyboard.type('set');
  const list = dialog(page).getByRole('listbox', { name: 'Results' });
  await expect(list).toBeVisible();
  const count = await results(page).count();
  expect(count).toBeGreaterThan(0);
  // The count is in a status region, so a screen reader says it as the list changes.
  const status = dialog(page).getByRole('status');
  await expect(status).toHaveText(`${count} result${count === 1 ? '' : 's'}`);
  await expect(dialog(page)).toMatchAriaSnapshot(`
    - heading "Jump to" [level=2]
    - combobox "Jump to an agent, project, screen or action": set
    - listbox "Results":
      - group "Screens":
        - option /Settings/
    - status: /\\d+ results?/
  `);
  // The box points at the option the arrows are on, which is marked selected.
  await expect(box(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(box(page)).toHaveAttribute('aria-controls', 'qsList');
  await expect(box(page)).toHaveAccessibleDescription(/up and down arrow keys/);
  // With nothing found there is no list, and the status says so.
  await page.keyboard.type('zzzzqx');
  await expect(list).toHaveCount(0);
  await expect(status).toHaveText('No results for "setzzzzqx"');
  await expect(box(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(box(page)).not.toHaveAttribute('aria-activedescendant');
});

test('before the office has any agent it offers the screens and actions only', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Explore a demo office' })).toBeVisible();
  await open(page);
  await expect(dialog(page).getByRole('group')).toHaveCount(2);
  await expect(dialog(page).getByRole('group', { name: 'Screens' })).toBeVisible();
  await expect(dialog(page).getByRole('group', { name: 'Actions' })).toBeVisible();
});

test('it offers nothing risky: no approving, stopping, pausing or wiping', async ({ page }) => {
  await loadDemo(page);
  await open(page);
  // The plain actions are exactly these four.
  const actions = dialog(page).getByRole('group', { name: 'Actions' }).getByRole('option');
  await expect(actions).toHaveCount(4);
  expect((await actions.locator('.qsname').allTextContents()).sort()).toEqual([
    'New agent',
    'New project',
    'Quiet mode',
    'Switch theme',
  ]);
  // Asking for the risky ones finds no action.
  for (const word of [
    'approve',
    'allow',
    'deny',
    'wipe',
    'stop',
    'pause',
    'interrupt',
    'auto approve',
  ]) {
    await box(page).fill(word);
    await expect(dialog(page).getByRole('group', { name: 'Actions' })).toHaveCount(0);
  }
});

/** A box on the page that uses Ctrl K itself, such as an editor. */
async function addEditor(page: Page, kind: 'claimed' | 'rich'): Promise<Locator> {
  await page.evaluate((which) => {
    const element = document.createElement(which === 'claimed' ? 'textarea' : 'div');
    element.id = 'editor';
    element.setAttribute('aria-label', 'Editor');
    if (which === 'claimed') element.setAttribute('data-uses-ctrl-k', '');
    else {
      element.setAttribute('contenteditable', 'true');
      element.setAttribute('role', 'textbox');
    }
    document.getElementById('screen')?.append(element);
  }, kind);
  return page.locator('#editor');
}

test('it stays out of a box that uses the key, but not out of an ordinary text box', async ({
  page,
}) => {
  await loadDemo(page);
  await page.evaluate(() => {
    window.location.hash = '#home';
  });
  for (const kind of ['claimed', 'rich'] as const) {
    const editor = await addEditor(page, kind);
    await editor.focus();
    await page.keyboard.press('Control+K');
    await page.keyboard.press('Meta+K');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await editor.evaluate((element) => element.remove());
  }

  // Home's own box takes Ctrl K only where a text field does not use it. On a Mac it deletes to the
  // end of the line, so there Command K opens the switcher and Ctrl K is left to the field.
  const mac = await page.evaluate(() => /Mac|iPhone|iPad|iPod/i.test(navigator.platform));
  // The Type button shows Home's box and puts focus in it.
  await page.locator('#hcType').click();
  const home = page.locator('#hcText');
  await expect(home).toBeFocused();
  await home.pressSequentially('hello');
  await page.keyboard.press('Control+K');
  if (mac) await expect(page.getByRole('dialog')).toHaveCount(0);
  else {
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
  }
  await page.keyboard.press('Meta+K');
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(home).toBeFocused();
  // What was typed is still there.
  await expect(home).toHaveValue('hello');
});

test('it does not open over another dialog', async ({ page }) => {
  await loadDemo(page);
  await page.getByRole('button', { name: 'New agent' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Create a new agent' })).toBeVisible();
  await page.keyboard.press('Control+K');
  await page.keyboard.press('Meta+K');
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(1);
});

test('Space types a space in its box and does not start push to talk, and still does afterwards', async ({
  page,
}) => {
  await page.addInitScript(() => {
    class FakeSpeech {
      declare processLocally: boolean;
      onresult: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      start() {
        window.fakeSpeech.started += 1;
      }
      stop() {
        this.onend?.();
      }
      abort() {
        this.onend?.();
      }
    }
    FakeSpeech.prototype.processLocally = false;
    window.fakeSpeech = { started: 0, local: null, say: () => undefined };
    Object.assign(window, { SpeechRecognition: FakeSpeech });
  });
  await loadDemo(page);
  await page.goto('/#home');
  await expect(page.locator('#homeSum')).toContainText('working');
  await open(page);
  await box(page).pressSequentially('docs site');
  await expect(box(page)).toHaveValue('docs site');
  await page.keyboard.down('Space');
  await page.keyboard.up('Space');
  await expect(box(page)).toHaveValue('docs site ');
  expect(await page.evaluate(() => window.fakeSpeech.started)).toBe(0);
  await expect(page.locator('#hcMic')).not.toHaveClass(/on/);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  // Closed, Space is push to talk again.
  await page.keyboard.down('Space');
  await expect(page.locator('#hcMic')).toHaveClass(/on/);
  await page.keyboard.up('Space');
  expect(await page.evaluate(() => window.fakeSpeech.started)).toBe(1);
});

test('it does not open while push to talk is listening', async ({ page }) => {
  await page.addInitScript(() => {
    class FakeSpeech {
      declare processLocally: boolean;
      onresult: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      start() {}
      stop() {
        this.onend?.();
      }
      abort() {
        this.onend?.();
      }
    }
    FakeSpeech.prototype.processLocally = false;
    Object.assign(window, { SpeechRecognition: FakeSpeech });
  });
  await loadDemo(page);
  await page.goto('/#home');
  await expect(page.locator('#homeSum')).toContainText('working');
  await page.keyboard.down('Space');
  await expect(page.locator('#hcMic')).toHaveClass(/on/);
  await page.keyboard.press('Control+K');
  await expect(dialog(page)).toHaveCount(0);
  await page.keyboard.up('Space');
});

test('a click on a result opens it, and hovering chooses it', async ({ page }) => {
  await loadDemo(page);
  await open(page);
  await page.keyboard.type('a');
  const second = results(page).nth(1);
  await second.hover();
  await expect(second).toHaveAttribute('aria-selected', 'true');
  await expect(results(page).first()).toHaveAttribute('aria-selected', 'false');
  await page.keyboard.press('Escape');
  await open(page);
  await page.keyboard.type('settings');
  await results(page).first().click();
  await expect(page).toHaveURL(/#preferences$/);
  await expect(dialog(page)).toHaveCount(0);
});
