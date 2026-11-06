// SPDX-License-Identifier: Apache-2.0
// Helpers for the tests that watch Mabari from outside the page: alerts, notifications, and the
// "tell me when it's done" watches. Agents come from the places real ones do. A hub agent reports
// any state it likes, including an error and done, and a Claude Code session is the real
// `mabari hook` command, as Claude Code would run it. Nothing here runs the real `claude`.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { wipe } from './support/page.ts';

export const apiPort = process.env.MABARI_API_PORT ?? '4327';

/** The environment the test server runs in, so the binary finds the same data and Claude folder. */
export function mabariEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MABARI_DATA_DIR: process.env.MABARI_E2E_DATA_DIR!,
    CLAUDE_CONFIG_DIR: process.env.MABARI_E2E_CLAUDE_DIR!,
    MABARI_SECRETS: 'encrypted-file',
    MABARI_MASTER_KEY: process.env.MABARI_E2E_MASTER_KEY!,
  };
}

/** Builds the mabari command, which `mabari connect claude` needs: it refuses `go run`. */
export function buildMabari(name: string): string {
  const binary = join(mkdtempSync(join(tmpdir(), `mabari-e2e-${name}-bin-`)), 'mabari');
  execFileSync('go', ['build', '-o', binary, './cmd/mabari'], {
    cwd: resolve('..'),
    env: mabariEnv(),
  });
  return binary;
}

/** Connects Claude Code to the test server, into the scratch Claude folder. */
export async function connectClaude(binary: string, request: APIRequestContext) {
  await wipe(request);
  execFileSync(binary, ['disconnect', 'claude'], { env: mabariEnv() });
  execFileSync(binary, ['connect', 'claude', '--yes'], { env: mabariEnv() });
}

export function disconnectClaude(binary: string) {
  execFileSync(binary, ['disconnect', 'claude'], { env: mabariEnv() });
}

/** Claude Code's session ids are UUIDs and Mabari takes nothing else, so a test's name gets one. */
export function sessionId(name: string): string {
  const hex = createHash('sha256').update(name).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A hook call from a Claude Code session, as the command runs it. */
export interface Hook {
  /** Resolves with what the hook printed once it ends. */
  printed: Promise<string>;
  process: ChildProcess;
}

export function claudeHook(
  binary: string,
  event: string,
  session: string,
  cwd: string,
  extra: Record<string, unknown> = {},
): Hook {
  const process = spawn(binary, ['hook', '--port', apiPort, event], { env: mabariEnv() });
  let printed = '';
  process.stdout.on('data', (chunk: Buffer) => (printed += chunk.toString()));
  process.stdin.end(
    JSON.stringify({ session_id: sessionId(session), cwd, hook_event_name: event, ...extra }),
  );
  return { process, printed: new Promise((done) => process.on('close', () => done(printed))) };
}

/** Runs a quick hook call, such as a prompt or the end of a turn, and waits for it. */
export async function claudeEvent(
  binary: string,
  event: string,
  session: string,
  cwd: string,
  extra: Record<string, unknown> = {},
) {
  await claudeHook(binary, event, session, cwd, extra).printed;
}

/**
 * Asks for a permission, as Claude Code does before a risky tool. Mabari asks only while someone
 * has it open, and a hook that comes before the page's connection prints nothing at once, so it is
 * sent again until `shown` is on the page. The hook waits for a decision, which a test gives with
 * `decide`, or leaves, and `stop` ends it.
 */
export async function permissionRequest(
  binary: string,
  shown: Locator,
  session: string,
  cwd: string,
  command: string,
): Promise<Hook> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const hook = claudeHook(binary, 'PermissionRequest', session, cwd, {
      tool_name: 'Bash',
      tool_input: { command },
    });
    const outcome = await Promise.race([
      hook.printed.then(() => 'left to Claude Code'),
      shown.waitFor({ timeout: 10_000 }).then(
        () => 'shown',
        () => 'not shown',
      ),
    ]);
    if (outcome === 'shown') return hook;
    hook.process.kill();
    await new Promise((later) => setTimeout(later, 300));
  }
  throw new Error('the approval never showed');
}

/** The id of the one approval that waits. */
export async function pendingApproval(request: APIRequestContext): Promise<string> {
  const pending = (await (await request.get('/api/approvals?pending=1')).json()) as {
    id: string;
  }[];
  expect(pending).toHaveLength(1);
  return pending[0]!.id;
}

/** The token hub agents report with. Making one replaces the last. */
export async function hubToken(request: APIRequestContext): Promise<string> {
  const { token } = (await (await request.post('/api/accounts/hub/token')).json()) as {
    token: string;
  };
  return token;
}

/** What a hub agent reports. */
export interface HubReport {
  name?: string;
  state?: string;
  task?: string;
  error?: string;
}

/**
 * Reports for a hub agent, as a person's own script would. The first report seats it. Vite
 * proxies only /api and /ws, so the hub is called on the Go server directly.
 */
export async function hubReport(
  request: APIRequestContext,
  token: string,
  agent: string,
  report: HubReport,
) {
  const response = await request.post(`http://127.0.0.1:${apiPort}/hub/v1/events`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { agent, ...report },
  });
  expect(response.status(), await response.text()).toBe(200);
}

/** What a hub agent was told, once: Mabari hands each instruction over a single time. */
export async function hubInstructions(
  request: APIRequestContext,
  token: string,
  agent: string,
): Promise<string[]> {
  const response = await request.get(
    `http://127.0.0.1:${apiPort}/hub/v1/agents/${agent}/instructions`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(response.status()).toBe(200);
  return ((await response.json()) as { instructions: string[] }).instructions;
}

/** The id Mabari gave an agent, by name. */
export async function agentId(request: APIRequestContext, name: string): Promise<string> {
  const snapshot = (await (await request.get('/api/snapshot')).json()) as {
    agents: { id: string; name: string }[];
  };
  const found = snapshot.agents.find((agent) => agent.name === name);
  expect(found, `no agent called ${name}`).toBeDefined();
  return found!.id;
}

/** What the Notification stub saw: every notification made, as the page made it. */
export interface Seen {
  title: string;
  options: Record<string, unknown>;
  closed: boolean;
}

export interface Stub {
  /** Every notification made so far. */
  seen: () => Promise<Seen[]>;
  /** How many times the page asked the browser for permission. */
  asked: () => Promise<number>;
  /** How many times the page brought itself to the front. */
  focused: () => Promise<number>;
  /** Hides the page, as a tab behind another is, or shows it again. */
  hide: (hidden: boolean) => Promise<void>;
  /** Clicks the nth notification, as the person would. */
  click: (index: number) => Promise<void>;
}

/**
 * Puts a stand-in for the browser's Notification in the page, and a page-visibility the test
 * controls, before the page loads. The permission starts as given, and a request for it is
 * answered with `answer`. The real thing would need a person to click Allow.
 */
export async function stubNotifications(
  page: Page,
  options: {
    permission?: 'default' | 'granted' | 'denied';
    answer?: 'granted' | 'denied' | 'default';
    hidden?: boolean;
    secure?: boolean;
  } = {},
): Promise<Stub> {
  const { permission = 'default', answer = 'granted', hidden = false, secure = true } = options;
  await page.addInitScript(
    ({ permission, answer, hidden, secure }) => {
      const w = window as unknown as Record<string, unknown>;
      w['__notes'] = [];
      w['__asked'] = 0;
      w['__focused'] = 0;
      class FakeNotification {
        static permission = permission;
        static requestPermission() {
          w['__asked'] = (w['__asked'] as number) + 1;
          FakeNotification.permission = answer;
          return Promise.resolve(answer);
        }
        title: string;
        options: unknown;
        closed = false;
        onclick: (() => void) | null = null;
        constructor(title: string, options: unknown) {
          this.title = title;
          this.options = options;
          (w['__notes'] as unknown[]).push(this);
        }
        close() {
          this.closed = true;
        }
      }
      Object.defineProperty(window, 'Notification', {
        value: FakeNotification,
        configurable: true,
      });
      Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true });
      window.focus = () => {
        w['__focused'] = (w['__focused'] as number) + 1;
      };
      let isHidden = hidden;
      Object.defineProperty(document, 'visibilityState', {
        get: () => (isHidden ? 'hidden' : 'visible'),
        configurable: true,
      });
      Object.defineProperty(document, 'hidden', { get: () => isHidden, configurable: true });
      w['__hide'] = (value: boolean) => {
        isHidden = value;
        document.dispatchEvent(new Event('visibilitychange'));
      };
    },
    { permission, answer, hidden, secure },
  );
  return {
    seen: () =>
      page.evaluate(() =>
        (
          (window as unknown as Record<string, unknown>)['__notes'] as {
            title: string;
            options: Record<string, unknown>;
            closed: boolean;
          }[]
        ).map(({ title, options, closed }) => ({ title, options, closed })),
      ),
    asked: () => page.evaluate(() => (window as unknown as Record<string, number>)['__asked']!),
    focused: () => page.evaluate(() => (window as unknown as Record<string, number>)['__focused']!),
    hide: (value) =>
      page.evaluate(
        (hide) => (window as unknown as Record<string, (v: boolean) => void>)['__hide']!(hide),
        value,
      ),
    click: (index) =>
      page.evaluate((at) => {
        const notes = (window as unknown as Record<string, unknown>)['__notes'] as {
          onclick: (() => void) | null;
        }[];
        notes[at]!.onclick!();
      }, index),
  };
}

/** The tab icon's address, which carries the red dot while an approval or an error waits. */
export async function favicon(page: Page): Promise<string> {
  return (await page.locator('link[rel~="icon"]').getAttribute('href')) ?? '';
}

/** Decodes an icon made on the spot, so a test can look for the dot in it. */
export function faviconText(href: string): string {
  return href.startsWith('data:image/svg+xml,')
    ? decodeURIComponent(href.slice('data:image/svg+xml,'.length))
    : href;
}
