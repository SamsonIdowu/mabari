// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window {
    fakeSpeech: {
      started: number;
      local: boolean | null;
      say: (text: string) => void;
    };
  }
}

test.beforeEach(async ({ page, request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
  await page.addInitScript(() => {
    class FakeSpeech {
      declare processLocally: boolean;
      onresult: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      start() {
        window.fakeSpeech.started += 1;
        window.fakeSpeech.local = this.processLocally;
        window.fakeSpeech.say = (text) => this.onresult?.({ results: [[{ transcript: text }]] });
      }
      stop() {
        this.onend?.();
      }
      abort() {
        this.onend?.();
      }
    }
    // Browsers that can work on device have this on the prototype, which is what Mabari checks.
    FakeSpeech.prototype.processLocally = false;
    window.fakeSpeech = { started: 0, local: null, say: () => undefined };
    Object.assign(window, { SpeechRecognition: FakeSpeech });
  });
});

async function office(page: Page, messages: string[] = []) {
  page.on('request', (request) => {
    if (request.url().endsWith('/api/messages')) messages.push(request.postData() ?? '');
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.locator('.tag .nt').first()).toBeVisible();
  return messages;
}

async function speak(page: Page, text: string) {
  await page.keyboard.down('Space');
  await expect(page.locator('#vTitle')).toHaveText('Listening… take your time, release when done');
  await page.evaluate((words) => window.fakeSpeech.say(words), text);
  await expect(page.locator('#vText')).toContainText(text);
  await page.keyboard.up('Space');
}

test('asks the browser to keep speech on this computer', async ({ page }) => {
  await office(page);
  await speak(page, 'Scout, add the pricing pages');
  expect(await page.evaluate(() => window.fakeSpeech.local)).toBe(true);
});

test('a browser without on device speech is refused', async ({ page }) => {
  await office(page);
  await page.evaluate(() => {
    class Remote {}
    Object.assign(window, { SpeechRecognition: Remote });
  });
  await page.keyboard.down('Space');
  await expect(page.getByText("Mabari won't send your voice anywhere else.")).toBeVisible();
  await page.keyboard.up('Space');
  await expect(page.locator('.voice')).toBeHidden();
});

test('nothing is sent without Send or Enter, however long it waits', async ({ page }) => {
  await page.clock.install();
  const messages = await office(page);
  await speak(page, 'Scout, add the pricing pages');
  await expect(page.locator('#vTitle')).toHaveText('Ready to send');
  await expect(page.locator('.voice')).toContainText("Goes straight into Scout's session.");
  await page.clock.fastForward(10 * 60 * 1000);
  await expect(page.locator('#vTitle')).toHaveText('Ready to send');
  expect(messages).toEqual([]);
  await expect(page.locator('.ring')).toHaveCount(0);
  await page.locator('.voice').getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.voice')).toBeHidden();
  await expect.poll(() => messages.length).toBe(1);
  expect(JSON.parse(messages[0]!)).toMatchObject({ text: 'Scout, add the pricing pages' });
  await expect(page.getByText('Sent to Scout')).toBeVisible();
});

test('Enter sends', async ({ page }) => {
  const messages = await office(page);
  await speak(page, 'What is Ledger working on right now');
  await expect(page.locator('.voice')).toContainText(
    'Answered from the log. Ledger is not interrupted.',
  );
  await page.keyboard.press('Enter');
  await expect.poll(() => messages.length).toBe(1);
  expect(JSON.parse(messages[0]!)).toMatchObject({ mode: 'query' });
  await expect(page.locator('.answer')).toContainText('Ledger was not interrupted.');
});

test('Esc and Cancel throw it away', async ({ page }) => {
  const messages = await office(page);
  await speak(page, 'Scout, add the pricing pages');
  await page.keyboard.press('Escape');
  await expect(page.locator('.voice')).toBeHidden();
  await expect(page.getByText('Cancelled. Nothing was sent.')).toBeVisible();

  await speak(page, 'Scout, add the pricing pages');
  await page.locator('.voice').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.voice')).toBeHidden();
  expect(messages).toEqual([]);
});

test('Enter on the focused Cancel button cancels', async ({ page }) => {
  const messages = await office(page);
  await speak(page, 'Scout, add the pricing pages');
  await page.locator('.voice').getByRole('button', { name: 'Cancel' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.voice')).toBeHidden();
  expect(messages).toEqual([]);
});

test('hearing nothing sends nothing', async ({ page }) => {
  const messages = await office(page);
  await page.keyboard.down('Space');
  await expect(page.locator('.voice')).toBeVisible();
  await page.keyboard.up('Space');
  await expect(page.getByText("I didn't catch that. Nothing was sent.")).toBeVisible();
  expect(messages).toEqual([]);
});

test('the mic works by holding it too', async ({ page }) => {
  await office(page);
  const mic = page.getByRole('button', { name: 'Hold to talk' });
  await mic.hover();
  await page.mouse.down();
  await expect(mic).toHaveClass(/live/);
  await page.evaluate(() => window.fakeSpeech.say('Scout, add the pages'));
  await page.mouse.up();
  await expect(page.locator('#vTitle')).toHaveText('Ready to send');
});

test('a spoken approval opens the card and still needs a click', async ({ page, request }) => {
  const messages = await office(page);
  await speak(page, 'Atlas, go ahead and allow the migration');
  const card = page.getByRole('dialog', { name: /Atlas/ });
  await expect(card).toContainText('You said “allow”. Risky actions always need a click');
  expect(messages).toEqual([]);
  const pending = await (await request.get('/api/approvals')).text();
  expect(pending).toContain('db:migrate');
  await card.getByRole('button', { name: 'Close' }).click();
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await panel.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByRole('dialog', { name: /Atlas/ })).not.toContainText('You said');
});

test('Space in a text box types a space', async ({ page }) => {
  await office(page);
  const box = page.getByLabel('Message', { exact: true });
  await box.pressSequentially('a b');
  await expect(box).toHaveValue('a b');
  await expect(page.locator('.voice')).toBeHidden();
});

test('no help text mentions a countdown', async ({ page }) => {
  await office(page);
  await page.locator('.topright').getByText('Notes').click();
  await expect(page.locator('.cmdbar .note')).toContainText(
    'press Send when you are happy with it',
  );
  await page.goto('/#components');
  await expect(page.locator('main')).not.toContainText(/2 second|Send now/);
  await expect(page.locator('main')).toContainText('Nothing is sent until you press Send');
});

// Home: hold Space to talk to Mabari. A question is answered at once; an instruction waits in the
// box for Enter, so nothing reaches an agent by voice alone.
test('on Home a spoken question goes to Mabari, and an instruction waits for Enter', async ({
  page,
}) => {
  const asked: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/vee')) asked.push(request.postData() ?? '');
  });
  await office(page);
  await page.goto('/#home');
  await expect(page.locator('.h2under')).toContainText('hold the mic or Space to talk');
  await page.locator('#hcText').focus();

  await page.keyboard.down('Space');
  expect(await page.evaluate(() => window.fakeSpeech.started)).toBeGreaterThan(0);
  await expect(page.locator('#hcMic')).toHaveClass(/on/);
  expect(await page.evaluate(() => window.fakeSpeech.local)).toBe(true);
  await page.evaluate(() => window.fakeSpeech.say("What's happening in the office?"));
  await expect(page.locator('#hcText')).toHaveValue("What's happening in the office?");
  await page.keyboard.up('Space');
  await expect.poll(() => asked.length).toBe(1);
  await expect(page.locator('#hcText')).toHaveValue('');

  await page.locator('#hcMic').dispatchEvent('pointerdown');
  await page.evaluate(() => window.fakeSpeech.say('Tell Ledger to add tests for the totals'));
  await page.mouse.up();
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup')));
  await expect(page.locator('#hcText')).toHaveValue('Tell Ledger to add tests for the totals');
  await page.waitForTimeout(400);
  expect(asked).toHaveLength(1);
  await page.locator('#hcText').press('Enter');
  await expect.poll(() => asked.length).toBe(2);
});
