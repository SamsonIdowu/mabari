// SPDX-License-Identifier: Apache-2.0
import { recordForWhisper } from './whisper.ts';

interface RecognitionResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally: boolean;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type RecognitionClass = new () => Recognition;

export interface Listener {
  stop: () => void;
  abort: () => void;
}

export interface Handlers {
  onText: (text: string) => void;
  onError: (message: string) => void;
  onEnd: () => void;
}

const QUIET_ERRORS = ['aborted', 'no-speech'];

function errorText(code: string): string {
  if (code === 'not-allowed') return 'Mabari needs your OK to use the microphone.';
  return "This browser can't recognise speech on this computer right now, so nothing was recorded.";
}

export type VoiceEngine = 'browser' | 'whisper';

/**
 * Playwright's headless Chromium build (headless shell, Chromium 156) has no speech service, and
 * asking its own SpeechRecognition to start() takes the whole page down: the renderer crashes
 * the moment a key press or click makes the call, and a crash can't be caught. Every window
 * browser, and full Chromium run headless, answers with an error instead (here
 * "language-not-supported"). Playwright can swap the user agent for a normal one, so a browser
 * that says it is driven by automation counts too. No person is talking to either. They are
 * refused before they are asked, with a message. A stand-in written in JavaScript, as the tests
 * use, is not native code and is left alone.
 */
export function crashesWhenAsked(
  browser: { userAgent: string; automated: boolean },
  speech: object,
): boolean {
  const headless = browser.automated || /HeadlessChrome/.test(browser.userAgent);
  return headless && /\[native code\]/.test(Function.prototype.toString.call(speech));
}

/**
 * Listens with the engine chosen in Settings. Either way speech stays on this computer:
 * browser speech is asked to work locally, and Local Whisper runs in Mabari's own server.
 * Browser speech reports text as it hears it; Whisper reports it once, after stop.
 */
export function listen(handlers: Handlers, engine: string = 'browser'): Listener | null {
  return engine === 'whisper' ? recordForWhisper(handlers) : listenInBrowser(handlers);
}

/**
 * Listens through the browser's speech recognition, on this computer only. processLocally means
 * the work must be done locally, so a browser without it is refused rather than allowed to pick
 * a remote service. Returns null if listening can't start.
 */
function listenInBrowser(handlers: Handlers): Listener | null {
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionClass;
    webkitSpeechRecognition?: RecognitionClass;
  };
  const Speech = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  if (!Speech || !('processLocally' in Speech.prototype)) {
    handlers.onError(
      "This browser can't recognise speech on this computer, and Mabari won't send your voice anywhere else.",
    );
    return null;
  }
  if (
    crashesWhenAsked({ userAgent: navigator.userAgent, automated: navigator.webdriver }, Speech)
  ) {
    handlers.onError(
      "This browser is run by a program, with no microphone, so it can't listen. Nothing was recorded.",
    );
    return null;
  }
  const recognition = new Speech();
  recognition.lang = navigator.language || 'en-GB';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.processLocally = true;
  recognition.onresult = (event) => {
    let text = '';
    for (let index = 0; index < event.results.length; index++) {
      text += event.results[index]?.[0]?.transcript ?? '';
    }
    handlers.onText(text.trim());
  };
  recognition.onerror = (event) => {
    if (!QUIET_ERRORS.includes(event.error)) handlers.onError(errorText(event.error));
  };
  recognition.onend = handlers.onEnd;
  try {
    recognition.start();
  } catch {
    handlers.onError(errorText('start'));
    return null;
  }
  return recognition;
}
