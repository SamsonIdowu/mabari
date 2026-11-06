// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { wipe } from './support/page.ts';

// Claude asks the person a question (Claude Code's AskUserQuestion). The real `mabari hook`
// command carries it to the test server, signed with the install's token, exactly as Claude Code
// would run it, and prints what Claude Code would read back.

const apiPort = process.env.MABARI_API_PORT ?? '4327';
const env = {
  ...process.env,
  MABARI_DATA_DIR: process.env.MABARI_E2E_DATA_DIR!,
  CLAUDE_CONFIG_DIR: process.env.MABARI_E2E_CLAUDE_DIR!,
  MABARI_SECRETS: 'encrypted-file',
  MABARI_MASTER_KEY: process.env.MABARI_E2E_MASTER_KEY!,
};
const binary = join(mkdtempSync(join(tmpdir(), 'mabari-e2e-bin-')), 'mabari');

test.beforeAll(() => {
  // `mabari connect claude` refuses to run under `go run`, so the test builds the binary.
  execFileSync('go', ['build', '-o', binary, './cmd/mabari'], { cwd: resolve('..'), env });
});

test.beforeEach(async ({ request }) => {
  await wipe(request);
  // Wiping deletes the hook token, so Claude Code is connected afresh: that makes a new token, and
  // settings.json is the test's scratch Claude folder.
  execFileSync(binary, ['disconnect', 'claude'], { env });
  execFileSync(binary, ['connect', 'claude', '--yes'], { env });
});

test.afterAll(() => {
  execFileSync(binary, ['disconnect', 'claude'], { env });
});

const questions = [
  {
    question: 'Which database should the shop use?',
    header: 'Database',
    multiSelect: false,
    options: [
      { label: 'Postgres', description: 'Runs as its own server' },
      { label: 'SQLite', description: 'One file, no server' },
    ],
  },
  {
    question: 'Which checks should run on every push?',
    header: 'Checks',
    multiSelect: true,
    options: [
      { label: 'Lint', description: 'Style' },
      { label: 'Tests', description: 'Unit tests' },
      { label: 'Types', description: 'Type check' },
    ],
  },
];

/** Runs the hook as Claude Code would, and resolves with what it prints. */
function askFromClaudeCode(): Promise<string> {
  const hook = spawn(binary, ['hook', '--port', apiPort, 'PreToolUse'], { env });
  let printed = '';
  hook.stdout.on('data', (chunk: Buffer) => (printed += chunk.toString()));
  hook.stdin.end(
    JSON.stringify({
      session_id: '00000000-0000-4000-8000-000000000072',
      cwd: '/tmp/quizshop',
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions },
    }),
  );
  return new Promise((done) => hook.on('close', () => done(printed)));
}

/**
 * Asks once the page is live. Mabari asks only while someone has it open; a hook that comes
 * before the page's connection prints nothing at once, and is sent again.
 */
async function askOnceLive(page: Page, asking: Locator): Promise<{ printed: Promise<string> }> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const printed = askFromClaudeCode();
    const outcome = await Promise.race([
      printed.then(() => 'left to Claude Code'),
      asking.waitFor({ timeout: 10_000 }).then(
        () => 'shown',
        () => 'not shown',
      ),
    ]);
    // Wrapped, so awaiting this doesn't wait for the hook, which waits for the answer.
    if (outcome === 'shown') return { printed };
    await page.waitForTimeout(300);
  }
  throw new Error('the question never showed');
}

test('Claude asks a question and the answer from the panel goes back to it', async ({ page }) => {
  await page.goto('/#office');
  await expect(page.getByRole('heading', { name: 'No accounts connected' })).toBeVisible();
  const { printed } = await askOnceLive(
    page,
    page.locator('.bub.ask', { hasText: 'Asking you a question' }),
  );

  const tag = page.locator('.tag', { hasText: 'Quizshop' }).first();
  await expect(tag).toBeVisible();
  const box = (await tag.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y - 24);
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  const card = panel.getByRole('form', { name: 'Quizshop is asking you 2 questions' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('One file, no server');
  // A question is not an approval: nothing about it is red.
  await expect(panel.locator('.banner.red')).toHaveCount(0);

  const send = card.getByRole('button', { name: 'Send answers' });
  await expect(send).toBeDisabled();
  // Keyboard: pick SQLite with the arrow keys from Postgres.
  await card.getByRole('radio', { name: /Postgres/ }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(card.getByRole('radio', { name: /SQLite/ })).toBeChecked();
  const checks = card.getByRole('group', { name: /Which checks should run/ });
  await checks.getByRole('checkbox', { name: /Lint/ }).check();
  await checks.getByRole('checkbox', { name: /Types/ }).check();
  await checks.getByRole('textbox', { name: /Your own answer/ }).fill('Docs build');
  await expect(checks.getByRole('checkbox', { name: 'Other' })).toBeChecked();
  await send.click();

  const reply = JSON.parse(await printed) as {
    hookSpecificOutput: {
      hookEventName: string;
      permissionDecision: string;
      updatedInput: { questions: unknown; answers: Record<string, string> };
    };
  };
  expect(reply.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  expect(reply.hookSpecificOutput.permissionDecision).toBe('allow');
  expect(reply.hookSpecificOutput.updatedInput.questions).toEqual(questions);
  expect(reply.hookSpecificOutput.updatedInput.answers).toEqual({
    'Which database should the shop use?': 'SQLite',
    'Which checks should run on every push?': 'Lint, Types, Docs build',
  });
  await expect(card).toBeHidden();
});

test('Mabari on Home says a question is waiting, and Answer opens it', async ({ page }) => {
  await page.goto('/#home');
  await expect(page.locator('#homeSum')).toHaveText('No agents yet');
  const { printed } = await askOnceLive(page, page.locator('#homeSum', { hasText: 'need you' }));
  // A question is one of the things that need you, counted as everywhere else does. It is calm:
  // the summary says it in plain text, not in red.
  await expect(page.locator('#homeSum')).toContainText('1 need you');
  await expect(page.locator('#homeSum b')).toHaveCount(0);

  if (!(await page.locator('#hcForm').isVisible())) await page.locator('#hcType').click();
  await page.getByLabel('Message Mabari').fill('Who needs me?');
  await page.getByLabel('Message Mabari').press('Enter');
  const line = page.locator('.hclist li', { hasText: 'Quizshop' });
  await expect(line).toContainText(
    'is asking you: Which database should the shop use? (and 1 more question)',
  );
  await line.getByRole('button', { name: 'Answer' }).click();

  const card = page
    .getByRole('complementary', { name: 'Agent details' })
    .getByRole('form', { name: 'Quizshop is asking you 2 questions' });
  await card.getByRole('textbox', { name: /Which database/ }).fill('MySQL');
  await card
    .getByRole('group', { name: /Which checks/ })
    .getByRole('checkbox', { name: /Tests/ })
    .check();
  await card.getByRole('button', { name: 'Send answers' }).click();

  const reply = JSON.parse(await printed) as {
    hookSpecificOutput: { updatedInput: { answers: Record<string, string> } };
  };
  expect(reply.hookSpecificOutput.updatedInput.answers).toEqual({
    'Which database should the shop use?': 'MySQL',
    'Which checks should run on every push?': 'Tests',
  });
});
