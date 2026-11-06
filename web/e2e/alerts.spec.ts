// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from '@playwright/test';
import {
  buildMabari,
  claudeHook,
  connectClaude,
  disconnectClaude,
  faviconText,
  favicon,
  hubReport,
  hubToken,
  pendingApproval,
  permissionRequest,
  stubNotifications,
} from './outside';

// Alerts outside the page: the tab's title and icon, and desktop notifications. The browser's
// Notification is a stand-in the test controls, since the real one needs a person to click Allow.

const SWITCH = 'Notify me when an approval or error needs me';
let binary = '';

test.beforeAll(() => {
  binary = buildMabari('alerts');
});

test.afterAll(() => disconnectClaude(binary));

test.beforeEach(async ({ request }) => {
  await connectClaude(binary, request);
});

/** Goes to a page without reloading, so the stand-in Notification and its record stay. */
async function go(page: Page, route: string) {
  await page.evaluate((hash) => (window.location.hash = hash), `#${route}`);
}

const waitingApproval = (page: Page) => page.locator('#approvalLive', { hasText: 'Quizshop' });

test('the tab title leads with the count and the icon gets a red dot, on every screen', async ({
  page,
  request,
}) => {
  const token = await hubToken(request);
  await page.goto('/#home');
  await hubReport(request, token, 'mori', { name: 'Mori', state: 'editing', task: 'Index docs' });
  await expect(page).toHaveTitle('Home · Mabari');
  expect(await favicon(page)).toBe('/favicon.svg');

  // An error: one needs you, and the icon has a dot in the badges' red.
  await hubReport(request, token, 'mori', { state: 'error', error: 'Lost the connection' });
  await expect(page).toHaveTitle('(1) Home · Mabari');
  const withDot = faviconText(await favicon(page));
  expect(withDot).toContain('id="alert-dot"');
  expect(withDot).toContain('fill="#C33437"');

  // An approval joins it.
  const approval = await permissionRequest(
    binary,
    waitingApproval(page),
    'alerts-title',
    '/tmp/quizshop',
    'npm run build',
  );
  await expect(page).toHaveTitle('(2) Home · Mabari');

  // The same number leads the title on every screen.
  const pages: [string, string][] = [
    ['office', 'Agents'],
    ['projects', 'Projects'],
    ['activity', 'Activity log'],
    ['preferences', 'Settings'],
    ['conversations', 'Conversations'],
    ['accounts', 'Accounts'],
    ['builder', 'Agent builder'],
    ['home', 'Home'],
  ];
  for (const [route, name] of pages) {
    await go(page, route);
    await expect(page).toHaveTitle(`(2) ${name} · Mabari`);
    expect(faviconText(await favicon(page))).toContain('id="alert-dot"');
  }

  // Deciding the approval takes one off. The error is still red, so the dot stays. (The test
  // allows it: a Claude Code session that was denied stays "waiting" until its next step.)
  const decided = await request.post(`/api/approvals/${await pendingApproval(request)}/decision`, {
    data: { decision: 'allowed' },
  });
  expect(decided.ok()).toBe(true);
  await approval.printed;
  await expect(page).toHaveTitle('(1) Home · Mabari');
  expect(faviconText(await favicon(page))).toContain('id="alert-dot"');

  // Nobody needs you: no count, and the plain icon.
  await hubReport(request, token, 'mori', { state: 'editing', error: '' });
  await expect(page).toHaveTitle('Home · Mabari');
  expect(await favicon(page)).toBe('/favicon.svg');
});

test('a question counts in the title and gets no dot: only approvals and errors are red', async ({
  page,
}) => {
  await page.goto('/#office');
  await expect(page).toHaveTitle('Agents · Mabari');
  const asking = page.locator('.bub.ask', { hasText: 'Asking you a question' });
  let hook: ReturnType<typeof claudeHook> | undefined;
  for (let attempt = 0; attempt < 10 && !hook; attempt++) {
    const tried = claudeHook(binary, 'PreToolUse', 'alerts-question', '/tmp/quizshop', {
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            question: 'Which database should the shop use?',
            header: 'Database',
            multiSelect: false,
            options: [
              { label: 'Postgres', description: 'Runs as its own server' },
              { label: 'SQLite', description: 'One file, no server' },
            ],
          },
        ],
      },
    });
    const outcome = await Promise.race([
      tried.printed.then(() => 'left to Claude Code'),
      asking.waitFor({ timeout: 10_000 }).then(
        () => 'shown',
        () => 'not shown',
      ),
    ]);
    if (outcome === 'shown') hook = tried;
    else tried.process.kill();
    if (!hook) await page.waitForTimeout(300);
  }
  expect(hook, 'the question never showed').toBeDefined();
  await expect(page).toHaveTitle('(1) Agents · Mabari');
  // It needs you, so it is counted, but it is not red.
  expect(await favicon(page)).toBe('/favicon.svg');
  hook!.process.kill();
});

test.describe('the switch for desktop notifications', () => {
  test('asks the browser only when turned on, and then stays on', async ({ page }) => {
    const stub = await stubNotifications(page, { permission: 'default', answer: 'granted' });
    await page.goto('/#preferences');
    const notify = page.getByLabel(SWITCH);
    await expect(notify).not.toBeChecked();
    // Off by default, and the browser hasn't been asked anything.
    expect(await stub.asked()).toBe(0);
    await notify.check();
    await expect(notify).toBeChecked();
    expect(await stub.asked()).toBe(1);
    await expect(page.locator('#notifyHelp')).toContainText('On in this browser');
    await notify.uncheck();
    await expect(notify).not.toBeChecked();
    expect(await stub.asked()).toBe(1);
  });

  test('stays off and says why when the browser refuses', async ({ page }) => {
    const stub = await stubNotifications(page, { permission: 'default', answer: 'denied' });
    await page.goto('/#preferences');
    const notify = page.getByLabel(SWITCH);
    await notify.click();
    await expect(page.locator('#notifyHelp')).toContainText('blocked notifications for Mabari');
    await expect(notify).not.toBeChecked();
    expect(await stub.asked()).toBe(1);
    // It doesn't ask again once the browser has said no.
    await notify.click();
    await expect(notify).not.toBeChecked();
    expect(await stub.asked()).toBe(1);
    await expect(page.locator('#notifyHelp')).toContainText('site settings');
  });

  test("stays off, without asking, on an address that isn't a secure context", async ({ page }) => {
    const stub = await stubNotifications(page, { permission: 'default', secure: false });
    await page.goto('/#preferences');
    const notify = page.getByLabel(SWITCH);
    await notify.click();
    await expect(notify).not.toBeChecked();
    await expect(page.locator('#notifyHelp')).toContainText('secure address');
    expect(await stub.asked()).toBe(0);
  });
});

test('a notification shows only while the page is hidden, once for each, and a click opens the agent', async ({
  page,
  request,
}) => {
  const stub = await stubNotifications(page, { permission: 'default', answer: 'granted' });
  const token = await hubToken(request);
  await page.goto('/#preferences');
  await page.getByLabel(SWITCH).check();
  await go(page, 'office');
  await hubReport(request, token, 'mori', { name: 'Mori', state: 'editing', task: 'Index docs' });
  await hubReport(request, token, 'bolt', { name: 'Bolt', state: 'editing', task: 'Run tests' });
  await expect(page.locator('.tag .nt')).toHaveCount(2);

  // The page is in front, so there is nothing to notify about.
  await hubReport(request, token, 'mori', { state: 'error', error: 'secret=hunter2' });
  await expect(page).toHaveTitle('(1) Agents · Mabari');
  expect(await stub.seen()).toEqual([]);

  // Hidden: a new error notifies, with the name and nothing else.
  await stub.hide(true);
  await hubReport(request, token, 'bolt', { state: 'error', error: 'secret=hunter2' });
  await expect(page).toHaveTitle('(2) Agents · Mabari');
  await expect.poll(async () => (await stub.seen()).length).toBe(1);
  const [error] = await stub.seen();
  expect(error?.title).toBe('Bolt hit an error');
  expect(error?.options).toEqual({ tag: 'mabari-error-hub-bolt' });
  expect(JSON.stringify(error)).not.toContain('hunter2');

  // An approval notifies too, with no command in it and no buttons.
  const approval = await permissionRequest(
    binary,
    waitingApproval(page),
    'alerts-notify',
    '/tmp/quizshop',
    'rm -rf node_modules && npm install',
  );
  await expect.poll(async () => (await stub.seen()).length).toBe(2);
  const approvalId = await pendingApproval(request);
  const asked = (await stub.seen())[1]!;
  expect(asked.title).toBe('Quizshop needs your approval');
  expect(asked.options).toEqual({ tag: `mabari-approval-${approvalId}` });
  expect(JSON.stringify(asked)).not.toContain('rm -rf');

  // Nothing repeats: the same approval and error stay waiting while the office changes around them.
  await hubReport(request, token, 'mori', { task: 'Still stuck' });
  await hubReport(request, token, 'bolt', { error: 'Still stuck' });
  await page.waitForTimeout(1500);
  expect(await stub.seen()).toHaveLength(2);

  // Clicking it brings Mabari forward and opens that agent, in the address too.
  const before = await stub.focused();
  await stub.click(1);
  expect(await stub.focused()).toBe(before + 1);
  await expect(page).toHaveURL(/#office\?agent=cc-alerts-notify$/);
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await expect(panel.getByRole('heading', { name: 'Quizshop', exact: true })).toBeVisible();
  expect((await stub.seen())[1]?.closed).toBe(true);

  // Shown again, nothing more is made for what it already told.
  await stub.hide(false);
  await hubReport(request, token, 'mori', { state: 'editing' });
  await hubReport(request, token, 'mori', { state: 'error', error: 'again' });
  await page.waitForTimeout(500);
  expect(await stub.seen()).toHaveLength(2);

  const decided = await request.post(`/api/approvals/${approvalId}/decision`, {
    data: { decision: 'denied' },
  });
  expect(decided.ok()).toBe(true);
  await approval.printed;
});

test('with the permission refused, nothing is shown, hidden or not', async ({ page, request }) => {
  const stub = await stubNotifications(page, { permission: 'denied', hidden: true });
  const token = await hubToken(request);
  await page.goto('/#office');
  await hubReport(request, token, 'mori', { name: 'Mori', state: 'editing' });
  await expect(page.locator('.tag .nt')).toHaveCount(1);
  await hubReport(request, token, 'mori', { state: 'error', error: 'Lost the connection' });
  await expect(page).toHaveTitle('(1) Agents · Mabari');
  await page.waitForTimeout(500);
  expect(await stub.seen()).toEqual([]);
});
