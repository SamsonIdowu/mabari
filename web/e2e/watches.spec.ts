// SPDX-License-Identifier: Apache-2.0
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { hubInstructions, hubReport, hubToken, stubNotifications, type HubReport } from './outside';
import { wipe } from './support/page.ts';

// "Tell me when it's done" and "then tell the next one". Agents are hub agents, which report any
// state a test likes, so each can be made done, or stopped by an error, on cue.

const WATCH = "Tell me when it's done";

test.beforeEach(async ({ request }) => {
  await wipe(request);
});

/** Seats hub agents. Their ids are "hub-" and the key given. */
async function seat(
  request: APIRequestContext,
  agents: Record<string, HubReport>,
): Promise<string> {
  const token = await hubToken(request);
  for (const [key, report] of Object.entries(agents)) {
    await hubReport(request, token, key, report);
  }
  return token;
}

const working = (name: string, task: string): HubReport => ({ name, state: 'editing', task });

const panelOf = (page: Page) => page.getByRole('complementary', { name: 'Agent details' });

async function openAgent(page: Page, key: string, name: string) {
  await page.goto(`/#office?agent=hub-${key}`);
  const panel = panelOf(page);
  await expect(panel.getByRole('heading', { name, exact: true })).toBeVisible();
  return panel;
}

const toggle = (where: Locator) => where.getByRole('checkbox', { name: WATCH });
const toast = (page: Page, text: string | RegExp) => page.locator('.toast', { hasText: text });

async function watches(request: APIRequestContext) {
  return (await (await request.get('/api/watches')).json()) as {
    id: string;
    kind: string;
    target: string;
    then: { agentId: string; text: string } | null;
  }[];
}

/**
 * Turns the switch on, and waits until the server has the watch. The switch flips at once and the
 * server answers a moment later, so a test that went on to make the agent finish straight away
 * would find the work already done and nothing to wait for.
 */
async function turnOn(request: APIRequestContext, where: Locator) {
  const before = (await watches(request)).length;
  await toggle(where).check();
  await expect.poll(async () => (await watches(request)).length).toBeGreaterThan(before);
}

async function logRows(request: APIRequestContext, text: string) {
  return (await (await request.get(`/api/activity?q=${encodeURIComponent(text)}`)).json()) as {
    message: string;
    outcome: string;
    chip: string;
  }[];
}

/** Asks Mabari on Home, as the box does. */
async function ask(page: Page, text: string) {
  if (!(await page.locator('#hcForm').isVisible())) await page.locator('#hcType').click();
  await page.getByLabel('Message Mabari').fill(text);
  await page.getByLabel('Message Mabari').press('Enter');
  await expect(page.locator('#youSaid')).toHaveText(text);
  await expect(page.locator('#veeSay .typing')).toBeHidden();
}

test('the switch on a panel sets a watch that survives a reload, fires once and clears itself', async ({
  page,
  request,
}) => {
  const token = await seat(request, { ledger: working('Ledger', 'Refactor invoice totals') });
  const panel = await openAgent(page, 'ledger', 'Ledger');
  const watching = toggle(panel);
  await expect(watching).not.toBeChecked();
  await watching.check();
  await expect(panel).toContainText('Watching. You will be told once, when Ledger is done');
  expect(await watches(request)).toHaveLength(1);

  // It lives on the server: a reload shows it as it was.
  await page.reload();
  await expect(toggle(panelOf(page))).toBeChecked();

  // Done: a toast, calm, and the watch is gone.
  await hubReport(request, token, 'ledger', { state: 'done' });
  await expect(toast(page, 'Ledger is done: Refactor invoice totals.')).toBeVisible();
  await expect.poll(async () => (await watches(request)).length).toBe(0);
  // There is nothing left to wait for on finished work, so the switch is gone too.
  await expect(toggle(panelOf(page))).toHaveCount(0);

  // Once: working and finishing again says nothing more.
  await hubReport(request, token, 'ledger', { state: 'editing' });
  await hubReport(request, token, 'ledger', { state: 'done' });
  await page.waitForTimeout(800);
  expect(await logRows(request, 'Watch fired')).toHaveLength(1);
  expect(await toast(page, 'is done').count()).toBeLessThanOrEqual(1);
});

test("the line in Home's chat says it too, and counts as unread when you are elsewhere", async ({
  page,
  request,
}) => {
  const token = await seat(request, { ledger: working('Ledger', 'Refactor invoice totals') });
  await openAgent(page, 'ledger', 'Ledger').then((panel) => turnOn(request, panel));
  await hubReport(request, token, 'ledger', { state: 'done' });
  await expect(toast(page, 'Ledger is done')).toBeVisible();
  // On the Agents page when it fired: Home shows a count of what Mabari said, and says it.
  await expect(page.locator('.rail a.nav[href="#home"] .badge')).toHaveText('1');
  await page.locator('.rail a.nav[href="#home"]').click();
  await expect(page.locator('#veeSay')).toContainText('Ledger is done: Refactor invoice totals.');
});

test('turning the switch off means nothing fires', async ({ page, request }) => {
  const token = await seat(request, { ledger: working('Ledger', 'Refactor invoice totals') });
  const panel = await openAgent(page, 'ledger', 'Ledger');
  await toggle(panel).check();
  await expect.poll(async () => (await watches(request)).length).toBe(1);
  await toggle(panel).uncheck();
  await expect.poll(async () => (await watches(request)).length).toBe(0);
  await hubReport(request, token, 'ledger', { state: 'done' });
  await page.waitForTimeout(800);
  await expect(toast(page, 'is done')).toHaveCount(0);
  expect(await logRows(request, 'Watch fired')).toHaveLength(0);
});

test('an agent that stops with an error ends the watch, and says so, calmly', async ({
  page,
  request,
}) => {
  const token = await seat(request, { mori: working('Mori', 'Index the docs folder') });
  await openAgent(page, 'mori', 'Mori').then((panel) => turnOn(request, panel));
  await hubReport(request, token, 'mori', {
    state: 'error',
    error: 'Lost connection to the embedding service',
  });
  const told = toast(page, 'Mori stopped with an error: Lost connection to the embedding service.');
  await expect(told).toBeVisible();
  // No red: a toast is neutral, and so is the log's row.
  expect(await told.evaluate((node) => getComputedStyle(node).color)).not.toBe('rgb(195, 52, 55)');
  const [row] = await logRows(request, 'Watch fired');
  expect(row?.chip).not.toBe('red');
  expect(await watches(request)).toHaveLength(0);
});

test('a watch clears when its agent leaves, without a word', async ({ page, request }) => {
  const token = await seat(request, { ledger: working('Ledger', 'Refactor invoice totals') });
  await openAgent(page, 'ledger', 'Ledger').then((panel) => turnOn(request, panel));
  await expect.poll(async () => (await watches(request)).length).toBe(1);
  await hubReport(request, token, 'ledger', { state: 'end' });
  await expect.poll(async () => (await watches(request)).length).toBe(0);
  await page.waitForTimeout(500);
  await expect(toast(page, 'Ledger')).toHaveCount(0);
});

test.describe('in Mabari chat', () => {
  test('"tell me when Ledger is done" sets a watch, and is never sent to the agent', async ({
    page,
    request,
  }) => {
    const token = await seat(request, {
      ledger: working('Ledger', 'Refactor invoice totals'),
      rune: { name: 'Rune', state: 'done', task: 'Update the README' },
    });
    await page.goto('/#home');
    await expect(page.locator('#homeSum')).toContainText('working');

    await ask(page, 'tell me when Ledger is done');
    await expect(page.locator('#veeSay')).toContainText("Okay. I'll tell you when Ledger is done.");
    const [set] = await watches(request);
    expect(set).toMatchObject({ kind: 'agent', target: 'hub-ledger', then: null });
    // It was a request to Mabari, not an instruction: Ledger was told nothing.
    expect(await hubInstructions(request, token, 'ledger')).toEqual([]);

    // Other ways of saying it.
    await ask(page, 'let me know when Ledger finishes');
    await expect(page.locator('#veeSay')).toContainText("I'm already watching Ledger");
    expect(await watches(request)).toHaveLength(1);

    // Already finished: Mabari says so, and sets nothing.
    await ask(page, 'tell me when Rune is done');
    await expect(page.locator('#veeSay')).toContainText(
      "Rune already finished: Update the README. There's nothing to wait for.",
    );
    expect(await watches(request)).toHaveLength(1);

    // "tell Ledger to …" is still an instruction.
    await ask(page, 'tell Ledger to let me know when you are done');
    await expect
      .poll(() => hubInstructions(request, token, 'ledger'))
      .toEqual(['let me know when you are done']);
    expect(await watches(request)).toHaveLength(1);

    // And it fires.
    await hubReport(request, token, 'ledger', { state: 'done' });
    await expect(page.locator('#veeSay')).toContainText('Ledger is done: Refactor invoice totals.');
  });

  test('"let me know when Checkout revamp finishes" watches the project', async ({
    page,
    request,
  }) => {
    const token = await seat(request, {
      ledger: working('Ledger', 'Refactor invoice totals'),
      mori: working('Mori', 'Index the docs folder'),
    });
    const project = (await (
      await request.post('/api/projects', { data: { name: 'Checkout revamp', color: '#FF6B9A' } })
    ).json()) as { id: string };
    for (const key of ['ledger', 'mori']) {
      await request.patch(`/api/agents/hub-${key}`, { data: { projectId: project.id } });
    }
    await page.goto('/#home');
    await expect(page.locator('#homeSum')).toContainText('working');
    await ask(page, 'let me know when Checkout revamp finishes');
    await expect(page.locator('#veeSay')).toContainText(
      "Okay. I'll tell you when Checkout revamp is done, which is when every agent on it has finished.",
    );
    expect(await watches(request)).toMatchObject([{ kind: 'project', target: project.id }]);

    // One agent finishing isn't the project finishing.
    await hubReport(request, token, 'ledger', { state: 'done' });
    await page.waitForTimeout(800);
    expect(await watches(request)).toHaveLength(1);
    await hubReport(request, token, 'mori', { state: 'done' });
    await expect(page.locator('#veeSay')).toContainText(
      'Checkout revamp is done. Every agent on it has finished.',
    );
    expect(await watches(request)).toHaveLength(0);
  });
});

test('a project card has the switch too, and tells you once every agent on it is done', async ({
  page,
  request,
}) => {
  const token = await seat(request, {
    ledger: working('Ledger', 'Refactor invoice totals'),
    mori: working('Mori', 'Index the docs folder'),
  });
  const project = (await (
    await request.post('/api/projects', { data: { name: 'Checkout revamp', color: '#FF6B9A' } })
  ).json()) as { id: string };
  for (const key of ['ledger', 'mori']) {
    await request.patch(`/api/agents/hub-${key}`, { data: { projectId: project.id } });
  }
  await page.goto('/#projects');
  const card = page.locator('article.card', {
    has: page.getByRole('heading', { name: 'Checkout revamp' }),
  });
  await expect(toggle(card)).not.toBeChecked();
  await turnOn(request, card);
  await expect(card).toContainText(
    'Watching. You will be told once, when every agent on Checkout revamp has finished.',
  );
  await page.reload();
  await expect(toggle(card)).toBeChecked();

  await hubReport(request, token, 'ledger', { state: 'done' });
  await hubReport(request, token, 'mori', { state: 'done' });
  await expect(toast(page, 'Checkout revamp is done')).toBeVisible();
  expect(await watches(request)).toHaveLength(0);
});

test.describe('then tell the next one', () => {
  async function chain(page: Page, request: APIRequestContext) {
    const token = await seat(request, {
      ledger: working('Ledger', 'Refactor invoice totals'),
      quill: { name: 'Quill', state: 'idle', task: 'Waiting for work' },
    });
    const panel = await openAgent(page, 'ledger', 'Ledger');
    await panel.getByLabel('Then tell', { exact: true }).selectOption({ label: 'Quill' });
    await panel.getByLabel('What to tell it').fill('review it');
    await panel.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(panel.getByTestId('watchThen')).toContainText('Then tell Quill “review it”');
    return { token, panel };
  }

  test('a watch passes its instruction on when the work is done, and logs it', async ({
    page,
    request,
  }) => {
    const { token, panel } = await chain(page, request);
    // The watch is on, because setting the Then set it.
    await expect(toggle(panel)).toBeChecked();
    expect((await watches(request))[0]?.then).toMatchObject({
      agentId: 'hub-quill',
      text: 'review it',
    });

    // Quill's panel shows the pending chain, from the other side.
    await openAgent(page, 'quill', 'Quill');
    await expect(page.getByTestId('watchesWaiting')).toContainText(
      '“review it” once Ledger is done',
    );
    // Nothing is sent before Ledger is done.
    expect(await hubInstructions(request, token, 'quill')).toEqual([]);

    // A reload keeps the chain.
    await page.reload();
    await expect(page.getByTestId('watchesWaiting')).toContainText('once Ledger is done');

    await hubReport(request, token, 'ledger', { state: 'done' });
    await expect(
      toast(page, 'Ledger is done: Refactor invoice totals. I told Quill “review it”.'),
    ).toBeVisible();
    // It went the way any instruction goes: to Quill's own connector, once.
    expect(await hubInstructions(request, token, 'quill')).toEqual(['review it']);
    await expect(page.getByTestId('watchesWaiting')).toHaveCount(0);
    const [row] = await logRows(request, 'Watch fired');
    expect(row?.outcome).toBe('Told you. Sent to Quill.');
    expect(await watches(request)).toHaveLength(0);
  });

  test('an error stops the chain, and you are told', async ({ page, request }) => {
    const { token } = await chain(page, request);
    await hubReport(request, token, 'ledger', { state: 'error', error: 'Tests crashed' });
    await expect(
      toast(page, "Ledger stopped with an error: Tests crashed. I didn't tell Quill “review it”."),
    ).toBeVisible();
    expect(await hubInstructions(request, token, 'quill')).toEqual([]);
    const [row] = await logRows(request, 'Watch fired');
    expect(row?.outcome).toBe('Told you. Not sent to Quill: Ledger hit an error.');
  });

  test('a target that has gone is said, and it is never sent to anyone else', async ({
    page,
    request,
  }) => {
    const { token } = await chain(page, request);
    await hubReport(request, token, 'other', { name: 'Other', state: 'idle' });
    await hubReport(request, token, 'quill', { state: 'end' });
    await hubReport(request, token, 'ledger', { state: 'done' });
    await expect(toast(page, "Quill has left, so I didn't pass on “review it”.")).toBeVisible();
    for (const key of ['other', 'ledger']) {
      expect(await hubInstructions(request, token, key)).toEqual([]);
    }
  });

  test('cancelling the chain keeps the watch, from either agent, and nothing is sent', async ({
    page,
    request,
  }) => {
    const { token, panel } = await chain(page, request);
    await panel.getByRole('button', { name: /^Cancel telling Quill/ }).click();
    await expect(panel.getByTestId('watchThen')).toHaveCount(0);
    // The watch stays: you are still told.
    await expect(toggle(panel)).toBeChecked();
    expect(await watches(request)).toMatchObject([{ then: null }]);

    // Set it again, and cancel from Quill's side this time.
    await panel.getByLabel('Then tell', { exact: true }).selectOption({ label: 'Quill' });
    await panel.getByLabel('What to tell it').fill('review it again');
    await panel.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(panel.getByTestId('watchThen')).toBeVisible();
    await openAgent(page, 'quill', 'Quill');
    await page.getByRole('button', { name: /^Cancel being told/ }).click();
    await expect(page.getByTestId('watchesWaiting')).toHaveCount(0);

    await hubReport(request, token, 'ledger', { state: 'done' });
    await expect(toast(page, 'Ledger is done: Refactor invoice totals.')).toBeVisible();
    await expect(toast(page, 'Quill')).toHaveCount(0);
    expect(await hubInstructions(request, token, 'quill')).toEqual([]);
  });

  test('turning the switch off cancels the chain with it', async ({ page, request }) => {
    const { token, panel } = await chain(page, request);
    await toggle(panel).uncheck();
    await expect.poll(async () => (await watches(request)).length).toBe(0);
    await hubReport(request, token, 'ledger', { state: 'done' });
    await page.waitForTimeout(800);
    expect(await hubInstructions(request, token, 'quill')).toEqual([]);
  });

  test('"when Ledger is done, tell Quill to review it" sets the same chain from chat', async ({
    page,
    request,
  }) => {
    const token = await seat(request, {
      ledger: working('Ledger', 'Refactor invoice totals'),
      quill: { name: 'Quill', state: 'idle', task: 'Waiting for work' },
    });
    await page.goto('/#home');
    await expect(page.locator('#homeSum')).toContainText('working');
    await ask(page, 'when Ledger is done, tell Quill to review it');
    await expect(page.locator('#veeSay')).toContainText(
      "Okay. I'll tell you when Ledger is done, then tell Quill “review it”.",
    );
    expect(await watches(request)).toMatchObject([
      { target: 'hub-ledger', then: { agentId: 'hub-quill', text: 'review it' } },
    ]);
    // Nothing went to Quill yet, and the phrase itself was no instruction for Ledger.
    expect(await hubInstructions(request, token, 'quill')).toEqual([]);
    expect(await hubInstructions(request, token, 'ledger')).toEqual([]);
    await hubReport(request, token, 'ledger', { state: 'done' });
    await expect.poll(() => hubInstructions(request, token, 'quill')).toEqual(['review it']);
  });
});

test('a watch that fires while the page is hidden shows one desktop notification, with only a name', async ({
  page,
  request,
}) => {
  const stub = await stubNotifications(page, { permission: 'default', answer: 'granted' });
  const token = await seat(request, { ledger: working('Ledger', 'Refactor invoice totals') });
  await page.goto('/#preferences');
  await page.getByLabel('Notify me when an approval or error needs me').check();
  const panel = await openAgentHere(page, 'ledger', 'Ledger');
  await turnOn(request, panel);
  await expect.poll(async () => (await watches(request)).length).toBe(1);
  const [watch] = await watches(request);

  await stub.hide(true);
  await hubReport(request, token, 'ledger', { state: 'done' });
  await expect(toast(page, 'Ledger is done')).toBeVisible();
  await expect.poll(async () => (await stub.seen()).length).toBe(1);
  const [note] = await stub.seen();
  expect(note?.title).toBe('Ledger is done');
  expect(note?.options).toEqual({ tag: `mabari-watch-${watch!.id}` });
  expect(JSON.stringify(note)).not.toContain('Refactor');

  // Clicking it opens the agent, from wherever the page was.
  await page.evaluate(() => (window.location.hash = '#home'));
  await stub.click(0);
  await expect(page).toHaveURL(/#office\?agent=hub-ledger$/);
});

/** Opens an agent without a reload, so the stand-in Notification stays. */
async function openAgentHere(page: Page, key: string, name: string) {
  await page.evaluate((hash) => (window.location.hash = hash), `#office?agent=hub-${key}`);
  const panel = panelOf(page);
  await expect(panel.getByRole('heading', { name, exact: true })).toBeVisible();
  return panel;
}

test('a watch that fires while the page is in front shows no desktop notification', async ({
  page,
  request,
}) => {
  const stub = await stubNotifications(page, { permission: 'default', answer: 'granted' });
  const token = await seat(request, { ledger: working('Ledger', 'Refactor invoice totals') });
  await page.goto('/#preferences');
  await page.getByLabel('Notify me when an approval or error needs me').check();
  const panel = await openAgentHere(page, 'ledger', 'Ledger');
  await turnOn(request, panel);
  await hubReport(request, token, 'ledger', { state: 'done' });
  await expect(toast(page, 'Ledger is done')).toBeVisible();
  await page.waitForTimeout(500);
  expect(await stub.seen()).toEqual([]);
});

/** Opens an agent in the demo office from its row in the list beside the floor. */
async function openFromList(page: Page, name: string) {
  const row = page.locator('.flrow', {
    has: page.locator('.flname', { hasText: new RegExp(`^${name}$`) }),
  });
  await expect(row).toBeVisible();
  await row.click();
  const panel = panelOf(page);
  await expect(panel.getByRole('heading', { name, exact: true })).toBeVisible();
  return panel;
}

test('in the demo office a watch is set from the panel and from chat, and shows on both agents', async ({
  page,
  request,
}) => {
  await request.post('/api/demo/load');
  await page.goto('/#home');
  await expect(page.locator('#homeSum')).toContainText('working');

  // Rune has just finished in the demo, so there is nothing to wait for.
  await ask(page, 'tell me when Rune is done');
  await expect(page.locator('#veeSay')).toContainText('Rune already finished');
  expect(await watches(request)).toHaveLength(0);

  // Bolt is still working: Mabari watches it.
  await ask(page, 'tell me when Bolt is done');
  await expect(page.locator('#veeSay')).toContainText("Okay. I'll tell you when Bolt is done.");
  await page.goto('/#office');
  const bolt = await openFromList(page, 'Bolt');
  await expect(toggle(bolt)).toBeChecked();
  await toggle(bolt).uncheck();
  await expect.poll(async () => (await watches(request)).length).toBe(0);

  // And a chain, which shows on Bolt's panel and on Pixel's.
  await page.locator('.rail a.nav[href="#home"]').click();
  await ask(page, 'when Bolt is done, tell Pixel to write up the failures');
  await expect(page.locator('#veeSay')).toContainText('then tell Pixel “write up the failures”');
  await page.locator('.rail a.nav[href="#office"]').click();
  const boltAgain = await openFromList(page, 'Bolt');
  await expect(boltAgain.getByTestId('watchThen')).toContainText(
    'Then tell Pixel “write up the failures”',
  );
  const pixel = await openFromList(page, 'Pixel');
  await expect(pixel.getByTestId('watchesWaiting')).toContainText(
    '“write up the failures” once Bolt is done',
  );
});
