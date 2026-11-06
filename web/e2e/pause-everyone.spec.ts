// SPDX-License-Identifier: Apache-2.0
// Pause everyone in the Agents header, and Continue everyone after it: a confirmation that names how
// many and which project, only working agents paused, nothing approved, and only the agents that
// pause stopped carried on.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

interface Agent {
  id: string;
  name: string;
  state: string;
  working: boolean;
  projectId: string | null;
  queued: unknown[];
  question: unknown;
  approval: { id: string; decision: string | null } | null;
}

interface Reply {
  results: { id: string; name: string; outcome: string; why: string }[];
  paused: number;
  resumed: number;
  skipped: number;
  summary: string;
}

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
});

async function loadDemo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.locator('.tag .nt').first()).toBeVisible();
}

async function agents(request: APIRequestContext): Promise<Agent[]> {
  const snapshot = (await (await request.get('/api/snapshot')).json()) as { agents: Agent[] };
  return snapshot.agents;
}

const pauseButton = (page: Page) => page.getByRole('button', { name: 'Pause everyone' });
const continueButton = (page: Page) => page.getByRole('button', { name: 'Continue everyone' });

/** Confirms the dialog, and returns what the server answered. */
async function confirm(page: Page): Promise<Reply> {
  const answered = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/agents/interrupt') && response.request().method() === 'POST',
  );
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Pause \d+ agents?$/ })
    .click();
  return (await (await answered).json()) as Reply;
}

test('pausing everyone asks first, names how many, and changes nothing until confirmed', async ({
  page,
  request,
}) => {
  await loadDemo(page);
  await expect(pauseButton(page)).toBeEnabled();
  await pauseButton(page).click();

  const dialog = page.getByRole('dialog', { name: 'Pause everyone in all projects?' });
  await expect(dialog).toBeVisible();
  // It says how many will pause, and that nothing is approved or answered by it.
  await expect(dialog).toContainText(/\d+ working agents? will pause/);
  await expect(dialog).toContainText('Pausing never approves or answers anything.');
  // Atlas waits on an approval: the dialog says it stays waiting.
  await expect(dialog.locator('#pauseWaiting')).toContainText('Atlas');
  await expect(dialog.locator('#pauseWaiting')).toContainText(/stays? waiting/);
  // The number in the question is the number on the button that confirms it.
  const said = (await dialog.locator('.dhd .help').textContent()) ?? '';
  const count = Number(/(\d+) working agent/.exec(said)?.[1]);
  expect(count).toBeGreaterThan(0);
  await expect(
    dialog.getByRole('button', { name: `Pause ${count} agent${count === 1 ? '' : 's'}` }),
  ).toBeVisible();

  // Cancel changes nothing, and focus goes back to the button.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(pauseButton(page)).toBeFocused();
  expect((await agents(request)).filter((agent) => agent.state === 'paused')).toEqual([]);
  // Escape cancels too.
  await pauseButton(page).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await agents(request)).filter((agent) => agent.state === 'paused')).toEqual([]);
});

test('pause everyone pauses who is working, never settles an approval, and continue brings them back', async ({
  page,
  request,
}) => {
  await loadDemo(page);
  const approvalsBefore = (await (
    await request.get('/api/approvals?pending=1')
  ).json()) as unknown[];
  expect(approvalsBefore.length).toBeGreaterThan(0);

  await pauseButton(page).click();
  const reply = await confirm(page);
  expect(reply.paused).toBeGreaterThan(0);
  const stopped = reply.results
    .filter((result) => result.outcome === 'paused')
    .map((result) => result.id);

  // The one button now says Continue everyone, and the toast says what happened.
  await expect(continueButton(page)).toBeVisible();
  await expect(continueButton(page)).toHaveClass(/primary/);
  await expect(pauseButton(page)).toHaveCount(0);
  await expect(page.locator('.toast', { hasText: /^Paused \d+ agents?\./ })).toBeVisible();
  // The page only names agents that are working, so Atlas, waiting on its approval, is not asked.
  await expect(page.locator('.toast', { hasText: 'Atlas' })).toHaveCount(0);

  // Everyone it said it paused is interrupted. Atlas is exactly as it was, and every approval waits.
  const now = await agents(request);
  for (const id of stopped) expect(now.find((agent) => agent.id === id)?.state).toBe('paused');
  const atlas = now.find((agent) => agent.name === 'Atlas')!;
  expect(atlas.state).toBe('approval');
  expect(atlas.approval?.decision ?? null).toBeNull();
  const approvalsAfter = (await (
    await request.get('/api/approvals?pending=1')
  ).json()) as unknown[];
  expect(approvalsAfter).toHaveLength(approvalsBefore.length);
  // The floor list shows them as interrupted.
  await expect(page.getByRole('group', { name: /^Interrupted/ })).toBeVisible();

  // One row in the Activity log for the group, and none for each agent.
  const log = (await (await request.get('/api/activity')).json()) as {
    agent: string;
    message: string;
  }[];
  expect(
    log.filter((row) => row.agent === 'Everyone' && row.message === 'Pause everyone'),
  ).toHaveLength(1);
  expect(log.filter((row) => row.message === 'Interrupt')).toHaveLength(0);

  // Continue everyone carries on exactly those, and the button goes back.
  const resumed = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/agents/continue') && response.request().method() === 'POST',
  );
  await continueButton(page).click();
  const back = (await (await resumed).json()) as Reply;
  expect(back.resumed).toBe(stopped.length);
  await expect(pauseButton(page)).toBeVisible();
  await expect(continueButton(page)).toHaveCount(0);
  await expect(page.locator('.toast', { hasText: /^Resumed \d+ agents?\./ })).toBeVisible();
  const after = await agents(request);
  for (const id of stopped)
    expect(after.find((agent) => agent.id === id)?.state).not.toBe('paused');
  expect(after.find((agent) => agent.name === 'Atlas')?.state).toBe('approval');
});

test('with a project in view it pauses only that project, and says so', async ({
  page,
  request,
}) => {
  await loadDemo(page);
  await page.getByRole('button', { name: /^Project/ }).click();
  await page.getByRole('menuitemradio', { name: /Checkout revamp/ }).click();
  await expect(pauseButton(page)).toBeEnabled();
  const before = await agents(request);

  await pauseButton(page).click();
  const dialog = page.getByRole('dialog', { name: 'Pause everyone in Checkout revamp?' });
  await expect(dialog).toBeVisible();
  const reply = await confirm(page);
  expect(reply.paused).toBeGreaterThan(0);

  // Only Checkout revamp's agents were named, and only theirs are paused. The rest carry on.
  const checkout = new Set(
    before.filter((agent) => agent.projectId === 'checkout').map((agent) => agent.id),
  );
  for (const result of reply.results) expect(checkout.has(result.id), result.name).toBe(true);
  const now = await agents(request);
  expect(
    now.filter((agent) => agent.state === 'paused').every((agent) => checkout.has(agent.id)),
  ).toBe(true);
  expect(now.filter((agent) => agent.projectId !== 'checkout' && agent.state === 'paused')).toEqual(
    [],
  );
  // The Activity log row names the project.
  const log = (await (await request.get('/api/activity')).json()) as {
    agent: string;
    message: string;
  }[];
  expect(
    log.some(
      (row) => row.agent === 'Everyone' && row.message === 'Pause everyone in Checkout revamp',
    ),
  ).toBe(true);

  // Changing the view does not change who Continue everyone carries on: the agents the pause stopped.
  await page.getByRole('button', { name: /^Project/ }).click();
  await page.getByRole('menuitemradio', { name: /All projects/ }).click();
  await expect(continueButton(page)).toBeVisible();
  await continueButton(page).click();
  await expect(pauseButton(page)).toBeVisible();
  expect((await agents(request)).filter((agent) => agent.state === 'paused')).toEqual([]);
});

test('an agent paused by hand stays paused when everyone continues', async ({ page, request }) => {
  await loadDemo(page);
  const working = (await agents(request)).filter((agent) => agent.working && !agent.question);
  expect(working.length).toBeGreaterThan(1);
  const byHand = working[0]!;
  await request.post(`/api/agents/${byHand.id}/interrupt`);
  await expect
    .poll(async () => (await agents(request)).find((a) => a.id === byHand.id)?.state)
    .toBe('paused');
  // Wait for the page to see it, so the button's view of who is working is up to date.
  await expect(
    page.getByRole('button', { name: `${byHand.name} Interrupted`, exact: false }).first(),
  ).toBeVisible();

  await pauseButton(page).click();
  await expect(page.getByRole('dialog').locator('#pauseNames')).not.toContainText(byHand.name);
  const reply = await confirm(page);
  expect(reply.results.map((result) => result.id)).not.toContain(byHand.id);

  await continueButton(page).click();
  await expect(pauseButton(page)).toBeVisible();
  const after = await agents(request);
  expect(after.find((agent) => agent.id === byHand.id)?.state).toBe('paused');
  for (const result of reply.results.filter((item) => item.outcome === 'paused')) {
    expect(after.find((agent) => agent.id === result.id)?.state).not.toBe('paused');
  }
});

test('an agent continued by hand and then paused again by hand is no longer part of the pause', async ({
  page,
  request,
}) => {
  await loadDemo(page);
  await pauseButton(page).click();
  const reply = await confirm(page);
  // An agent with an instruction queued is listed under Queued, not Interrupted, so pick another.
  const queued = new Set(
    (await agents(request)).filter((agent) => agent.queued.length > 0).map((agent) => agent.id),
  );
  const stopped = reply.results.filter(
    (result) => result.outcome === 'paused' && !queued.has(result.id),
  );
  expect(stopped.length).toBeGreaterThan(1);
  const first = stopped[0]!;
  const others = stopped.slice(1);
  const interrupted = page.getByRole('group', { name: /^Interrupted/ });
  await expect(interrupted).toContainText(first.name);

  // Continued by hand: the page sees it leave the interrupted group, and drops it from the pause.
  await request.post(`/api/agents/${first.id}/continue`);
  await expect(interrupted).not.toContainText(first.name);
  // Paused again by hand, which is the person's own pause, not this one.
  await request.post(`/api/agents/${first.id}/interrupt`);
  await expect(interrupted).toContainText(first.name);

  await continueButton(page).click();
  await expect(pauseButton(page)).toBeVisible();
  const after = await agents(request);
  expect(after.find((agent) => agent.id === first.id)?.state).toBe('paused');
  for (const other of others) {
    expect(after.find((agent) => agent.id === other.id)?.state).not.toBe('paused');
  }
});

test('Continue everyone is still there after a reload', async ({ page }) => {
  await loadDemo(page);
  await pauseButton(page).click();
  await confirm(page);
  await expect(continueButton(page)).toBeVisible();
  await page.reload();
  await expect(page.locator('.tag .nt').first()).toBeVisible();
  await expect(continueButton(page)).toBeVisible();
  await continueButton(page).click();
  await expect(pauseButton(page)).toBeVisible();
});

test('with nobody working in view the button is off and says why', async ({ page }) => {
  await loadDemo(page);
  // Needs me shows only who waits on you, and none of them is working.
  await page
    .getByRole('group', { name: 'Agent status' })
    .getByRole('button', { name: /^Needs me/ })
    .click();
  await expect(pauseButton(page)).toBeDisabled();
  await expect(pauseButton(page)).toHaveAttribute('title', 'Nobody in this view is working');
});
