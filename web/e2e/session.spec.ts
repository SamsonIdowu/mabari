// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Mabari runs a Claude Code session itself, with no terminal. This spec has its own server, because
// it restarts it, and the only one that can start a session: the shared one has MABARI_NO_SESSIONS.
// Its `claude` is the fake, first on PATH, and that is checked before the server starts, because
// the real program would spend the person's account.

const root = mkdtempSync(join(tmpdir(), 'mabari-e2e-session-'));
const dir = join(root, 'bin');
const data = join(root, 'data');
const config = join(root, 'claude');
const folder = join(root, 'shop');
const logs = join(root, 'logs');
const ran = join(root, 'ran');
const env = {
  ...process.env,
  PATH: `${dir}:${process.env.PATH ?? ''}`,
  MABARI_DATA_DIR: data,
  CLAUDE_CONFIG_DIR: config,
  CODEX_HOME: join(root, 'codex'),
  MABARI_SECRETS: 'encrypted-file',
  MABARI_MASTER_KEY: 'end-to-end-tests-only-master-key-0123456789',
  MABARI_NO_TERMINAL: '1',
  FAKE_CLAUDE_RAN: ran,
  FAKE_CLAUDE_LOG: logs,
};

let server: ChildProcess | undefined;
let vite: ChildProcess | undefined;
let apiPort = 0;
let web = '';
let api = '';

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => done(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

async function until(url: string) {
  for (let tries = 0; tries < 300; tries++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`${url} never answered`);
}

async function startServer() {
  server = spawn(join(dir, 'mabari'), ['serve', '--port', String(apiPort)], {
    env,
    stdio: 'ignore',
  });
  await until(`${api}/api/health`);
}

async function stopServer() {
  const running = server;
  server = undefined;
  if (!running || running.exitCode !== null) return;
  running.kill('SIGTERM');
  await once(running, 'exit');
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  for (const path of [dir, data, config, folder, logs]) mkdirSync(path, { recursive: true });
  const repository = resolve('..');
  execFileSync(
    'go',
    ['build', '-o', join(dir, 'claude'), './internal/connectors/claudecode/fakeclaude'],
    {
      cwd: repository,
    },
  );
  execFileSync('go', ['build', '-o', join(dir, 'mabari'), './cmd/mabari'], { cwd: repository });
  // The one check that matters most here: `claude`, as the server will find it, is the fake.
  const found = execFileSync('sh', ['-c', 'claude --version'], { env }).toString();
  expect(found).toContain('fake Claude Code');
  apiPort = await freePort();
  const webPort = await freePort();
  api = `http://127.0.0.1:${apiPort}`;
  web = `http://localhost:${webPort}`;
  await startServer();
  vite = spawn('pnpm', ['dev'], {
    env: { ...process.env, MABARI_WEB_PORT: String(webPort), MABARI_API_PORT: String(apiPort) },
    stdio: 'ignore',
  });
  await until(web);
});

test.afterAll(async () => {
  vite?.kill('SIGTERM');
  await stopServer();
  rmSync(root, { recursive: true, force: true });
});

interface Agent {
  id: string;
  name: string;
  session: { id: string; status: string; pid: number; resume: string } | null;
}

async function agentCalled(page: Page, name: string): Promise<Agent> {
  const agents = (await (await page.request.get(`${api}/api/agents`)).json()) as Agent[];
  const agent = agents.find((item) => item.name === name);
  if (!agent) throw new Error(`no agent called ${name}`);
  return agent;
}

async function newAgent(page: Page, name: string, task: string, workIn = folder) {
  await page.goto(`${web}/#accounts`);
  await page.getByRole('button', { name: 'New agent' }).click();
  const form = page.getByRole('dialog', { name: 'Create a new agent' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Account').selectOption('claude_code');
  await form.getByLabel('Instructions').fill(task);
  await form.getByLabel('Working folder').fill(workIn);
  await form.getByRole('button', { name: 'Create agent' }).click();
}

async function openAgent(page: Page, name: string) {
  const { id } = await agentCalled(page, name);
  await page.goto(`${web}/#office?agent=${id}`);
  await expect(page.getByRole('complementary', { name: 'Agent details' })).toBeVisible();
}

async function instruct(page: Page, text: string) {
  await page.locator('#cmdText').fill(text);
  await page.getByRole('button', { name: 'Send instruction' }).click();
}

const actions = () => (existsSync(ran) ? readFileSync(ran, 'utf8').trim().split('\n').length : 0);

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('with no terminal, a session starts, streams, stops for a click and survives a restart', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // Claude Code needs no attaching: it runs on the login this computer already has.
  await newAgent(page, 'Juniper', 'say hello');
  await expect(page.getByRole('dialog', { name: 'Create a new agent' })).toBeHidden();
  await openAgent(page, 'Juniper');
  const thread = page.getByTestId('thread');
  await expect(thread.getByTestId('threadAgent').last()).toContainText('Done: say hello');
  await expect(page.getByTestId('sessionSection')).toContainText('Mabari runs this session');

  // An instruction to an idle session lands at once, and streams word by word.
  await instruct(page, 'fake:slow 40');
  const reply = thread.getByTestId('threadAgent').last();
  await expect
    .poll(async () => (await reply.textContent())?.split('word').length ?? 0)
    .toBeGreaterThan(3);
  expect((await reply.textContent())?.split('word').length ?? 0).toBeLessThan(41);
  await expect.poll(async () => (await reply.textContent())?.split('word').length).toBe(41);

  // A risky action stops for a click, and nothing happens until there is one.
  await instruct(page, 'fake:bash rm -rf build');
  // The approvals board has an item named after the same word, so the banner's button is the exact one.
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  const card = page.getByRole('dialog');
  await expect(card).toContainText('rm -rf build');
  expect(actions()).toBe(0);
  await card.getByRole('button', { name: 'Deny' }).click();
  await expect(thread.getByTestId('threadTool').last()).toContainText('Denied');
  expect(actions()).toBe(0);

  await instruct(page, 'fake:bash rm -rf dist');
  // The approvals board has an item named after the same word, so the banner's button is the exact one.
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Allow once' }).click();
  await expect(thread.getByTestId('threadTool').last()).toContainText('Done');
  expect(actions()).toBe(1);

  // Continue in terminal shows the exact command.
  const before = await agentCalled(page, 'Juniper');
  await page.getByRole('button', { name: 'Continue in terminal' }).click();
  const command = page.getByTestId('continueCommand');
  await expect(command).toContainText(`claude --resume ${before.session?.id ?? ''}`);
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

  // A restart leaves no process behind, shows the session as resumable, and it carries on.
  const pid = before.session?.pid ?? 0;
  expect(running(pid)).toBe(true);
  await stopServer();
  expect(running(pid)).toBe(false);
  await startServer();
  await openAgent(page, 'Juniper');
  await expect(page.getByTestId('sessionResumable')).toBeVisible();
  await expect(thread.getByTestId('threadYou').first()).toContainText('say hello');
  await instruct(page, 'are you still there');
  await expect(thread.getByTestId('threadAgent').last()).toContainText('Done: are you still there');
  const lines = readFileSync(join(logs, `${before.session?.id ?? ''}.args`), 'utf8')
    .trim()
    .split('\n');
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain('--resume');
});

test('Start a Claude Code session on Accounts opens New agent, set to Claude Code', async ({
  page,
  request,
}) => {
  expect(
    (await request.post(`${api}/api/accounts/claude/connect`, { data: { confirm: true } })).ok(),
  ).toBe(true);
  await page.goto(`${web}/#accounts`);
  const card = page.locator('article.card', { hasText: 'Attach Claude Code' });
  await card.getByRole('button', { name: 'Start a Claude Code session' }).click();
  const form = page.getByRole('dialog', { name: 'Create a new agent' });
  await expect(form.getByLabel('Account')).toHaveValue('claude_code');
  await expect(form.getByLabel('Runs')).toHaveValue('here');
  await form.getByRole('button', { name: 'Cancel' }).click();
  // The terminal is still there for those who want it.
  await card.getByRole('button', { name: 'Or run it in a terminal' }).click();
  await expect(card.getByTestId('claudeCommand')).toContainText('claude');
  expect((await request.post(`${api}/api/accounts/claude/disconnect`)).ok()).toBe(true);
});

test('what a session shows is true: a call waiting, a denial, its time, the toasts', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await newAgent(page, 'Hazel', 'say hello');
  await expect(page.getByRole('dialog', { name: 'Create a new agent' })).toBeHidden();
  await openAgent(page, 'Hazel');
  const thread = page.getByTestId('thread');
  await expect(thread.getByTestId('threadAgent').last()).toContainText('Done: say hello');
  // Not the "0m 00s" every agent used to show, once it has been here a while.
  await expect(page.locator('.panel .meta', { hasText: 'Running for' })).not.toContainText(
    'Running for 0m 00s',
    {
      timeout: 5_000,
    },
  );

  await instruct(page, 'fake:bash rm -rf build');
  await expect(thread.getByTestId('threadTool').last()).toContainText('Waiting for you');
  const { id } = await agentCalled(page, 'Hazel');
  await page.goto(`${web}/#conversations?agent=${id}`);
  const line = page.getByTestId('chatTool').last();
  await expect(line).toContainText('Waiting for you');
  await page.getByRole('button', { name: 'Deny' }).click();
  await expect(line).toContainText('Denied');
  await page.reload();
  await expect(page.getByTestId('chatTool').last()).toContainText('Denied');

  // A reply lands in the thread on screen, so no toast points to it. Nor is a command clipped.
  const toasts = page.locator('.toast');
  const box = page.getByRole('textbox', { name: 'Message Hazel' });
  await box.fill('one more');
  await box.press('Enter');
  await expect(page.getByText('Done: one more')).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(toasts.filter({ hasText: 'Hazel replied' })).toHaveCount(0);

  // A "/" with nothing to list says so.
  await box.fill('/');
  await expect(page.getByTestId('noCommands')).toContainText('No commands here');
  await box.fill('');

  await openAgent(page, 'Hazel');
  await page.getByRole('button', { name: 'Continue in terminal' }).click();
  const dialog = page.getByRole('dialog', { name: 'Continue in a terminal' });
  const command = page.getByTestId('continueCommand');
  await expect(command).toBeVisible();
  expect(await command.evaluate((box) => box.scrollWidth <= box.clientWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Continue in terminal' }).click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(dialog).toBeHidden();
});

test('a folder that brings its own code needs a click first', async ({ page }) => {
  const repository = join(root, 'cloned');
  mkdirSync(repository, { recursive: true });
  writeFileSync(join(repository, '.mcp.json'), '{}');
  await newAgent(page, 'Pepper', 'hello there', repository);
  const question = page.getByRole('dialog', { name: 'Do you trust this folder?' });
  await expect(question.getByTestId('trustFound')).toContainText('.mcp.json');
  await question.getByRole('button', { name: "Don't start" }).click();
  await expect(page.getByRole('dialog', { name: 'Create a new agent' })).toContainText(
    "you didn't trust that folder",
  );
  await page
    .getByRole('dialog', { name: 'Create a new agent' })
    .getByRole('button', { name: 'Create agent' })
    .click();
  await question.getByRole('button', { name: 'Trust this folder and start' }).click();
  await expect(page.getByRole('dialog', { name: 'Create a new agent' })).toBeHidden();
  await openAgent(page, 'Pepper');
  await expect(page.getByTestId('thread').getByTestId('threadAgent').last()).toContainText(
    'Done: hello there',
  );
});

test('the cap is said out loud, and lives in Settings', async ({ page }) => {
  await page.goto(`${web}/#preferences`);
  await page.getByLabel('Claude Code sessions at once').selectOption('1');
  await expect
    .poll(async () => {
      const settings = (await (await page.request.get(`${api}/api/settings`)).json()) as {
        maxSessions: number;
      };
      return settings.maxSessions;
    })
    .toBe(1);
  await newAgent(page, 'Hazel', 'fake:hang');
  await expect(page.getByRole('dialog', { name: 'Create a new agent' })).toBeHidden();
  await newAgent(page, 'Wren', 'hello');
  await expect(page.getByRole('dialog', { name: 'Create a new agent' })).toContainText(
    'raise the limit in Settings',
  );
});
