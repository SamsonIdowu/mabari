// SPDX-License-Identifier: Apache-2.0
// The mic on Home's dock: push to talk, and a Snapchat style lock. Speech recognition is faked,
// so "saying" something is a call to window.fakeSpeech.say.
import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window {
    fakeSpeech: { started: number; local: boolean | null; say: (text: string) => void };
  }
}

const sent: string[] = [];

test.beforeEach(async ({ page, request }) => {
  sent.length = 0;
  await request.post('/api/wipe', { data: { confirm: true } });
  await request.post('/api/demo/load');
  await page.addInitScript(() => {
    class FakeSpeech {
      declare processLocally: boolean;
      onresult: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      start() {
        window.fakeSpeech.started += 1;
        window.fakeSpeech.say = (text) => this.onresult?.({ results: [[{ transcript: text }]] });
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
  page.on('request', (call) => {
    if (call.url().endsWith('/api/vee')) sent.push(call.postDataJSON().text);
  });
  await page.goto('/#home');
  await expect(page.locator('#homeSum')).toContainText('working');
});

const mic = (page: Page) => page.locator('#hcMic');
const label = (page: Page) => page.locator('#hcMic .dklbl');

/** Presses the middle of the mic with the mouse and keeps holding. */
async function hold(page: Page) {
  const box = (await page.locator('#hcMic .dkic').boundingBox())!;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  return point;
}

test('push to talk: hold Space, speak, release to send', async ({ page }) => {
  await page.keyboard.down('Space');
  await expect(mic(page)).toHaveClass(/on/);
  await expect(label(page)).toHaveText('Listening…');
  await expect(page.locator('#youSaid')).toHaveText('Listening…');
  await page.evaluate(() => window.fakeSpeech.say('Tell Ledger to add tests for the totals'));
  await expect(page.locator('#youSaid')).toHaveText('Tell Ledger to add tests for the totals');
  await page.keyboard.up('Space');
  await expect.poll(() => sent).toEqual(['Tell Ledger to add tests for the totals']);
  await expect(mic(page)).not.toHaveClass(/on/);
  await expect(label(page)).toHaveText('Hold to talk');
});

test('holding the mic and releasing before it locks sends', async ({ page }) => {
  await hold(page);
  await expect(page.locator('.micwrap')).toHaveClass(/pressing/);
  await expect(page.locator('.micring')).toBeVisible();
  await page.evaluate(() => window.fakeSpeech.say("What's happening in the office?"));
  await page.waitForTimeout(600);
  await page.mouse.up();
  await expect.poll(() => sent).toEqual(["What's happening in the office?"]);
});

test('hold to lock: the ring fills over 2 s, then release keeps listening and a tap sends', async ({
  page,
}) => {
  await hold(page);
  await expect(page.locator('#hcLock')).toHaveAttribute('aria-pressed', 'false');
  await expect(label(page)).toHaveText('Tap to send', { timeout: 3000 });
  await expect(page.locator('#hcLock')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.micring')).toHaveCount(0);
  await page.mouse.up();
  await page.evaluate(() => window.fakeSpeech.say('Who needs me right now?'));
  await page.waitForTimeout(400);
  expect(sent).toEqual([]);
  await expect(mic(page)).toHaveClass(/locked/);
  // Tap to send.
  await mic(page).click();
  await expect.poll(() => sent).toEqual(['Who needs me right now?']);
  await expect(label(page)).toHaveText('Hold to talk');
});

test('swipe up to lock', async ({ page }) => {
  const start = await hold(page);
  await page.mouse.move(start.x, start.y - 30);
  await expect(label(page)).toHaveText('Listening…');
  await page.mouse.move(start.x, start.y - 70);
  await expect(label(page)).toHaveText('Tap to send');
  await page.mouse.up();
  await expect(mic(page)).toHaveClass(/on/);
  await page.evaluate(() => window.fakeSpeech.say('When will everything be done?'));
  await mic(page).click();
  await expect.poll(() => sent).toEqual(['When will everything be done?']);
});

test('Esc cancels a locked mic without sending', async ({ page }) => {
  await page.locator('#hcLock').click();
  await expect(label(page)).toHaveText('Tap to send');
  await page.evaluate(() => window.fakeSpeech.say('Tell Ledger to delete everything'));
  await expect(page.locator('#youSaid')).toHaveText('Tell Ledger to delete everything');
  await page.keyboard.press('Escape');
  await expect(mic(page)).not.toHaveClass(/on/);
  await expect(page.locator('#youSaid')).toHaveCount(0);
  await page.waitForTimeout(400);
  expect(sent).toEqual([]);
});

test('the padlock locks and unlocks directly, and unlocking sends', async ({ page }) => {
  const lock = page.locator('#hcLock');
  await expect(lock).toHaveAccessibleName('Lock the mic on');
  await lock.click();
  await expect(lock).toHaveAccessibleName('Unlock and send');
  await page.evaluate(() => window.fakeSpeech.say('Can you do a little dance?'));
  await lock.click();
  await expect.poll(() => sent).toEqual(['Can you do a little dance?']);
  await expect(lock).toHaveAttribute('aria-pressed', 'false');
});

test('a quick tap only shows how the mic works', async ({ page }) => {
  await hold(page);
  await page.mouse.up();
  await expect(page.locator('.toast').last()).toContainText(
    'Hold the mic to talk, or swipe up to lock it on.',
  );
  await expect(mic(page)).not.toHaveClass(/on/);
  await page.waitForTimeout(300);
  expect(sent).toEqual([]);
});

test('a right click on the mic does nothing', async ({ page }) => {
  await mic(page).click({ button: 'right' });
  await page.waitForTimeout(2300);
  await expect(mic(page)).not.toHaveClass(/on/);
});

test('leaving the window stops an unlocked mic without sending', async ({ page }) => {
  await page.keyboard.down('Space');
  await expect(mic(page)).toHaveClass(/on/);
  await page.evaluate(() => window.fakeSpeech.say('Tell Ledger to ship it'));
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(mic(page)).not.toHaveClass(/on/);
  await page.keyboard.up('Space');
  await page.waitForTimeout(300);
  expect(sent).toEqual([]);
});

test('after the padlock, Space is still push to talk', async ({ page }) => {
  const lock = page.locator('#hcLock');
  await lock.click();
  await page.evaluate(() => window.fakeSpeech.say('first'));
  await lock.click();
  await expect.poll(() => sent).toEqual(['first']);
  await page.keyboard.down('Space');
  await expect(label(page)).toHaveText('Listening…');
  await page.evaluate(() => window.fakeSpeech.say('second'));
  await page.keyboard.up('Space');
  await expect.poll(() => sent).toEqual(['first', 'second']);
  await expect(label(page)).toHaveText('Hold to talk');
});
