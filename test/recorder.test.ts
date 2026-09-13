// Recorder-level regression tests for R3 (pending requests wedged by a
// closed tab), R5 (early-sighting of popup traffic), R6 (recurring
// requests must not extend the quiet window) and R19 (Cookie/Set-Cookie
// headers only Chrome's *ExtraInfo events carry). Uses a bare
// `chromium.launch()` + a tiny local HTTP server rather than `Session`,
// since `Recorder` only ever touches `Page`/`BrowserContext`/`CDPSession`.

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { Recorder } from '../src/engine/recorder.ts';
import { TraceStore } from '../src/store/db.ts';
import { BodyStore } from '../src/store/bodies.ts';

let server: Server;
let origin: string;
let home: string;
let browser: Browser;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'rastro-recorder-'));

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>ok</h1>');
      return;
    }
    if (url.pathname === '/hang-opener') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<button id=b>go</button><script>document.getElementById("b").onclick=()=>fetch("/hang").catch(()=>{})</script>');
      return;
    }
    if (url.pathname === '/hang') {
      // never responds: simulates a request in-flight when its tab closes.
      return;
    }
    if (url.pathname === '/opener') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<button id=b>go</button><script>document.getElementById("b").addEventListener("click",()=>window.open("/a"))</script>');
      return;
    }
    if (url.pathname === '/a') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<script>fetch("/b")</script><h1>a</h1>');
      return;
    }
    if (url.pathname === '/b') {
      res.writeHead(200);
      res.end('b-ok');
      return;
    }
    if (url.pathname === '/cookie-setter') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'session=abc123; Path=/' });
      res.end('<button id=b>go</button><script>document.getElementById("b").onclick=()=>fetch("/cookie-check",{credentials:"same-origin"})</script>');
      return;
    }
    if (url.pathname === '/cookie-check') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  origin = `http://127.0.0.1:${port}`;

  browser = await chromium.launch({ executablePath: process.env.RASTRO_CHROMIUM ?? '/usr/bin/chromium', headless: true });
}, 30000);

afterAll(async () => {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

let seq = 0;
function makeRecorder(): { recorder: Recorder; store: TraceStore } {
  seq += 1;
  const dir = join(home, `s${seq}`);
  const store = TraceStore.open(join(dir, 'trace.db'));
  const bodies = new BodyStore(join(dir, 'bodies'));
  const recorder = new Recorder(store, bodies, () => Date.now());
  return { recorder, store };
}

async function freshContext(): Promise<BrowserContext> {
  return browser.newContext();
}

describe('Recorder.detachTab (R3)', () => {
  test('a request left pending by a tab that closes is cleared, not stuck forever', async () => {
    const { recorder } = makeRecorder();
    const context = await freshContext();
    try {
      const page = await context.newPage();
      await recorder.attach(page, 't1');
      await page.goto(`${origin}/hang-opener`);

      await page.click('#b');
      // Give `Network.requestWillBeSent` for the hanging fetch a moment to land.
      await expectEventually(() => recorder.pending() > 0, 'the hanging request to register as pending');

      await page.close();
      recorder.detachTab('t1');

      expect(recorder.pending()).toBe(0);
    } finally {
      await context.close();
    }
  });
});

describe('Recorder.noteEarlySight (R5)', () => {
  test('a popup fetched-in-script request is recorded even though the CDP session attaches too late', async () => {
    const { recorder, store } = makeRecorder();
    const context = await freshContext();
    try {
      // No CDP attach on the popup at all: this reproduces the worst case
      // (recorder.attach() not having won the race yet) instead of relying
      // on timing to prove it.
      const page = await context.newPage();
      await recorder.attach(page, 'opener');
      await page.goto(`${origin}/opener`);

      const popupPromise = context.waitForEvent('page');
      await page.click('#b');
      const popup = await popupPromise;

      // Simulate Session's context-wide route seeing the popup's traffic
      // before recorder.attach() ever gets to it.
      recorder.noteEarlySight('popup', 'GET', `${origin}/a`, 'document');
      recorder.noteEarlySight('popup', 'GET', `${origin}/b`, 'xhr');

      await popup.waitForLoadState('load');

      const events = store.events({ types: ['request'] });
      const urls = events.map((e) => e.data.url);
      expect(urls).toContain(`${origin}/a`);
      expect(urls).toContain(`${origin}/b`);
    } finally {
      await context.close();
    }
  });

  test('the same sighting is not recorded twice', () => {
    const { recorder, store } = makeRecorder();
    recorder.noteEarlySight('t1', 'GET', 'http://x/y', 'fetch');
    recorder.noteEarlySight('t1', 'GET', 'http://x/y', 'fetch');
    const events = store.events({ types: ['request'] });
    expect(events).toHaveLength(1);
  });
});

describe('Recorder R6: recurring requests do not extend the quiet window', () => {
  test('a same-template request repeating on a steady tick stops being counted as pending/activity', async () => {
    const { recorder } = makeRecorder();
    const context = await freshContext();
    try {
      const page = await context.newPage();
      await recorder.attach(page, 't1');
      await page.goto(origin);

      // Five fast, evenly-spaced same-template requests, like a `setTimeout`
      // poll loop the initiator stack doesn't literally spell "setInterval".
      for (let i = 0; i < 5; i++) {
        await page.evaluate((n: number) => fetch(`/poll?t=${n}`).catch(() => {}), i);
        await new Promise((r) => setTimeout(r, 40));
      }
      await expectEventually(() => recorder.pending() === 0, 'the polling requests to drain');

      const before = recorder.lastActivity();
      await new Promise((r) => setTimeout(r, 60));
      await page.evaluate((n: number) => fetch(`/poll?t=${n}`).catch(() => {}), 99);
      await new Promise((r) => setTimeout(r, 150));

      // The 6th occurrence of the same template is now recognized as
      // periodic background noise: it must not have bumped `lastActivity`.
      expect(recorder.lastActivity()).toBe(before);
    } finally {
      await context.close();
    }
  });
});

describe('Recorder R19: Cookie/Set-Cookie land on the request/response record', () => {
  test('a request carrying a Cookie header has it recorded', async () => {
    const { recorder, store } = makeRecorder();
    const context = await freshContext();
    try {
      const page = await context.newPage();
      await recorder.attach(page, 't1');
      await page.goto(`${origin}/cookie-setter`);
      // The response above sets the cookie; the click's fetch sends it back.
      await page.click('#b');
      await expectEventually(() => recorder.pending() === 0, 'the cookie-check fetch to finish');

      const requests = store.requests();
      const cookieCheck = requests.find((r) => r.url.endsWith('/cookie-check'));
      expect(cookieCheck).toBeDefined();
      const headerKeys = Object.keys(cookieCheck!.requestHeaders).map((k) => k.toLowerCase());
      expect(headerKeys).toContain('cookie');
      expect(cookieCheck!.requestHeaders[Object.keys(cookieCheck!.requestHeaders).find((k) => k.toLowerCase() === 'cookie')!]).toContain(
        'session=abc123',
      );

      const setter = requests.find((r) => r.url.endsWith('/cookie-setter'));
      expect(setter).toBeDefined();
      const respHeaderKeys = Object.keys(setter!.responseHeaders ?? {}).map((k) => k.toLowerCase());
      expect(respHeaderKeys).toContain('set-cookie');
    } finally {
      await context.close();
    }
  });
});

/** Polls a condition until true, no fixed sleep-and-hope: used instead of a
 * bare timeout wherever a CDP event's arrival time isn't otherwise
 * observable from the test. */
async function expectEventually(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
