// Session-level regression tests for R1 (a hook/dialog/download failure must
// never surface as an unhandled rejection or crash the browser session), R2
// (dead/relaunch), S6 (redirect write guard), S10 (host allowlist matching)
// and S12 (downloads saved 0600).

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Session, hostAllowed, type SessionHooks } from '../src/engine/session.ts';
import { ensureSessionDirs, sessionPaths, type SessionPaths } from '../src/core/paths.ts';

describe('hostAllowed (S10)', () => {
  test('an empty allowlist entry never matches anything', () => {
    expect(hostAllowed('evil.com', [''])).toBe(false);
    expect(hostAllowed('', [''])).toBe(false);
    // The actual failure mode this guards: naively building the suffix as
    // `` `.${allowed}` `` with `allowed === ''` produces a literal `.`, and a
    // trailing-dot *host* (`evil.com.`) ends with exactly that — so an empty
    // allowlist entry silently allowed any FQDN written with a trailing dot.
    expect(hostAllowed('evil.com.', [''])).toBe(false);
  });

  test('* allows any host', () => {
    expect(hostAllowed('anything.example', ['*'])).toBe(true);
  });

  test('exact and subdomain matches, case-insensitive', () => {
    expect(hostAllowed('EXAMPLE.com', ['example.com'])).toBe(true);
    expect(hostAllowed('api.example.com', ['example.com'])).toBe(true);
    expect(hostAllowed('notexample.com', ['example.com'])).toBe(false);
  });

  test('a trailing-dot FQDN of an allowed host matches after normalization', () => {
    // `evil.com.` is the same host as `evil.com` in DNS; a bare empty string
    // is not a host at all and must never match (see the test above) — the
    // two are deliberately different outcomes, not the same rule twice.
    expect(hostAllowed('evil.com.', ['evil.com'])).toBe(true);
  });
});

let home: string;
let server: Server;
let altServer: Server;
let origin: string;
let altOrigin: string;
let altHits: string[];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'rastro-session-'));

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>ok</h1>');
      return;
    }
    if (url.pathname === '/popup') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<button id=b>go</button><script>document.getElementById("b").addEventListener("click",()=>window.open("/self-close"))</script>',
      );
      return;
    }
    if (url.pathname === '/self-close') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<script>window.close()</script>');
      return;
    }
    if (url.pathname === '/download') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<a id=a href="/file.txt" download>dl</a>');
      return;
    }
    if (url.pathname === '/file.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello world');
      return;
    }
    if (url.pathname === '/redirect-form') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<form id=f method=post action="/start"><input name=x value=1></form><script>document.getElementById("f").submit()</script>',
      );
      return;
    }
    if (url.pathname === '/start') {
      res.writeHead(307, { location: `${altOrigin}/other` });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  altHits = [];
  altServer = createServer((req, res) => {
    altHits.push(`${req.method} ${req.url}`);
    res.writeHead(200);
    res.end('ok');
  });
  // A genuinely different *host* from `origin` (127.0.0.1), not just a
  // different port — `hostAllowed` matches on hostname only, same as a real
  // allowlist entry would (127.0.0.0/8 all route to loopback on Linux).
  await new Promise<void>((resolve) => altServer.listen(0, '127.0.0.2', resolve));
  const altAddr = altServer.address();
  altOrigin = `http://127.0.0.2:${typeof altAddr === 'object' && altAddr ? altAddr.port : 0}`;
}, 30000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => altServer.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

let seq = 0;
function makePaths(): SessionPaths {
  seq += 1;
  process.env.RASTRO_HOME = home;
  const paths = sessionPaths(`s${seq}-${Date.now()}`);
  ensureSessionDirs(paths);
  return paths;
}

function noopHooks(overrides: Partial<SessionHooks> = {}): SessionHooks {
  return {
    onPageCreated: () => {},
    onTabOpen: () => {},
    onTabClose: () => {},
    onDialog: () => {},
    onDownload: () => {},
    onBlockedWrite: () => {},
    onCrash: () => {},
    ...overrides,
  };
}

let rejections: unknown[] = [];
function onRejection(err: unknown): void {
  rejections.push(err);
}

beforeEach(() => {
  rejections = [];
  process.on('unhandledRejection', onRejection);
});

afterEach(() => {
  process.off('unhandledRejection', onRejection);
});

describe('Session dead/relaunch (R2)', () => {
  test('an unexpected context close marks the session dead, and relaunch recovers it', async () => {
    const paths = makePaths();
    let crashed = 0;
    const session = await Session.launch(paths, {}, noopHooks({ onCrash: () => { crashed += 1; } }));
    expect(session.dead).toBe(false);

    // Simulate the context closing on its own (e.g. the browser process
    // died) rather than through our own `close()`.
    await session.context.close();
    await expectEventually(() => session.dead, 'the session to notice the context closed');
    expect(crashed).toBe(1);

    await session.relaunch();
    expect(session.dead).toBe(false);

    const page = session.activePage();
    await page.goto(origin);
    expect(page.url()).toBe(`${origin}/`);

    await session.close();
    expect(rejections).toEqual([]);
  }, 20000);
});

describe('Session robustness against a throwing hook / a self-closing popup (R1)', () => {
  test('a page-created hook that throws does not crash the session', async () => {
    const paths = makePaths();
    const session = await Session.launch(paths, {}, noopHooks({
      onPageCreated: () => {
        throw new Error('boom from a hook');
      },
    }));
    const page = session.activePage();
    await page.goto(origin);
    expect(page.url()).toBe(`${origin}/`);
    await session.close();
    expect(rejections).toEqual([]);
  }, 20000);

  test('a popup that closes itself immediately does not crash the session or leak its tab', async () => {
    const paths = makePaths();
    const session = await Session.launch(paths, {}, noopHooks());
    const page = session.activePage();
    await page.goto(`${origin}/popup`);

    const [popup] = await Promise.all([session.context.waitForEvent('page'), page.click('#b')]);
    await popup.waitForEvent('close').catch(() => undefined);
    await expectEventually(() => session.allTabs().length === 1, 'the self-closed popup tab to be reaped');

    // The session is still fully usable afterwards.
    await page.goto(origin);
    expect(page.url()).toBe(`${origin}/`);

    await session.close();
    expect(rejections).toEqual([]);
  }, 20000);
});

describe('Session downloads (S12)', () => {
  test('a downloaded file is saved 0600, like everything else the session writes', async () => {
    const paths = makePaths();
    let resolveDownload!: (info: { path: string }) => void;
    const gotDownload = new Promise<{ path: string }>((resolve) => {
      resolveDownload = resolve;
    });
    const session = await Session.launch(
      paths,
      {},
      noopHooks({ onDownload: (_id, _name, path) => resolveDownload({ path }) }),
    );
    const page = session.activePage();
    await page.goto(`${origin}/download`);
    await page.click('#a');

    const { path } = await gotDownload;
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);

    await session.close();
    expect(rejections).toEqual([]);
  }, 20000);
});

describe('Session write guard on a cross-host redirect (S6)', () => {
  test('a POST allowed on the first host is blocked when a 307 redirects it to a disallowed host', async () => {
    const paths = makePaths();
    const blocked: { method: string; url: string; host: string }[] = [];
    const session = await Session.launch(
      paths,
      { allowWrite: [new URL(origin).hostname] },
      noopHooks({ onBlockedWrite: (_id, method, url, host) => blocked.push({ method, url, host }) }),
    );
    const page = session.activePage();
    await page.goto(`${origin}/redirect-form`).catch(() => undefined);
    await expectEventually(() => blocked.length > 0, 'the cross-host redirect leg to be blocked');

    expect(blocked[0]?.method).toBe('POST');
    expect(blocked[0]?.host).toBe(new URL(altOrigin).hostname);
    expect(altHits).toEqual([]);

    await session.close();
    expect(rejections).toEqual([]);
  }, 20000);
});

/** Polls a condition until true instead of a fixed sleep-and-hope, for
 * anything whose completion isn't otherwise awaitable from the test. */
async function expectEventually(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
