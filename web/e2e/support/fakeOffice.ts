// SPDX-License-Identifier: Apache-2.0
// A Mabari of its own, with the fake `claude` first on PATH, for specs that need a session to run
// with no terminal: the shared test server sets MABARI_NO_SESSIONS. It checks, before anything
// starts, that `claude` as the server will find it is the fake, because the real program would
// spend the person's account. The fake is built from internal/connectors/claudecode/fakeclaude.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect } from '@playwright/test';

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

export interface FakeAgent {
  id: string;
  name: string;
  model: string;
  state: string;
  session: { id: string; status: string; pid: number; resume: string; mode: string } | null;
}

export class FakeOffice {
  readonly root = mkdtempSync(join(tmpdir(), 'mabari-e2e-chat-'));
  readonly bin = join(this.root, 'bin');
  readonly data = join(this.root, 'data');
  readonly config = join(this.root, 'claude');
  readonly folder = join(this.root, 'shop');
  readonly logs = join(this.root, 'logs');
  readonly ran = join(this.root, 'ran');
  readonly serverLog = join(this.root, 'server.log');
  api = '';
  web = '';
  private server: ChildProcess | undefined;
  private vite: ChildProcess | undefined;

  private get env() {
    return {
      ...process.env,
      PATH: `${this.bin}:${process.env.PATH ?? ''}`,
      MABARI_DATA_DIR: this.data,
      CLAUDE_CONFIG_DIR: this.config,
      CODEX_HOME: join(this.root, 'codex'),
      MABARI_SECRETS: 'encrypted-file',
      MABARI_MASTER_KEY: 'end-to-end-tests-only-master-key-0123456789',
      MABARI_NO_TERMINAL: '1',
      FAKE_CLAUDE_RAN: this.ran,
      FAKE_CLAUDE_LOG: this.logs,
    };
  }

  /** Builds the fake and the server, proves `claude` is the fake, and starts both servers. */
  async start() {
    for (const path of [this.bin, this.data, this.config, this.folder, this.logs]) {
      mkdirSync(path, { recursive: true });
    }
    const repository = resolve('..');
    execFileSync(
      'go',
      ['build', '-o', join(this.bin, 'claude'), './internal/connectors/claudecode/fakeclaude'],
      { cwd: repository },
    );
    execFileSync('go', ['build', '-o', join(this.bin, 'mabari'), './cmd/mabari'], {
      cwd: repository,
    });
    // The one check that matters most here: `claude`, as the server will find it, is the fake.
    const found = execFileSync('sh', ['-c', 'claude --version'], { env: this.env }).toString();
    expect(found).toContain('fake Claude Code');
    const apiPort = await freePort();
    const webPort = await freePort();
    this.api = `http://127.0.0.1:${apiPort}`;
    this.web = `http://localhost:${webPort}`;
    await this.startServer(apiPort);
    this.vite = spawn('pnpm', ['dev'], {
      env: { ...process.env, MABARI_WEB_PORT: String(webPort), MABARI_API_PORT: String(apiPort) },
      stdio: 'ignore',
    });
    await until(this.web);
  }

  private async startServer(port: number) {
    // What the server says goes to a file, to read when a test fails.
    const log = openSync(this.serverLog, 'a');
    this.server = spawn(join(this.bin, 'mabari'), ['serve', '--port', String(port)], {
      env: this.env,
      stdio: ['ignore', log, log],
    });
    closeSync(log);
    await until(`${this.api}/api/health`);
  }

  async stop() {
    this.vite?.kill('SIGTERM');
    const running = this.server;
    this.server = undefined;
    if (running && running.exitCode === null) {
      running.kill('SIGTERM');
      await once(running, 'exit');
    }
    rmSync(this.root, { recursive: true, force: true });
  }

  /** Writes a file under the shop's folder, or anywhere under the account's Claude folder. */
  write(where: 'folder' | 'config', path: string, body: string) {
    const full = join(where === 'folder' ? this.folder : this.config, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }

  async agents(): Promise<FakeAgent[]> {
    return (await (await fetch(`${this.api}/api/agents`)).json()) as FakeAgent[];
  }

  async agent(name: string): Promise<FakeAgent> {
    const found = (await this.agents()).find((item) => item.name === name);
    if (!found) throw new Error(`no agent called ${name}`);
    return found;
  }

  /** Starts a Claude Code session in the shop and waits for its first reply. */
  async startAgent(name: string, task = 'say hello'): Promise<FakeAgent> {
    const response = await fetch(`${this.api}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        account: 'claude_code',
        model: 'claude-sonnet-4-5',
        task,
        projectId: '',
        folder: this.folder,
        dailyCostCap: 5,
        allowedTools: ['read', 'edit', 'shell'],
      }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return this.agent(name);
  }

  /** What the server has said so far. */
  serverSaid(): string {
    return existsSync(this.serverLog) ? readFileSync(this.serverLog, 'utf8') : '';
  }

  /** How many actions really happened: the fake adds a line for each. */
  actions(): number {
    return existsSync(this.ran) ? readFileSync(this.ran, 'utf8').trim().split('\n').length : 0;
  }

  /** The command lines a session was started with, one per process. */
  argLines(session: string): string[][] {
    const path = join(this.logs, `${session}.args`);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
  }
}
