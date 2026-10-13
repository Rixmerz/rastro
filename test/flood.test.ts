import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { RpcMethod, RpcResult } from '../src/core/types.ts';
import { elementKeys, endpointTemplate, normalizeName, stateHash, urlTemplate } from '../src/flood/state.ts';
import { denyReason, fillerFor, isExternal, parseRobots, registrableDomain } from '../src/flood/policy.ts';
import { Frontier } from '../src/flood/frontier.ts';
import { HostLimiter, parseRetryAfter, type Clock } from '../src/flood/rate.ts';
import { addEndpoint, formatMapMd, newMap, type FloodMap } from '../src/flood/map.ts';
import { runFlood, type FloodOptions } from '../src/flood/coordinator.ts';
import { defaultFloodName, parseDuration, resumeDepth } from '../src/flood/commands.ts';
import type { StepRequest, StepResult } from '../src/flood/protocol.ts';
import type { ViewItem } from '../src/perception/view.ts';

function items(...list: Partial<ViewItem>[]): ViewItem[] {
  return list.map((i, n) => ({ ref: `e${String(n)}`, role: 'button', name: '', region: 'main', ...i }));
}

describe('state identity', () => {
  test('ids in paths and query values do not make new states', () => {
    expect(urlTemplate('https://shop.test/orders/123?page=2#top')).toBe('shop.test/orders/{id}');
    expect(urlTemplate('https://shop.test/u/3f2a9c7e-1b2c-4d5e-8f90-123456789abc/edit')).toBe('shop.test/u/{id}/edit');
    expect(urlTemplate('https://app.test/#/cart/9')).toBe('app.test/#/cart/{id}');
    expect(endpointTemplate('https://api.test/v1/items/42?b=1&a=2&a=3')).toEqual({ host: 'api.test', path: '/v1/items/{id}?a=&b=' });
  });

  test('names fold case, spaces and counters; keys survive a reload', () => {
    expect(normalizeName('  Carrito   (3) ')).toBe('carrito (#)');
    const keys = elementKeys(items({ name: 'Ver' }, { name: 'Ver' }, { role: 'link', name: 'Ver', region: 'nav' }));
    expect(keys.map((k) => k.key)).toEqual(['button|ver|main|0', 'button|ver|main|1', 'link|ver|nav|0']);
  });

  test('related links do not split a state; a new control does', () => {
    const base = elementKeys(items({ name: 'Comprar' }, { role: 'link', name: 'A' }, { role: 'link', name: 'B' }));
    const otherLinks = elementKeys(items({ name: 'Comprar' }, { role: 'link', name: 'C' }, { role: 'link', name: 'D' }));
    const withDialog = elementKeys(items({ name: 'Comprar' }, { role: 'link', name: 'A' }, { role: 'link', name: 'B' }, { name: 'Cerrar', region: 'dialog' }));
    expect(stateHash('https://s.test/p/1', base)).toBe(stateHash('https://s.test/p/2', otherLinks));
    expect(stateHash('https://s.test/p/1', base)).not.toBe(stateHash('https://s.test/p/1', withDialog));
  });
});

describe('policy', () => {
  test('the denylist covers English and Spanish; --include overrides it', () => {
    for (const name of ['Log out', 'Sign out', 'Delete account', 'Pay now', 'Cerrar sesión', 'Eliminar', 'Darse de baja', 'Pagar']) {
      expect(denyReason(name, { skip: [], include: [] })).toBe('denylist');
    }
    expect(denyReason('Ver pedido', { skip: [], include: [] })).toBeUndefined();
    expect(denyReason('Eliminar filtro', { skip: [], include: ['eliminar filtro'] })).toBeUndefined();
    expect(denyReason('Exportar', { skip: ['export'], include: [] })).toBe('skip');
  });

  test('external is another registrable domain or not the web', () => {
    expect(registrableDomain('a.b.shop.com.ar')).toBe('shop.com.ar');
    expect(registrableDomain('api.shop.test:8080')).toBe('shop.test');
    expect(isExternal('https://api.shop.test/x', 'www.shop.test')).toBe(false);
    expect(isExternal('https://example.org/', 'www.shop.test')).toBe(true);
    expect(isExternal('mailto:a@shop.test', 'www.shop.test')).toBe(true);
  });

  test('filler values are neutral and typed', () => {
    expect(fillerFor('email', '')).toBe('flood@example.test');
    expect(fillerFor('text', 'Correo')).toBe('flood@example.test');
    expect(fillerFor('number', '')).toBe('1');
    expect(fillerFor(undefined, 'Mensaje')).toBe('flood');
  });

  test('robots.txt: the * group, longest match wins, wildcards', () => {
    const allow = parseRobots('User-agent: googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nAllow: /private/ok\nDisallow: /*.pdf$\n');
    expect(allow('/private/x')).toBe(false);
    expect(allow('/private/ok/1')).toBe(true);
    expect(allow('/files/a.pdf')).toBe(false);
    expect(allow('/files/a.pdf?x=1')).toBe(true);
    expect(allow('/')).toBe(true);
  });
});

describe('frontier', () => {
  test('serves the shallowest level first, then the preferred state', () => {
    const f = new Frontier();
    f.push({ state: 'S2', key: 'a', depth: 1, retries: 0 });
    f.push({ state: 'S1', key: 'b', depth: 0, retries: 0 });
    f.push({ state: 'S3', key: 'c', depth: 1, retries: 0 });
    expect(f.push({ state: 'S1', key: 'b', depth: 0, retries: 0 })).toBe(false);
    expect(f.pop()?.key).toBe('b');
    expect(f.pop('S3')?.key).toBe('c');
    expect(f.size).toBe(1);
    expect(f.drain().map((i) => i.key)).toEqual(['a']);
  });
});

function fakeClock(): Clock & { sleeps: number[]; t: number } {
  const clock = {
    t: 1_000_000,
    sleeps: [] as number[],
    now: () => clock.t,
    sleep: (ms: number) => {
      clock.sleeps.push(ms);
      clock.t += ms;
      return Promise.resolve();
    },
  };
  return clock;
}

describe('rate', () => {
  test('paces a host and backs off on 429 with Retry-After', async () => {
    const clock = fakeClock();
    const limiter = new HostLimiter({ rate: 2, concurrency: 1, jitter: 0 }, clock);
    await limiter.acquire('a.test');
    limiter.release('a.test');
    await limiter.acquire('a.test');
    limiter.release('a.test');
    expect(clock.sleeps).toEqual([500]);
    limiter.penalize('a.test', 10_000);
    expect(limiter.rateOf('a.test')).toBe(1);
    await limiter.acquire('a.test');
    limiter.release('a.test');
    expect(clock.sleeps.at(-1)).toBe(10_000);
  });

  test('Retry-After as seconds or a date', () => {
    expect(parseRetryAfter('7')).toBe(7000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('map', () => {
  function req(over: Partial<StepRequest>): StepRequest {
    return { id: 'r1', action: 1, phase: 'activate', method: 'GET', url: 'https://s.test/api/a', resourceType: 'fetch', status: 200, ...over };
  }

  test('groups by template, keeps body field names, never values', () => {
    const map = newMap('t', 'https://s.test/', 'default', { depth: 1, budget: 1, timeMs: 1, workers: 1, rate: 1, concurrency: 1, ignoreRobots: false, skip: [], include: [], fill: true }, ['w1']);
    addEndpoint(map, req({ url: 'https://s.test/api/orders/1' }), 'w1', { state: 'S1', key: 'k', name: 'Ver' });
    addEndpoint(map, req({ id: 'r2', url: 'https://s.test/api/orders/2', status: 404 }), 'w1', { state: 'S2', key: 'k', name: 'Ver' });
    addEndpoint(map, req({ id: 'b9', method: 'POST', url: 'https://s.test/api/contact', blocked: true, status: undefined, body: '{"email":"x@y","password":"[MASKED]"}' }), 'w1', { state: 'S3' });
    expect(map.endpoints).toHaveLength(2);
    expect(map.endpoints[0]).toMatchObject({ path: '/api/orders/{id}', statuses: [200, 404], count: 2 });
    expect(map.endpoints[1]).toMatchObject({ method: 'POST', blockedWrite: true, fields: ['email', 'password'] });
    const md = formatMapMd(map);
    expect(md.indexOf('## Writes')).toBeLessThan(md.indexOf('## Reads'));
    expect(md).toContain('blocked write · fields: email, password');
  });

  test('a small budget cuts sections and says how much is left', () => {
    const map = newMap('t', 'https://s.test/', 'default', { depth: 1, budget: 1, timeMs: 1, workers: 1, rate: 1, concurrency: 1, ignoreRobots: false, skip: [], include: [], fill: true }, ['w1']);
    for (let i = 0; i < 200; i++) addEndpoint(map, req({ url: `https://s.test/api/thing${String(i)}` }), 'w1', { state: 'S1' });
    const md = formatMapMd(map, 300);
    expect(md).toMatch(/… \d+ more \(map\.json\)/);
    expect(md.length).toBeLessThan(2500);
  });
});

describe('commands', () => {
  test('durations, resume depth, default names', () => {
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseDuration('250')).toBe(250);
    expect(() => parseDuration('soon')).toThrow();
    expect(resumeDepth(3, '+2')).toBe(5);
    expect(resumeDepth(3, '1')).toBe(1);
    expect(resumeDepth(3, undefined)).toBe(4);
    expect(defaultFloodName('https://www.shop.test:8080/x')).toBe('www-shop-test');
  });
});

// --- the coordinator against a fake site ------------------------------------

interface FakeEl {
  role?: string;
  name: string;
  region?: string;
  url?: string;
  /** Page the activation leads to (by navigation when the page has a url of its own). */
  to?: string;
  requests?: Partial<StepRequest>[];
  blocked?: string;
}
interface FakePage {
  url: string;
  title: string;
  els: FakeEl[];
}

class FakeSite {
  readonly order: string[] = [];
  readonly opens: string[] = [];
  readonly current = new Map<string, string>();
  failOnce = new Set<string>();
  readonly pages: Record<string, FakePage>;
  constructor(pages: Record<string, FakePage>) {
    this.pages = pages;
  }

  private view(id: string) {
    const page = this.pages[id]!;
    const withRefs = elementKeys(items(...page.els.map((e) => ({ role: e.role ?? 'button', name: e.name, region: e.region ?? 'main', ...(e.url ? { url: e.url } : {}) }))));
    return { url: page.url, title: page.title, hash: stateHash(page.url, withRefs), elements: withRefs.map(({ ref: _r, ...rest }) => rest) };
  }

  private pageByUrl(url: string): string {
    const id = Object.keys(this.pages).find((k) => this.pages[k]!.url === url);
    if (!id) throw new Error(`no page ${url}`);
    return id;
  }

  call = async (session: string, method: RpcMethod, params: Record<string, unknown>): Promise<RpcResult> => {
    if (method === 'open') {
      this.opens.push(session);
      return { text: '', data: {} };
    }
    if (method === 'close' || method === 'floodImport') return { text: '', data: {} };
    if (method === 'floodExport') throw new Error('not running');
    if (method !== 'floodStep') throw new Error(`unexpected ${method}`);
    const p = params as { start: string; path: string[]; key?: string; expect?: string };
    const failKey = `${p.key ?? ''}`;
    if (this.failOnce.has(failKey)) {
      this.failOnce.delete(failKey);
      throw new Error('daemon went away');
    }
    let page = this.current.get(session);
    let reused = page !== undefined && p.key !== undefined && this.view(page).hash === p.expect;
    const requests: StepRequest[] = [];
    let action = 0;
    if (!reused) {
      page = this.pageByUrl(p.start);
      for (const key of p.path) {
        const el = this.view(page).elements.findIndex((e) => e.key === key);
        page = this.pages[page]!.els[el]!.to ?? page;
      }
      reused = false;
    }
    const before = this.view(page!);
    const result: StepResult = { reached: true, reused, before, after: before, navigated: false, requests, dialogs: [], tabsOpened: 0, downloads: [], actions: [1] };
    if (p.key !== undefined) {
      this.order.push(`${this.pages[page!]!.title}:${p.key.split('|')[1]!}`);
      const index = before.elements.findIndex((e) => e.key === p.key);
      const el = this.pages[page!]!.els[index]!;
      action += 1;
      for (const r of el.requests ?? []) requests.push({ id: `r${String(requests.length)}`, action, phase: 'activate', method: 'GET', url: `${new URL(before.url).origin}/api`, resourceType: 'fetch', status: 200, ...r });
      result.activated = { action, kind: 'click' };
      if (el.blocked) result.blocked = el.blocked;
      if (el.to) {
        const next = this.pages[el.to]!;
        result.navigated = next.url !== this.pages[page!]!.url;
        page = el.to;
        result.after = this.view(page);
      }
    }
    this.current.set(session, page!);
    return { text: '', data: result };
  };
}

describe('coordinator', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rastro-flood-unit-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function opts(over: Partial<FloodOptions> = {}): FloodOptions {
    return {
      name: 'fake',
      url: 'https://s.test/',
      session: 'seed',
      dir,
      depth: 3,
      budget: 100,
      timeMs: 60_000,
      workers: 3,
      rate: 1000,
      concurrency: 3,
      ignoreRobots: true,
      skip: [],
      include: [],
      fill: true,
      mdBudget: 4000,
      actionTimeoutMs: 1000,
      ...over,
    };
  }

  const tree = (): Record<string, FakePage> => ({
    home: { url: 'https://s.test/', title: 'home', els: [{ role: 'link', name: 'A', url: 'https://s.test/a', to: 'a' }, { role: 'link', name: 'B', url: 'https://s.test/b', to: 'b' }] },
    a: { url: 'https://s.test/a', title: 'a', els: [{ name: 'uno' }, { name: 'dos' }, { role: 'link', name: 'C', url: 'https://s.test/c', to: 'c' }] },
    b: { url: 'https://s.test/b', title: 'b', els: [{ name: 'uno' }, { name: 'dos' }] },
    c: { url: 'https://s.test/c', title: 'c', els: [{ name: 'uno' }, { name: 'dos' }] },
  });

  test('level by level: nothing on C before every item of A and B was taken', async () => {
    const site = new FakeSite(tree());
    const map = await runFlood(opts(), { call: site.call, fetchText: () => Promise.resolve(undefined) });
    expect(map.status).toBe('done');
    const firstC = site.order.findIndex((o) => o.startsWith('c:'));
    const lastAB = Math.max(...site.order.map((o, i) => (/^(a|b):/.test(o) ? i : -1)));
    expect(firstC).toBeGreaterThan(lastAB);
    expect(map.states.map((s) => `${s.id}:${String(s.depth)}`)).toEqual(['S1:0', 'S2:1', 'S3:1', 'S4:2']);
  });

  test('budget reached: what is left is unexplored, and the flood says why', async () => {
    const site = new FakeSite(tree());
    const map = await runFlood(opts({ budget: 3, workers: 3 }), { call: site.call });
    expect(map.status).toBe('limit');
    expect(map.stopReason).toBe('budget');
    expect(map.stats.activations).toBe(3);
    expect(map.unexplored.length).toBeGreaterThan(0);
  });

  test('a depth limit leaves deeper states unvisited, and resume --from goes there', async () => {
    const site = new FakeSite(tree());
    const first = await runFlood(opts({ depth: 1 }), { call: site.call });
    expect(first.status).toBe('limit');
    const c = first.states.find((s) => s.title === 'c')!;
    expect(c.status).toBe('unvisited');
    expect(site.order.some((o) => o.startsWith('c:'))).toBe(false);
    const again = await runFlood(opts({ depth: 2 }), { call: site.call }, { map: first, from: c.parent! });
    expect(again.status).toBe('done');
    expect(again.states.find((s) => s.title === 'c')!.status).toBe('ok');
    expect(site.order.filter((o) => o.startsWith('c:'))).toHaveLength(2);
  });

  test('two bot walls in a row stop the host', async () => {
    const pages = tree();
    pages.a!.els = [{ name: 'uno', blocked: 'captcha' }, { name: 'dos', blocked: 'captcha' }, { name: 'tres' }];
    const site = new FakeSite(pages);
    const clock = fakeClock();
    const map = await runFlood(opts({ workers: 1 }), { call: site.call, clock });
    expect(map.hosts).toEqual([expect.objectContaining({ host: 's.test', status: 'stopped' })]);
    expect(map.status).toBe('limit');
    expect(map.unexplored.length).toBeGreaterThan(0);
    expect(clock.sleeps.some((ms) => ms >= 30_000)).toBe(true);
  });

  test('a 429 slows the host down for its Retry-After', async () => {
    const pages = tree();
    pages.b!.els = [{ name: 'uno', requests: [{ status: 429, retryAfter: '12' }] }, { name: 'dos' }];
    const site = new FakeSite(pages);
    const clock = fakeClock();
    await runFlood(opts({ workers: 1, rate: 10 }), { call: site.call, clock });
    expect(clock.sleeps.some((ms) => ms >= 12_000)).toBe(true);
  });

  test('a worker that dies is reopened and its item tried again', async () => {
    const site = new FakeSite(tree());
    site.failOnce.add('button|uno|main|0');
    const map = await runFlood(opts({ workers: 1 }), { call: site.call });
    expect(map.status).toBe('done');
    expect(site.opens.length).toBe(2);
    expect(map.states.find((s) => s.title === 'a')!.elements.find((e) => e.name === 'uno')!.outcome).toBe('same');
    expect(map.stats.errors).toBe(1);
  });

  test('a stop file ends the flood after the step in flight', async () => {
    const site = new FakeSite(tree());
    const call = site.call;
    let steps = 0;
    site.call = async (session, method, params) => {
      if (method === 'floodStep' && ++steps === 2) writeFileSync(join(dir, 'stop'), '');
      return call(session, method, params);
    };
    const map = await runFlood(opts({ workers: 1 }), { call: site.call });
    expect(map.status).toBe('stopped');
    expect(map.stats.activations).toBe(1);
    expect(map.unexplored.length).toBeGreaterThan(0);
  });

  test('robots.txt that disallows the start page refuses the flood', async () => {
    const site = new FakeSite(tree());
    await expect(runFlood(opts({ ignoreRobots: false }), { call: site.call, fetchText: () => Promise.resolve('User-agent: *\nDisallow: /\n') })).rejects.toThrow(/robots\.txt disallows/);
  });

  test('a page that loops back is the same state, not a new one', async () => {
    const pages = tree();
    pages.b!.els = [{ role: 'link', name: 'Home', url: 'https://s.test/', to: 'home', region: 'main' }];
    const site = new FakeSite(pages);
    const map: FloodMap = await runFlood(opts(), { call: site.call });
    expect(map.states.filter((s) => s.title === 'home')).toHaveLength(1);
  });
});
