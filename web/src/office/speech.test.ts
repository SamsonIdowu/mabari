// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { crashesWhenAsked } from './speech.ts';

const WINDOW_BROWSER = {
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  automated: false,
};
const HEADLESS = {
  userAgent: WINDOW_BROWSER.userAgent.replace('Chrome/', 'HeadlessChrome/'),
  automated: true,
};
// Playwright's device descriptors give a headless browser an ordinary user agent.
const DISGUISED = { ...WINDOW_BROWSER, automated: true };

// A built in function prints as "[native code]", as a browser's own SpeechRecognition does.
const builtIn = Math.max;
class WrittenInJavaScript {}

describe('crashesWhenAsked', () => {
  it("refuses a headless browser's own speech engine, which takes the page down when asked", () => {
    expect(crashesWhenAsked(HEADLESS, builtIn)).toBe(true);
    expect(crashesWhenAsked(DISGUISED, builtIn)).toBe(true);
    expect(crashesWhenAsked({ ...HEADLESS, automated: false }, builtIn)).toBe(true);
  });

  it('leaves a browser a person is using alone', () => {
    expect(crashesWhenAsked(WINDOW_BROWSER, builtIn)).toBe(false);
  });

  it('leaves a stand-in written in JavaScript alone, as the tests use', () => {
    expect(crashesWhenAsked(HEADLESS, WrittenInJavaScript)).toBe(false);
    expect(crashesWhenAsked(DISGUISED, WrittenInJavaScript)).toBe(false);
  });
});
