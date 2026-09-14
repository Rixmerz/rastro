// End-to-end coverage of the real path: CLI process -> daemon -> real
// (chromium) engine, against the fixture server. Everything in cli.test.ts
// and daemon.test.ts swaps in a fake engine via RASTRO_ENGINE_MODULE, which
// is exactly the seam that let two integration bugs ship (an unbound engine
// method call in the daemon, and a CLI/engine param name drift). This file
// never sets that env var.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { call } from '../src/daemon/client.ts';
import { startFixtureServer } from './fixtures/server.ts';
import type { FixtureServer } from './fixtures/server.ts';

const BIN = new URL('../bin/rastro.js', import.meta.url).pathname;

interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ stdout, stderr, code }));
  });
}

/** Uses `view --find --json` to resolve a ref by visible name, regardless of
 * whether the plain-text view would have collapsed that region. */
async function findRef(session: string, name: string): Promise<string> {
  const { stdout, code } = await runCli(['-s', session, 'view', '--find', name, '--json']);
  expect(code).toBe(0);
  const data = JSON.parse(stdout) as { regions: { items: { ref: string; name: string }[] }[] };
  const item = data.regions.flatMap((r) => r.items)[0];
  if (!item) throw new Error(`no item named "${name}" found; view --find --json returned:\n${stdout}`);
  return item.ref;
}

function actionIdOf(stdout: string): number {
  const match = /^#(\d+)/.exec(stdout.trim());
  if (!match) throw new Error(`no action id in output: ${stdout}`);
  return Number(match[1]);
}

let home: string;
let runtime: string;
let server: FixtureServer;
const openedSessions: string[] = [];

function track(name: string): string {
  const session = `e2e-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  openedSessions.push(session);
  return session;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'rastro-e2e-home-'));
  runtime = mkdtempSync(join(tmpdir(), 'rastro-e2e-run-'));
  process.env.RASTRO_HOME = home;
  process.env.XDG_RUNTIME_DIR = runtime;
  delete process.env.RASTRO_ENGINE_MODULE;
  server = await startFixtureServer();
}, 60000);

afterAll(async () => {
  for (const session of openedSessions) {
    try {
      await call(session, 'close', {}, { spawn: false, timeoutMs: 5000 });
    } catch {
      // Already gone — fine, this is best-effort cleanup.
    }
  }
  await server.close();
  delete process.env.RASTRO_HOME;
  delete process.env.XDG_RUNTIME_DIR;
  rmSync(home, { recursive: true, force: true });
  rmSync(runtime, { recursive: true, force: true });
}, 60000);

describe('rastro e2e: CLI -> daemon -> real engine', () => {
  const session = track('main');
  let clickActionId: number;
  let loginRequestId: string;
  let staleEmailRef: string;

  test(
    'open navigates and prints the action summary',
    async () => {
      const { stdout, code } = await runCli([
        '-s',
        session,
        'open',
        `${server.origin}/login`,
        '--allow-write',
        '127.0.0.1',
      ]);
      expect(code).toBe(0);
      expect(stdout).toMatch(/^#\d+ → /);
    },
    60000,
  );

  test(
    'view shows the login form within the token budget',
    async () => {
      const { stdout, code } = await runCli(['-s', session, 'view']);
      expect(code).toBe(0);
      expect(stdout).toMatch(/\[e[^\]]*\]/);
      expect(stdout).toContain('textbox «Email»');
      expect(stdout).toContain('button «Entrar»');
      expect(Math.ceil(stdout.length / 4)).toBeLessThanOrEqual(400);
    },
    60000,
  );

  test(
    'fill + click logs in and reports the effect summary',
    async () => {
      const emailRef = await findRef(session, 'Email');
      staleEmailRef = emailRef;
      const passwordRef = await findRef(session, 'Contraseña');
      const entrarRef = await findRef(session, 'Entrar');

      const fillEmail = await runCli(['-s', session, 'fill', emailRef, 'test@example.com']);
      expect(fillEmail.code).toBe(0);

      const fillPassword = await runCli(['-s', session, 'fill', passwordRef, 'hunter22']);
      expect(fillPassword.code).toBe(0);

      const clickResult = await runCli(['-s', session, 'click', entrarRef]);
      expect(clickResult.code).toBe(0);
      expect(clickResult.stdout).toMatch(/→ \/panel · \d+ req \(1× 500\)/);
      expect(clickResult.stdout).toContain('+2 cookies');
      expect(clickResult.stdout).toContain('console: 1 error');
      clickActionId = actionIdOf(clickResult.stdout);
    },
    60000,
  );

  test(
    'history masks the password fill',
    async () => {
      const { stdout, code } = await runCli(['-s', session, 'history']);
      expect(code).toBe(0);
      expect(stdout).not.toContain('hunter22');
      expect(stdout).toContain('•••');
    },
    60000,
  );

  test(
    'effects on the click lists the POST /login request',
    async () => {
      const text = await runCli(['-s', session, 'effects', String(clickActionId)]);
      expect(text.code).toBe(0);
      expect(text.stdout).toContain('POST /login');

      const json = await runCli(['-s', session, 'effects', String(clickActionId), '--json']);
      expect(json.code).toBe(0);
      const data = JSON.parse(json.stdout) as { requests: { id: string; method: string; url: string }[] };
      const loginReq = data.requests.find((r) => r.method === 'POST' && new URL(r.url).pathname === '/login');
      expect(loginReq).toBeDefined();
      loginRequestId = loginReq!.id;
    },
    60000,
  );

  test(
    'request --curl never leaks the password',
    async () => {
      const curl = await runCli(['-s', session, 'request', loginRequestId, '--curl']);
      expect(curl.code).toBe(0);
      expect(curl.stdout).toContain('curl');
      expect(curl.stdout).not.toContain('hunter22');

      const body = await runCli(['-s', session, 'request', loginRequestId, '--body']);
      expect(body.code).toBe(0);
    },
    60000,
  );

  test(
    'trace shows the action closing',
    async () => {
      const { stdout, code } = await runCli(['-s', session, 'trace', '--action', String(clickActionId)]);
      expect(code).toBe(0);
      expect(stdout).toContain('closed');
    },
    60000,
  );

  test(
    'snapshot --before still shows the Entrar button',
    async () => {
      const { stdout, code } = await runCli(['-s', session, 'snapshot', String(clickActionId), '--before']);
      expect(code).toBe(0);
      expect(stdout).toContain('«Entrar»');
    },
    60000,
  );

  test(
    'console lists the panel.js cart error',
    async () => {
      const { stdout, code } = await runCli(['-s', session, 'console']);
      expect(code).toBe(0);
      expect(stdout).toContain('Cannot read cart');
    },
    60000,
  );

  test(
    'cookies are masked by default and revealed with --reveal',
    async () => {
      const masked = await runCli(['-s', session, 'cookies']);
      expect(masked.code).toBe(0);
      expect(masked.stdout).not.toContain('abc123');

      const revealed = await runCli(['-s', session, 'cookies', '--reveal']);
      expect(revealed.code).toBe(0);
      expect(revealed.stdout).toContain('abc123');
    },
    60000,
  );

  test(
    'export har and export perfetto write files that exist',
    async () => {
      const har = await runCli(['-s', session, 'export', 'har']);
      expect(har.code).toBe(0);
      const harPath = har.stdout.trim();
      expect(existsSync(harPath)).toBe(true);
      const harContents = readFileSync(harPath, 'utf8');
      expect(harContents).not.toContain('hunter22');
      const parsed = JSON.parse(harContents) as { log: { entries: unknown[] } };
      expect(parsed.log.entries.length).toBeGreaterThan(0);

      const perfetto = await runCli(['-s', session, 'export', 'perfetto']);
      expect(perfetto.code).toBe(0);
      expect(existsSync(perfetto.stdout.trim())).toBe(true);
    },
    60000,
  );

  test(
    '--json click prints a single JSON object with an action number',
    async () => {
      const productoRef = await findRef(session, 'Producto 1');
      const { stdout, code } = await runCli(['-s', session, 'click', productoRef, '--json']);
      expect(code).toBe(0);
      expect(stdout.trim().split('\n')).toHaveLength(1);
      const data = JSON.parse(stdout) as { action: number };
      expect(typeof data.action).toBe('number');
    },
    60000,
  );

  test(
    'a stale ref from a page we navigated away from fails with a hint',
    async () => {
      const goto = await runCli(['-s', session, 'goto', `${server.origin}/help`]);
      expect(goto.code).toBe(0);

      const click = await runCli(['-s', session, 'click', staleEmailRef]);
      expect(click.code).toBe(1);
      expect(click.stderr).toContain('not found');
      expect(click.stderr).toContain('hint: run rastro view');
    },
    60000,
  );
});

describe('write guard blocks a cross-origin fetch', () => {
  test(
    'clicking Comprar reports a blocked write and never reaches the server',
    async () => {
      const session = track('shop');
      server.resetHits();

      const open = await runCli(['-s', session, 'open', `${server.origin}/shop`, '--allow-write', '127.0.0.1']);
      expect(open.code).toBe(0);

      const comprarRef = await findRef(session, 'Comprar');
      const click = await runCli(['-s', session, 'click', comprarRef]);
      expect(click.code).toBe(0);
      expect(click.stdout).toContain('1 write blocked (localhost)');
      expect(server.hits().some((h) => h.method === 'POST' && h.path === '/api/buy')).toBe(false);
    },
    60000,
  );
});

describe('daemon restart keeps one continuous timeline', () => {
  test(
    'history and attribution survive a close + reopen of the same session',
    async () => {
      const session = track('restart');

      const openLogin = await runCli(['-s', session, 'open', `${server.origin}/login`]);
      expect(openLogin.code).toBe(0);
      const action1 = actionIdOf(openLogin.stdout);

      const close = await runCli(['-s', session, 'close']);
      expect(close.code).toBe(0);

      const openTracking = await runCli(['-s', session, 'open', `${server.origin}/tracking`]);
      expect(openTracking.code).toBe(0);
      const action2 = actionIdOf(openTracking.stdout);
      expect(action2).toBeGreaterThan(action1);

      const buscarRef = await findRef(session, 'Buscar');
      const click = await runCli(['-s', session, 'click', buscarRef]);
      expect(click.code).toBe(0);
      const action3 = actionIdOf(click.stdout);
      expect(action3).toBeGreaterThan(action2);

      const effectsJson = await runCli(['-s', session, 'effects', String(action3), '--json']);
      expect(effectsJson.code).toBe(0);
      const data = JSON.parse(effectsJson.stdout) as { requests: { url: string }[] };
      const paths = data.requests.map((r) => new URL(r.url).pathname);
      expect(paths).toContain('/api/search');
      expect(paths.some((p) => p === '/login' || p === '/panel')).toBe(false);

      const history = await runCli(['-s', session, 'history']);
      expect(history.code).toBe(0);
      expect(history.stdout).toContain(`#${action1} `);
      expect(history.stdout).toContain(`#${action2} `);
      expect(history.stdout).toContain(`#${action3} `);
    },
    60000,
  );
});

describe('status reflects daemon liveness', () => {
  test(
    'status shows the session running, then stopped after close',
    async () => {
      const session = track('status');
      const open = await runCli(['-s', session, 'open']);
      expect(open.code).toBe(0);

      const before = await runCli(['-s', session, 'status']);
      expect(before.code).toBe(0);
      expect(before.stdout).toContain(`${session}: running`);

      const close = await runCli(['-s', session, 'close']);
      expect(close.code).toBe(0);

      const after = await runCli(['-s', session, 'status']);
      expect(after.code).toBe(0);
      expect(after.stdout).toContain(`${session}: stopped`);
      expect(after.stdout).not.toContain(`${session}: running`);
    },
    60000,
  );
});

describe('error exit codes', () => {
  test(
    'an unknown command exits 2',
    async () => {
      const { code, stderr } = await runCli(['-s', track('unknown-cmd'), 'nope-not-a-command']);
      expect(code).toBe(2);
      expect(stderr).toContain('error:');
    },
    60000,
  );

  test(
    'effects on a missing action exits 1 with an error',
    async () => {
      const session = track('misc');
      const { stdout, code } = await runCli(['-s', session, 'effects', '9999']);
      expect(stdout).toBe('');
      expect(code).toBe(1);
    },
    60000,
  );
});

describe('large eval output survives instead of being cut at 1 KB', () => {
  test(
    'a 10 KB result spills to a file rather than losing its tail',
    async () => {
      const session = track('eval-big');
      const opened = await runCli(['-s', session, 'open', `${server.origin}/login`]);
      expect(opened.code).toBe(0);

      // The engine used to slice(0, 1024) here, so an extraction that returned
      // more than that came back silently truncated with no marker and no file.
      const { stdout, code } = await runCli(['-s', session, 'eval', '"x".repeat(10000)']);
      expect(code).toBe(0);

      const spillPath = /written to (\S+)/.exec(stdout)?.[1];
      if (!spillPath) throw new Error(`expected a spill file, got: ${stdout}`);
      expect(readFileSync(spillPath, 'utf8')).toContain('x'.repeat(10000));
    },
    60000,
  );
});

describe('request --body reaches --json callers too', () => {
  test(
    'the body is in data, not only in the text form',
    async () => {
      const session = track('req-json');
      const opened = await runCli(['-s', session, 'open', `${server.origin}/panel`, '--allow-write', '127.0.0.1']);
      expect(opened.code).toBe(0);

      const text = await runCli(['-s', session, 'request', 'r1', '--body']);
      expect(text.stdout).toContain('--- body');

      // --json used to return headers and timing only: a caller asking for the
      // body in machine-readable form got everything except the body.
      const { stdout, code } = await runCli(['-s', session, 'request', 'r1', '--body', '--json']);
      expect(code).toBe(0);
      expect(Object.keys(JSON.parse(stdout) as Record<string, unknown>)).toContain('body');
    },
    60000,
  );
});
