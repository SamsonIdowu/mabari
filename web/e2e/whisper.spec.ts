// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page, type Route } from '@playwright/test';

// Local Whisper with a fake microphone (a steady tone) and a fake transcription route, so no
// model, whisper.cpp or real voice is needed. Nothing here reaches Hugging Face.

test.beforeEach(async ({ page, request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      await context.resume();
      const tone = context.createOscillator();
      const out = context.createMediaStreamDestination();
      tone.connect(out);
      tone.start();
      return out.stream;
    };
  });
});

async function demoWithWhisper(page: Page, messages: string[] = []) {
  page.on('request', (sent) => {
    if (sent.url().endsWith('/api/messages')) messages.push(sent.postData() ?? '');
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.locator('.tag .nt').first()).toBeVisible();
  await page.request.patch('/api/settings', { data: { voiceEngine: 'whisper' } });
  return messages;
}

/** Answers transcriptions after a short wait, and keeps what was uploaded. */
async function fakeTranscribe(page: Page, reply: (route: Route) => Promise<void>) {
  const uploads: Buffer[] = [];
  let release = () => undefined as void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/voice/transcribe**', async (route) => {
    uploads.push(route.request().postDataBuffer() ?? Buffer.alloc(0));
    await held;
    await reply(route);
  });
  return { uploads, release };
}

async function hold(page: Page) {
  await page.keyboard.down('Space');
  await expect(page.locator('#vTitle')).toHaveText('Listening… take your time, release when done');
  await expect(page.locator('.voice .help').first()).toHaveText('Local Whisper');
  await page.waitForTimeout(700);
  await page.keyboard.up('Space');
}

test('a recording becomes text on release, and still waits for Enter', async ({ page }) => {
  const messages = await demoWithWhisper(page);
  const whisper = await fakeTranscribe(page, (route) =>
    route.fulfill({ json: { text: 'Ask Scout how the endpoint is going' } }),
  );
  await hold(page);
  await expect(page.locator('#vTitle')).toHaveText('Turning it into text on this computer…');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  whisper.release();
  await expect(page.locator('#vText')).toContainText('Ask Scout how the endpoint is going');
  await expect(page.locator('#vTitle')).toHaveText('Ready to send');
  // The upload is a 16 kHz WAV of what was held.
  const upload = whisper.uploads[0];
  expect(upload?.subarray(0, 4).toString()).toBe('RIFF');
  expect(upload?.readUInt32LE(24)).toBe(16000);
  expect(upload?.length ?? 0).toBeGreaterThan(44 + 16000 * 2 * 0.3);
  await page.waitForTimeout(500);
  expect(messages).toEqual([]);
  await page.keyboard.press('Enter');
  await expect.poll(() => messages.length).toBe(1);
  expect(messages[0]).toContain('Ask Scout how the endpoint is going');
});

test('when Whisper is not set up it says why and sends nothing', async ({ page }) => {
  const messages = await demoWithWhisper(page);
  const whisper = await fakeTranscribe(page, (route) =>
    route.fulfill({
      status: 409,
      json: { error: "Local Whisper isn't ready: the Whisper model isn't downloaded yet." },
    }),
  );
  whisper.release();
  await hold(page);
  await expect(page.getByText("the Whisper model isn't downloaded yet")).toBeVisible();
  await expect(page.locator('.voice')).toHaveCount(0);
  expect(messages).toEqual([]);
});

test('Settings downloads the model only on a click', async ({ page }) => {
  let status = {
    installed: false,
    ready: false,
    downloading: false,
    done: 0,
    total: 1533763059,
    error: '',
  };
  let downloads = 0;
  await page.route('**/api/voice/whisper', (route) => route.fulfill({ json: status }));
  await page.route('**/api/voice/whisper/model', (route) => {
    downloads += 1;
    status = { ...status, downloading: true, done: status.total / 2 };
    return route.fulfill({ status: 202, json: status });
  });
  await page.goto('/#preferences');
  await page.getByRole('radio', { name: /Local Whisper/ }).check();
  await expect(page.locator('#whisperSetup')).toContainText('brew install whisper-cpp');
  expect(downloads).toBe(0);
  await page.getByRole('button', { name: 'Download the model (1.5 GB)' }).click();
  await expect(page.locator('#whisperSetup')).toContainText('Downloading the model… 50%');
  expect(downloads).toBe(1);
});
