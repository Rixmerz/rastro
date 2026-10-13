// A real flood: coordinator in this process, two worker daemons with real
// Chromium, against the fixture site under /flood/.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { call } from '../src/daemon/client.ts';
import { floodDir } from '../src/core/paths.ts';
import { runFlood, workerName, type FloodOptions } from '../src/flood/coordinator.ts';
import { findEndpoint, formatEndpoint, type FloodMap } from '../src/flood/map.ts';
import { startFixtureServer, type FixtureServer } from './fixtures/server.ts';

let home: string;
let runtime: string;
let server: FixtureServer;
let map: FloodMap;

function options(name: string, overrides: Partial<FloodOptions> = {}): FloodOptions {
  return {
    name,
    url: `${server.origin}/flood/`,
    session: `${name}-seed`,
    dir: floodDir(name),
    depth: 3,
    budget: 80,
    timeMs: 150_000,
    workers: 2,
    rate: 20,
    concurrency: 2,
    ignoreRobots: false,
    skip: [],
    include: [],
    fill: true,
    mdBudget: 4000,
    quietMs: 250,
    actionTimeoutMs: 4_000,
    ...overrides,
  };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'rastro-flood-home-'));
  runtime = mkdtempSync(join(tmpdir(), 'rastro-flood-run-'));
  process.env.RASTRO_HOME = home;
  process.env.XDG_RUNTIME_DIR = runtime;
  delete process.env.RASTRO_ENGINE_MODULE;
  server = await startFixtureServer();
  // The user logs in once, in the seed session; workers start with its cookies.
  await call('shop-seed', 'open', { url: `${server.origin}/flood/` });
  await call('shop-seed', 'eval', { expr: "document.cookie = 'seeded=1; path=/'" });
  map = await runFlood(options('shop'), { call });
}, 180_000);

afterAll(async () => {
  for (const s of [workerName('shop', 1), workerName('shop', 2), 'shop-seed', workerName('cli', 1), workerName('bg', 1)]) {
    await call(s, 'close', {}, { spawn: false }).catch(() => undefined);
  }
  await server.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(runtime, { recursive: true, force: true });
});

function endpoint(method: string, path: string) {
  return map.endpoints.find((e) => e.method === method && e.path === path);
}

describe('flood', () => {
  test('maps every page, every call, and finishes', () => {
    expect(['done', 'limit']).toContain(map.status);
    const templates = map.states.map((s) => s.urlTemplate.replace(/^[^/]+/, ''));
    expect(templates).toEqual(expect.arrayContaining(['/flood/', '/flood/products', '/flood/contact', '/flood/products/{id}']));
    expect(endpoint('GET', '/flood/api/me')).toBeDefined();
    expect(endpoint('GET', '/flood/api/offers')).toBeDefined();
    expect(endpoint('GET', '/flood/api/offers/claim?id=')).toBeDefined();
    expect(endpoint('GET', '/flood/api/products?sort=')).toBeDefined();
    expect(endpoint('GET', '/flood/api/orders/{id}')).toBeDefined();
  });

  test('workers start with the seed session\'s cookies', async () => {
    expect(map.seed.seeded).toBe(true);
    const me = endpoint('GET', '/flood/api/me')!.samples[0]!;
    const res = await call(me.worker, 'request', { id: me.request, body: true });
    expect(res.text).toContain('seeded');
  });

  test('a blocked write keeps its masked body, also in effects', async () => {
    const sample = endpoint('POST', '/flood/api/contact')!.samples[0]!;
    expect(sample.body).toContain('flood@example.test');
    const res = await call(sample.worker, 'effects', { action: sample.action });
    expect(res.text).toMatch(/POST .*\/flood\/api\/contact · body .*"email"/);
  });

  test('a form is found, not sent', () => {
    const contact = endpoint('POST', '/flood/api/contact');
    expect(contact?.blockedWrite).toBe(true);
    expect(contact?.fields).toEqual(expect.arrayContaining(['email', 'message']));
    expect(server.hits().some((h) => h.method === 'POST' && h.path === '/flood/api/contact')).toBe(false);
  });

  test('logout is listed but never clicked; robots and external links are respected', () => {
    expect(server.hits().some((h) => h.path === '/flood/logout')).toBe(false);
    expect(server.hits().some((h) => h.path === '/flood/private')).toBe(false);
    const home = map.states[0]!;
    const outcome = (name: string) => home.elements.find((e) => e.name === name)?.outcome;
    expect(outcome('Cerrar sesión')).toBe('skipped:denylist');
    expect(outcome('Privado')).toBe('skipped:robots');
    expect(outcome('Docs')).toBe('external');
  });

  test('thirty product links collapse into one template', () => {
    const productPages = server.hits().filter((h) => /^\/flood\/products\/\d+$/.test(h.path));
    expect(new Set(productPages.map((h) => h.path)).size).toBe(1);
    const products = map.states.find((s) => s.urlTemplate.endsWith('/flood/products'))!;
    expect(products.elements.filter((e) => e.outcome === 'skipped:duplicate-link').length).toBeGreaterThanOrEqual(29);
  });

  test('an SPA dialog is its own state, reached by its path', () => {
    const dialog = map.states.find((s) => s.via === 'Ver ofertas');
    expect(dialog).toBeDefined();
    expect(dialog!.path.keys.length).toBe(1);
    // Claiming fetches but leaves the screen as it was.
    expect(dialog!.elements.find((e) => e.name === 'Reclamar oferta')?.outcome).toBe('same');
  });

  test('every endpoint can be drilled into from its worker session', async () => {
    const orders = endpoint('GET', '/flood/api/orders/{id}')!;
    const sample = orders.samples[0]!;
    const res = await call(sample.worker, 'request', { id: sample.request, curl: true });
    expect(res.text).toContain('/flood/api/orders/');
    expect(formatEndpoint(map, findEndpoint(map, orders.id)!)).toContain(`rastro -s ${sample.worker} request ${sample.request} --curl`);
  });

  test('map.md is written and quotes page text', () => {
    const md = readFileSync(join(floodDir('shop'), 'map.md'), 'utf8');
    expect(md).toContain('## Writes');
    expect(md).toContain('POST');
    expect(md).toContain('«Enviar»');
  });
});

const BIN = new URL('../bin/rastro.js', import.meta.url).pathname;

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

describe('flood CLI', () => {
  const limits = ['--workers', '1', '--depth', '1', '--rate', '20', '--quiet-ms', '250', '--timeout-ms', '4000'];

  test('foreground run, then show and status', async () => {
    const run = await runCli(['-s', 'cli-seed', 'flood', `${server.origin}/flood/`, '--name', 'cli', ...limits, '--json']);
    expect(run.code).toBe(0);
    const data = (JSON.parse(run.stdout) as { data: { status: string; md: string } }).data;
    expect(data.status).toBe('limit');
    const show = await runCli(['flood', 'show', 'cli']);
    expect(show.stdout).toContain('## Reads');
    const one = await runCli(['flood', 'show', 'cli', 'S1']);
    expect(one.stdout).toMatch(/^S1 http:\/\/127\.0\.0\.1:\d+\/flood\/ «Tienda»/);
    const status = await runCli(['flood', 'status', 'cli']);
    expect(status.stdout).toMatch(/^cli: limit \(depth\)/);
  }, 120_000);

  test('--detach runs in the background until it is done', async () => {
    const start = await runCli(['flood', `${server.origin}/flood/`, '--name', 'bg', ...limits, '--detach']);
    expect(start.code).toBe(0);
    expect(start.stdout).toContain('running in the background');
    const deadline = Date.now() + 90_000;
    let status = '';
    while (Date.now() < deadline) {
      status = (await runCli(['flood', 'status', 'bg'])).stdout;
      if (status !== '' && !status.startsWith('bg: running')) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(status).toMatch(/^bg: limit/);
    expect((await runCli(['flood', 'list'])).stdout).toContain('bg: limit');
  }, 120_000);

  test('usage errors exit 2', async () => {
    expect((await runCli(['flood', 'ftp://x'])).code).toBe(2);
    expect((await runCli(['flood', 'show'])).code).toBe(2);
  });
});
