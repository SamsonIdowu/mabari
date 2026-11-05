// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Connecting accounts, and the Settings page. Everything here runs against the test server's own
// scratch folders: never the real ~/.claude, ~/.codex or keychain.

const apiPort = process.env.MABARI_API_PORT ?? '4327';
const claudeDir = process.env.MABARI_E2E_CLAUDE_DIR!;
const env = {
  ...process.env,
  MABARI_DATA_DIR: process.env.MABARI_E2E_DATA_DIR!,
  CLAUDE_CONFIG_DIR: claudeDir,
  MABARI_SECRETS: 'encrypted-file',
  MABARI_MASTER_KEY: process.env.MABARI_E2E_MASTER_KEY!,
  // The hooks name the test server's port, as they name the real one's.
  MABARI_PORT: apiPort,
};
// The user's own login service runs bin/mabari-run, so the hooks it writes name that binary.
const binary = join(mkdtempSync(join(tmpdir(), 'mabari-e2e-run-')), 'mabari-run');
const settingsFile = join(claudeDir, 'settings.json');
const original = '{\n  "model": "claude-sonnet-4-5"\n}\n';
const aKey = 'sk-ant-api03-' + 'a'.repeat(40);

test.beforeAll(() => {
  execFileSync('go', ['build', '-o', binary, './cmd/mabari'], { cwd: resolve('..'), env });
});

const STANDARD = {
  queryModel: 'gpt-5-mini',
  defaults: {
    claude: 'claude-sonnet-4-5',
    codex: 'gpt-5-codex',
    anthropic: 'claude-sonnet-5-5',
    openai: 'gpt-5',
  },
  retentionDays: 30,
};

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
  // A wipe keeps settings, so each test starts from the standard ones.
  await request.patch('/api/settings', { data: STANDARD });
  rmSync(settingsFile + '.mabari-backup', { force: true });
  writeFileSync(settingsFile, original);
});

test.afterEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
  await request.patch('/api/settings', { data: STANDARD });
  writeFileSync(settingsFile, original);
});

async function loadDemo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.locator('.tag .nt').first()).toBeVisible();
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Create a new agent' });

async function openNewAgent(page: Page) {
  await page.goto('/#accounts');
  await page.getByRole('button', { name: 'New agent' }).click();
  await expect(dialog(page)).toBeVisible();
}

/** Attaches Claude Code the way the login service would, and has a session report in. */
function attachClaudeFrom(binaryPath: string) {
  execFileSync(binaryPath, ['connect', 'claude', '--yes'], { env });
}

function aSessionStarts(binaryPath: string) {
  execFileSync(binaryPath, ['hook', '--port', apiPort, 'SessionStart'], {
    env,
    input: JSON.stringify({
      session_id: 'e2e-setup-1',
      cwd: '/tmp/setupshop',
      hook_event_name: 'SessionStart',
    }),
  });
}

const hooksIn = () => (readFileSync(settingsFile, 'utf8').match(/mabari-run/g) ?? []).length;

async function claudeStatus(request: APIRequestContext) {
  return (await (await request.get('/api/accounts/claude')).json()) as { attached: boolean };
}

/** The Claude Code card. The key cards mention Claude Code too, so it is found by its heading. */
const claudeCard = (page: Page) =>
  page.locator('article.card', { has: page.getByRole('heading', { name: 'Attach Claude Code' }) });

// SETUP-6
test('Claude Code attached from a binary named mabari-run reads as attached, and a wipe takes every hook out', async ({
  page,
  request,
}) => {
  attachClaudeFrom(binary);
  expect(hooksIn()).toBe(11);
  expect((await claudeStatus(request)).attached).toBe(true);

  await page.goto('/#accounts');
  const card = claudeCard(page);
  // The change is made, so it is said in the past tense, and the lines to add are not shown.
  await expect(card.getByTestId('hooksAdded')).toContainText('were added to');
  await expect(card.getByTestId('hooksAdded')).toContainText('.mabari-backup');
  await expect(card.getByTestId('claudeDiff')).toHaveCount(0);
  await expect(card).not.toContainText('These lines will be added');

  // The command shows at the top of the card, in view, not 5000 px down inside the diff.
  await card.getByRole('button', { name: 'Start a Claude Code session' }).click();
  await expect(card.getByTestId('claudeCommand')).toContainText('claude');
  await expect(card.getByTestId('claudeCommand')).toBeInViewport();

  // Attaching again never stacks a second set.
  attachClaudeFrom(binary);
  expect(hooksIn()).toBe(11);

  const wiped = await request.post('/api/wipe', { data: { confirm: true } });
  expect(wiped.ok()).toBe(true);
  expect(readFileSync(settingsFile, 'utf8')).toBe(original);
  expect((await claudeStatus(request)).attached).toBe(false);
  expect(existsSync(settingsFile + '.mabari-backup')).toBe(true);
});

// SETUP-3
test('with only Claude Code attached, New agent shows the terminal command and no form', async ({
  page,
}) => {
  attachClaudeFrom(binary);
  aSessionStarts(binary);
  await openNewAgent(page);
  const form = dialog(page);
  await expect(form.getByTestId('cantStart')).toContainText(
    'Claude Code agents start in your terminal',
  );
  await expect(form.getByTestId('startCommand')).toHaveText('claude');
  await expect(form.getByRole('button', { name: 'Create agent' })).toHaveCount(0);
  await expect(form.getByLabel('Name')).toHaveCount(0);
});

// SETUP-2
test('with only an API key saved, every message says agents cannot run on it, and what to do', async ({
  page,
  request,
}) => {
  const saved = await request.put('/api/accounts/anthropic_key/key', { data: { key: aKey } });
  expect(saved.ok()).toBe(true);

  await page.goto('/#office');
  const floor = page.locator('.floormsg');
  await expect(floor).toContainText('Only an API key is saved');
  await expect(floor).toContainText("Agents can't run on an API key yet");
  await expect(floor).not.toContainText('Connected. No agents running yet');

  await openNewAgent(page);
  const form = dialog(page);
  await expect(form.getByTestId('cantStart')).toContainText("aren't ready yet");
  await expect(form.getByTestId('cantStart')).toContainText('Attach Claude Code or sign in');
  await expect(form.getByRole('button', { name: 'Create agent' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(form).toBeHidden();

  await page.getByText('API keys (optional)').click();
  const card = page.locator('.card', { hasText: 'Anthropic API key' });
  await expect(card.getByTestId('keyNote')).toContainText("Agents can't run on an API key yet");
  await expect(card.getByTestId('keyNote')).toContainText('Attach Claude Code or sign in');
  const openai = page.locator('.card', { hasText: 'OpenAI API key' });
  await expect(openai.getByTestId('keyNote')).toContainText("Agents can't run on an API key yet");

  // Welcome never promises it.
  await page.goto('/#welcome');
  await expect(page.locator('.steps')).not.toContainText('API key');
});

// SETUP-1
test('the New agent dialog shows and sends the model chosen in Settings', async ({ page }) => {
  await loadDemo(page);
  await page.goto('/#preferences');
  await page.getByLabel('Claude Code', { exact: true }).selectOption('claude-haiku-4-5');
  await expect(page.locator('#savedCue')).toHaveText('Saved');

  await openNewAgent(page);
  const form = dialog(page);
  await form.getByLabel('Account').selectOption({ label: 'Claude Code on this computer' });
  await expect(form.getByLabel('Model').locator('option').first()).toHaveText(
    'From agent settings (claude-haiku-4-5)',
  );
  await form.getByLabel('Name').fill('Cheapo');
  const sent = page.waitForRequest(
    (request) => request.url().endsWith('/api/agents') && request.method() === 'POST',
  );
  await form.getByRole('button', { name: 'Create agent' }).click();
  expect((await sent).postDataJSON().model).toBe('claude-haiku-4-5');
  await expect(page.locator('.tag .nt', { hasText: 'Cheapo' })).toBeVisible();
});

// SETUP-4
test('a Settings select always shows the stored value, and the hub placeholder is never a model', async ({
  page,
  request,
}) => {
  // The standard query model belongs to Codex and OpenAI. With only an Anthropic key connected it
  // used to show claude-opus-5-5 while gpt-5-mini was in use.
  await request.put('/api/accounts/anthropic_key/key', { data: { key: aKey } });
  await page.goto('/#preferences');
  const query = page.getByLabel('Model that answers queries');
  await expect(query).toHaveValue('gpt-5-mini');
  await expect(query.locator('option:checked')).toHaveText(
    "gpt-5-mini (its account isn't connected)",
  );
  await expect(page.getByLabel('Anthropic API key', { exact: true })).toHaveValue(
    'claude-sonnet-5-5',
  );
  await query.selectOption('claude-haiku-5-5');
  await expect(page.locator('#savedCue')).toHaveText('Saved');
  await expect(query).toHaveValue('claude-haiku-5-5');

  // Only the hub connected: its placeholder is not offered.
  await request.delete('/api/accounts/anthropic_key/key');
  await request.post('/api/accounts/hub/token');
  await page.reload();
  const options = await page
    .getByLabel('Model that answers queries')
    .locator('option')
    .allTextContents();
  expect(options.join('|')).not.toContain('any model your app reports');
});

test('a default no account offers is corrected on the server, and the page shows the correction', async ({
  page,
  request,
}) => {
  const answer = await request.patch('/api/settings', {
    data: { defaults: { ...STANDARD.defaults, anthropic: 'claude-sonnet-4-5' } },
  });
  expect((await answer.json()).defaults.anthropic).toBe('claude-sonnet-5-5');
  const stored = await (await request.get('/api/settings')).json();
  expect(stored.defaults.anthropic).toBe('claude-sonnet-5-5');
  await page.goto('/#preferences');
  await expect(page.getByLabel('Anthropic API key', { exact: true })).toHaveValue(
    'claude-sonnet-5-5',
  );
  await page.goto('/#activity');
  await expect(page.locator('main')).toContainText(
    'Anthropic API key default was claude-sonnet-4-5',
  );
});

// SETUP-5
test('the Codex card keeps saying the CLI is missing, with the step to take', async ({ page }) => {
  await page.goto('/#accounts');
  const missing = page.getByTestId('codexMissing');
  await expect(missing).toContainText('Needs the Codex CLI');
  await expect(missing).toContainText('npm install -g @openai/codex');
  await expect(missing).toContainText('restart Mabari');
  // The old message was a toast that went in four seconds. This one is still here after that.
  await page.waitForTimeout(4500);
  await expect(missing).toBeVisible();
  await expect(page.getByRole('button', { name: 'Install the Codex CLI first' })).toBeDisabled();
});

// SETUP-8, FIRST-10
test('accounts in the demo say Demo, not Connected, and nothing claims a sign in', async ({
  page,
}) => {
  await loadDemo(page);
  await page.goto('/#accounts');
  await expect(page.locator('#demoNote')).toContainText('Nobody is signed in');
  await expect(page.getByTestId('demoChip')).toHaveCount(2);
  await expect(page.locator('main')).not.toContainText('you@example.com');
  await expect(page.locator('main')).not.toContainText('Signed in as');
  const claude = claudeCard(page);
  await expect(claude).toContainText('Demo account: Claude Code is not attached');
  await expect(claude).not.toContainText('Hook reporting');
  await page.goto('/#preferences');
  await expect(page.locator('#demoNote')).toContainText('pretend');

  // Out of the demo the marker goes, and the cards are as they really are.
  await page.locator('#demoNote').getByRole('button', { name: 'Turn off the demo' }).click();
  await expect(page.locator('#demoNote')).toHaveCount(0);
  await page.goto('/#accounts');
  await expect(page.getByTestId('demoChip')).toHaveCount(0);
  await expect(page.locator('.chip', { hasText: 'Not connected' })).toHaveCount(3);
});

// SETUP-9 (UI)
test('Home on a fresh install offers to connect an account', async ({ page }) => {
  await page.goto('/#home');
  await expect(page.locator('#homeSum')).toHaveText('No agents yet');
  await page.locator('#homeConnect').getByRole('link', { name: 'Connect an account' }).click();
  await expect(page.locator('main h1')).toHaveText('Accounts');
});

// SETUP-10
test('a key that does not fit is told off beside the field, with the shape it should have', async ({
  page,
}) => {
  await page.goto('/#accounts');
  await page.getByText('API keys (optional)').click();
  const card = page.locator('.card', { hasText: 'Anthropic API key' });
  await expect(card).toContainText('Starts with sk-ant-');
  await card.getByLabel('Key').fill('hello');
  await card.getByRole('button', { name: 'Save' }).click();
  const error = card.getByTestId('keyError');
  await expect(error).toContainText("that doesn't look like an Anthropic API key");
  await expect(card.getByLabel('Key')).toHaveAttribute('aria-invalid', 'true');
  // Still there after the time a toast would have gone.
  await page.waitForTimeout(4500);
  await expect(error).toBeVisible();
  // Typing again clears it, and a good key says it was saved but not checked.
  await card.getByLabel('Key').fill(aKey);
  await expect(error).toHaveCount(0);
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByTestId('keyUnchecked')).toContainText('not checked with Anthropic');
});

// SETUP-12
test('a changed setting shows a quiet Saved', async ({ page }) => {
  await page.goto('/#preferences');
  await expect(page.locator('#savedCue')).toHaveText('');
  await page.getByLabel('Keep events for').selectOption('90');
  await expect(page.locator('#savedCue')).toHaveText('Saved');
  await expect(page.locator('#savedCue')).toHaveText('', { timeout: 6000 });
});

test('the hub token can be copied, and replacing or revoking it warns first', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/#accounts');
  await page.getByRole('button', { name: 'Generate a token' }).click();
  const shown = page.getByTestId('hubToken');
  const first = (await shown.textContent())!;
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByText('Hub token copied')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first);

  // Replacing says the old one stops working, and Cancel changes nothing.
  await page.getByRole('button', { name: 'Make a new token' }).click();
  await expect(page.getByTestId('hubConfirm')).toContainText('stops working the moment');
  await page.getByTestId('hubConfirm').getByRole('button', { name: 'Cancel' }).click();
  await expect(shown).toHaveText(first);
  await page.getByRole('button', { name: 'Make a new token' }).click();
  await page.getByRole('button', { name: 'Yes, replace it' }).click();
  await expect(shown).not.toHaveText(first);

  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByTestId('hubConfirm')).toContainText('stop reporting right away');
  await page.getByTestId('hubConfirm').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Revoke', exact: true })).toBeVisible();
});

test('the wipe says what goes and what stays, and does exactly that', async ({ page, request }) => {
  await request.patch('/api/settings', { data: { retentionDays: 90 } });
  await request.put('/api/accounts/anthropic_key/key', { data: { key: aKey } });
  await page.goto('/#preferences');
  const lists = page.getByTestId('wipeLists');
  await expect(lists).toContainText('Goes:');
  await expect(lists).toContainText('API keys');
  await expect(lists).toContainText('Stays:');
  await expect(lists).toContainText('your settings');
  await page.getByRole('button', { name: 'Wipe all data…' }).click();
  const confirm = page.getByRole('alert').filter({ hasText: 'cannot be undone' });
  await expect(confirm).toContainText('accounts, keys and tokens');
  await expect(confirm).toContainText('Your settings stay');
  await page.getByRole('button', { name: 'Yes, wipe all data' }).click();
  await expect(page.getByText('All data wiped')).toBeVisible();
  // What the page said stays, stays; what it said goes, is gone.
  const settings = await (await request.get('/api/settings')).json();
  expect(settings.retentionDays).toBe(90);
  const accounts = (await (await request.get('/api/accounts')).json()) as { status: string }[];
  expect(accounts.every((account) => account.status === 'off')).toBe(true);
});

// DAILY-7
test('New agent files under the office filter, or under no project, never the first project', async ({
  page,
}) => {
  await loadDemo(page);
  await openNewAgent(page);
  // The office shows every project, and the dialog does not pick one of them.
  await expect(dialog(page).getByLabel('Project')).toHaveValue('');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await page
    .locator('article', { hasText: 'Test coverage' })
    .getByRole('link', { name: 'Open in office' })
    .click();
  await openNewAgent(page);
  await expect(dialog(page).getByLabel('Project').locator('option:checked')).toHaveText(
    'Test coverage',
  );
});

test('a missing name is shown on the Name field, which takes focus', async ({ page }) => {
  await loadDemo(page);
  await openNewAgent(page);
  const form = dialog(page);
  // Scroll the dialog to the bottom first, as someone filling in the rest of the form would.
  await form.getByLabel('Working folder').focus();
  await form.getByRole('button', { name: 'Create agent' }).click();
  const name = form.getByLabel('Name');
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  const error = form.locator('#naNameError');
  await expect(error).toHaveText('Give the agent a name.');
  await expect(error).toBeInViewport();
  // It sits under the Name field, not at the bottom of the form.
  const nameBox = (await name.boundingBox())!;
  const errorBox = (await error.boundingBox())!;
  expect(errorBox.y).toBeGreaterThan(nameBox.y);
  expect(errorBox.y - nameBox.y).toBeLessThan(80);
  // Typing clears it.
  await name.fill('Juniper');
  await expect(error).toHaveCount(0);
});
