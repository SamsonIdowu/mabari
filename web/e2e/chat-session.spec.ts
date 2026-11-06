// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FakeOffice } from './support/fakeOffice.ts';

// The conversation, against a real session that Mabari runs with the fake `claude`: text that
// streams, the message box's "@", "/", files, plan first, model and send-now choices. It has its own
// server, because the shared one cannot start sessions. The real claude is never run: FakeOffice
// proves `claude` is the fake before it starts anything. An approval in the thread is covered in
// chat.spec.ts, against the demo's. A real session's own hook calls can't be used for one yet:
// server/claude.go hands every hook call to Connector.Handle and reads X-Mabari-Run nowhere, so a
// session's PermissionRequest is never put to the person, and its tool is denied.

const office = new FakeOffice();

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await office.start();
  office.write('folder', 'README.md', '# Shop\n');
  office.write('folder', 'src/app.ts', 'export const app = 1;\n');
  office.write('folder', 'src/components/Button.tsx', 'export const Button = 1;\n');
  office.write('folder', 'docs/notes.md', 'notes\n');
  office.write(
    'config',
    'commands/ux-audit.md',
    '---\ndescription: Audit the UX\n---\nLook at $ARGUMENTS\n',
  );
  office.write('config', 'commands/standup.md', '# Write the standup\n');
  office.write('config', 'skills/tidy/SKILL.md', '---\ndescription: Tidy up\n---\n');
});

test.afterAll(async () => {
  await office.stop();
});

async function openChat(
  page: Page,
  name: string,
): Promise<{ id: string; thread: Locator; box: Locator }> {
  const { id } = await office.agent(name);
  await page.goto(`${office.web}/#conversations?agent=${id}`);
  const thread = page.getByRole('log', { name: `Messages with ${name}` });
  await expect(thread).toBeVisible();
  return { id, thread, box: page.getByRole('textbox', { name: `Message ${name}` }) };
}

async function say(page: Page, box: Locator, text: string) {
  await box.fill(text);
  await box.press('Enter');
  await expect(box).toHaveValue('');
}

test('text streams into the thread as it is written, and a reload shows all of it', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await office.startAgent('Juniper');
  const { thread, box } = await openChat(page, 'Juniper');
  await expect(thread.getByTestId('chatAgent').last()).toContainText('Done: say hello');
  await say(page, box, 'fake:slow 40');
  const reply = thread.getByTestId('chatAgent').last();
  // It grows in place while it arrives, with a caret and a busy flag for assistive technology.
  await expect(reply.locator('.md.streaming')).toBeVisible();
  await expect(reply).toHaveAttribute('aria-busy', 'true');
  await expect
    .poll(async () => (await reply.textContent())?.split('word').length ?? 0)
    .toBeGreaterThan(3);
  expect((await reply.textContent())?.split('word').length ?? 0).toBeLessThan(41);
  // The live line says what it is doing while it works.
  await expect(page.getByTestId('doingNow')).not.toBeEmpty();
  await expect.poll(async () => (await reply.textContent())?.split('word').length).toBe(41);
  await expect(reply.locator('.md.streaming')).toHaveCount(0);
  await expect(reply).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.getByTestId('doingNow')).toBeEmpty();
  // A reload shows the whole conversation, from what the server kept.
  await page.reload();
  const again = page
    .getByRole('log', { name: 'Messages with Juniper' })
    .getByTestId('chatAgent')
    .last();
  await expect.poll(async () => (await again.textContent())?.split('word').length).toBe(41);
  await expect(page.getByTestId('chatYou').first()).toContainText('say hello');
});

test('"@" completes a file or an agent, "/" lists commands and skills, and an unknown name goes through', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await office.startAgent('Wren');
  const { thread, box } = await openChat(page, 'Wren');
  await box.click();
  // Files in the agent's folder, by keyboard.
  await box.pressSequentially('look at @app');
  const files = page.getByRole('listbox', { name: 'Suggestions' });
  await expect(files.getByRole('option').first()).toContainText('src/app.ts');
  await expect(page.getByRole('status').filter({ hasText: /suggestions?\./ })).toBeVisible();
  await expect(box).toHaveAttribute('aria-activedescendant', /opt-0$/);
  await box.press('Enter');
  await expect(box).toHaveValue('look at @src/app.ts ');
  await expect(files).toHaveCount(0);
  // Folders keep going, and the box takes a letters-in-order match.
  await box.fill('');
  await box.pressSequentially('@scb');
  await expect(page.getByRole('option', { name: /src\/components\/Button\.tsx/ })).toBeVisible();
  await box.press('Escape');
  await expect(files).toHaveCount(0);
  // Nothing from the folder's .git, node_modules or dot files is offered.
  await box.fill('');
  await box.pressSequentially('@');
  await expect(files.getByRole('option').first()).toBeVisible();
  for (const text of await files.getByRole('option').allTextContents()) {
    expect(text).not.toMatch(/\.git|node_modules|\.env/);
  }
  await box.press('Escape');

  // Slash commands and skills of the account, found by what was typed.
  await box.fill('');
  await box.pressSequentially('/');
  const commands = page.getByRole('listbox', { name: 'Suggestions' });
  await expect(commands.getByRole('option')).toHaveCount(3);
  await box.pressSequentially('ux');
  await expect(commands.getByRole('option')).toHaveCount(1);
  await expect(commands.getByRole('option').first()).toContainText('/ux-audit');
  await expect(commands.getByRole('option').first()).toContainText('Audit the UX');
  await box.press('Tab');
  await expect(box).toHaveValue('/ux-audit ');
  await box.pressSequentially('the checkout');
  await box.press('Enter');
  await expect(thread.getByTestId('chatAgent').last()).toContainText(
    'Done: /ux-audit the checkout',
  );
  // A slash in the middle of a message is only a slash, and asks for nothing.
  await box.pressSequentially('see docs/notes.md and /usr/bin');
  await expect(page.getByRole('listbox', { name: 'Suggestions' })).toHaveCount(0);
  await box.fill('');
  // A name nothing knows is sent as it was typed.
  await say(page, box, '/not-a-command hello there');
  await expect(thread.getByTestId('chatAgent').last()).toContainText(
    'Done: /not-a-command hello there',
  );
});

test('files go with a message by picker, paste and drop, and the agent is given their paths', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await office.startAgent('Sorrel');
  const { thread, box } = await openChat(page, 'Sorrel');
  await expect(thread.getByTestId('chatAgent').last()).toContainText('Done: say hello');
  const form = page.getByRole('form', { name: 'Message Sorrel' });
  // Picker.
  await form.getByLabel('Choose files to attach').setInputFiles({
    name: 'brief.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('the brief'),
  });
  const chips = form.getByRole('list', { name: 'Files that go with this message' });
  await expect(chips).toContainText('brief.txt');
  await expect(chips).toContainText('9 B');
  // Paste: a picture has no name, so it gets one.
  await box.focus();
  await page.evaluate(() => {
    const target = document.activeElement as HTMLTextAreaElement;
    const data = new DataTransfer();
    data.items.add(
      new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' }),
    );
    target.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(chips.getByRole('listitem')).toHaveCount(2);
  await expect(chips).toContainText(/pasted-\d+\.png/);
  // Drop on the thread.
  await page.evaluate(() => {
    const target = document.querySelector('[data-testid="thread"]')!;
    const data = new DataTransfer();
    data.items.add(new File(['dropped'], 'dropped.md', { type: 'text/markdown' }));
    target.dispatchEvent(
      new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }),
    );
    target.dispatchEvent(
      new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(chips.getByRole('listitem')).toHaveCount(3);
  await expect(chips).toContainText('dropped.md');
  // One can be taken off again.
  await chips.getByRole('button', { name: 'Remove dropped.md' }).click();
  await expect(chips.getByRole('listitem')).toHaveCount(2);

  await say(page, box, 'read these');
  await expect(chips).toHaveCount(0);
  const you = thread.getByTestId('chatYou').last();
  await expect(you).toContainText('brief.txt');
  await expect(you).toContainText('read these');
  // The agent was given each file's path, inside Mabari's data folder, and the file is there.
  const reply = thread.getByTestId('chatAgent').last();
  await expect(reply).toContainText('Attached files, read them by path');
  const text = await reply.innerText();
  // The paths come back as a list, drawn as bullets, so the dash is not in the text.
  const paths = [...text.matchAll(/(\/\S+\/attachments\/[0-9a-f]{16}\/\S+)/g)].map(
    (match) => match[1]!,
  );
  expect(paths).toHaveLength(2);
  for (const path of paths) {
    expect(path.startsWith(office.data)).toBe(true);
    expect(existsSync(path)).toBe(true);
  }
  expect(
    readFileSync(
      paths.find((path) => path.endsWith('brief.txt'))!,
      'utf8',
    ),
  ).toBe('the brief');
  // A file over the limit is refused with the reason, and nothing is added.
  await form.getByLabel('Choose files to attach').setInputFiles({
    name: 'huge.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(26 * 1024 * 1024),
  });
  await expect(page.locator('.toast').last()).toContainText('huge.bin is over 25 MB');
  await expect(chips).toHaveCount(0);
});

test('plan first holds the session to a plan until you approve it', async ({ page }) => {
  test.setTimeout(90_000);
  const agent = await office.startAgent('Plover');
  const { thread, box } = await openChat(page, 'Plover');
  await expect(thread.getByTestId('chatAgent').last()).toContainText('Done: say hello');
  const plan = page.getByRole('button', { name: 'Plan first' });
  await expect(plan).toHaveAttribute('aria-pressed', 'false');
  await plan.click();
  await expect(plan).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('deliveryNote')).toContainText('Claude Code holds it to a plan');
  await say(page, box, 'add a login page');
  // It resets, and the plan comes back as an approval, in the thread.
  await expect(plan).toHaveAttribute('aria-pressed', 'false');
  const card = thread.getByTestId('chatApproval');
  await expect(card).toContainText('Approve the plan');
  const lines = office.argLines((await office.agent('Plover')).session!.id);
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain('plan');
  expect(lines[0]).not.toContain('plan');
  expect(office.actions()).toBe(0);
  await card.getByRole('button', { name: 'Allow once' }).click();
  await expect(thread.getByTestId('chatAgent').last()).toContainText('Done: The plan is approved');
  expect(agent.name).toBe('Plover');
});

test('the model can be switched with a message only while the session is not working', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await office.startAgent('Teal');
  const { id, thread, box } = await openChat(page, 'Teal');
  await expect(thread.getByTestId('chatAgent').last()).toContainText('Done: say hello');
  const model = page.getByLabel('Model for this message');
  await expect(model).toBeEnabled();
  await expect(model).toHaveValue('claude-sonnet-4-5');
  await model.selectOption('claude-haiku-4-5');
  await say(page, box, 'a quick one');
  await expect(thread.getByTestId('chatAgent').last()).toContainText('Done: a quick one');
  const session = (await office.agent('Teal')).session!.id;
  const lines = office.argLines(session);
  expect(lines).toHaveLength(2);
  expect(lines[1]).toEqual(expect.arrayContaining(['--model', 'claude-haiku-4-5']));
  await expect(model).toHaveValue('claude-haiku-4-5');
  expect((await office.agent('Teal')).model).toBe('claude-haiku-4-5');
  expect(id).toBeTruthy();

  // While it works, the picker is off, and says why.
  await office.startAgent('Ember', 'fake:hang');
  await openChat(page, 'Ember');
  await expect(page.getByTestId('doingNow')).not.toBeEmpty();
  const busy = page.getByLabel('Model for this message');
  await expect(busy).toBeDisabled();
  await expect(busy).toHaveAttribute(
    'title',
    /Ember is working\. Change its model once it has finished/,
  );
});

test('a message to a working session is queued and can be taken back, or sent now', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await office.startAgent('Larch', 'fake:hang');
  const { thread, box } = await openChat(page, 'Larch');
  await expect(page.getByTestId('doingNow')).not.toBeEmpty();
  const note = page.getByTestId('deliveryNote');
  await expect(note).toContainText(
    'Larch is working. This is queued and read at its next checkpoint.',
  );
  const send = page.getByTestId('chatSend');
  await expect(send).toHaveText('Queue');
  await say(page, box, 'when you can, also check the footer');
  const pending = thread.getByTestId('chatPending');
  await expect(pending).toContainText('Waiting for its next checkpoint');
  await expect(pending).toContainText('also check the footer');
  // Taking it back leaves nothing waiting.
  await pending.getByRole('button', { name: /^Remove “when you can/ }).click();
  await expect(pending).toHaveCount(0);
  // Send now interrupts what it is doing and sends at once.
  await box.fill('stop, and say hello instead');
  await page.getByRole('button', { name: 'Interrupt and send now' }).click();
  await expect(thread.getByTestId('chatAgent').last()).toContainText(
    'Done: stop, and say hello instead',
  );
  await expect(thread.getByTestId('chatPending')).toHaveCount(0);
  await expect(send).toHaveText('Send');
  await expect(note).toContainText('This goes to Larch straight away.');
});

test('what is typed is kept for each thread through switching and a reload', async ({ page }) => {
  test.setTimeout(90_000);
  await office.startAgent('Birch');
  await office.startAgent('Alder');
  const birch = await openChat(page, 'Birch');
  await birch.box.fill('half a thought for Birch');
  await page.getByRole('button', { name: 'Plan first' }).click();
  // Another thread has its own box, and Birch's comes back.
  await page.getByRole('link', { name: /Alder/ }).first().click();
  const alder = page.getByRole('textbox', { name: 'Message Alder' });
  await expect(alder).toHaveValue('');
  await alder.fill('and one for Alder');
  await page.getByRole('link', { name: /Birch/ }).first().click();
  await expect(page.getByRole('textbox', { name: 'Message Birch' })).toHaveValue(
    'half a thought for Birch',
  );
  await expect(page.getByRole('button', { name: 'Plan first' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message Birch' })).toHaveValue(
    'half a thought for Birch',
  );
  await page.getByRole('link', { name: /Alder/ }).first().click();
  await expect(page.getByRole('textbox', { name: 'Message Alder' })).toHaveValue(
    'and one for Alder',
  );
  // Sending clears it for good.
  await page.getByRole('textbox', { name: 'Message Alder' }).press('Enter');
  await expect(page.getByRole('textbox', { name: 'Message Alder' })).toHaveValue('');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message Alder' })).toHaveValue('');
});
