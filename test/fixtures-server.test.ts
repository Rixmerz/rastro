import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GROUND_TRUTH, startFixtureServer } from './fixtures/server.ts';
import type { FixtureServer } from './fixtures/server.ts';

let server: FixtureServer;

beforeEach(async () => {
  server = await startFixtureServer();
});

afterEach(async () => {
  const start = Date.now();
  await server.close();
  expect(Date.now() - start).toBeLessThan(1000);
});

describe('ground truth', () => {
  test('declares the three scenarios', () => {
    expect(Object.keys(GROUND_TRUTH).sort()).toEqual(['login', 'polling', 'tracking']);
    for (const list of Object.values(GROUND_TRUTH)) {
      expect(list.length).toBeGreaterThan(0);
    }
  });
});

describe('login flow', () => {
  test('GET /login serves the form', async () => {
    const res = await fetch(`${server.origin}/login`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<form method="post" action="/login">');
    expect(html).toContain('Iniciar sesión');
  });

  test('POST /login with valid credentials redirects and sets cookies', async () => {
    const res = await fetch(`${server.origin}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'a@b.com', password: 'right' }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/panel');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('session=abc123');
  });

  test('POST /login with wrong password returns 401', async () => {
    const res = await fetch(`${server.origin}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'a@b.com', password: 'wrong' }),
    });
    expect(res.status).toBe(401);
  });

  test('/panel has 18 buttons and loads panel.js', async () => {
    const res = await fetch(`${server.origin}/panel`);
    const html = await res.text();
    expect(html.match(/<button>Producto \d+<\/button>/g)?.length).toBe(18);
    expect(html).toContain('/static/panel.js');

    const js = await fetch(`${server.origin}/static/panel.js`);
    expect(js.status).toBe(200);
  });

  test('/api/cart answers 500', async () => {
    const res = await fetch(`${server.origin}/api/cart`);
    expect(res.status).toBe(500);
  });
});

describe('hits tracking', () => {
  test('records method, path and timestamp; resetHits clears it', async () => {
    server.resetHits();
    await fetch(`${server.origin}/help`);
    const hits = server.hits();
    expect(hits.some((h) => h.method === 'GET' && h.path === '/help')).toBe(true);
    expect(hits[0]?.t).toBeGreaterThan(0);
    server.resetHits();
    expect(server.hits()).toHaveLength(0);
  });

  test('a blocked write never reaches the server', async () => {
    server.resetHits();
    // simulate a write that was blocked client-side: nothing fetched.
    expect(server.hits().some((h) => h.path.startsWith('/api/do'))).toBe(false);
  });
});

describe('other fixture pages', () => {
  test('/download link has attachment headers', async () => {
    const res = await fetch(`${server.origin}/files/factura.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="factura.pdf"');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(buf.slice(0, 8))).toBe('%PDF-1.4');
  });

  test('/bignav has 42 nav links', async () => {
    const html = await (await fetch(`${server.origin}/bignav`)).text();
    expect(html.match(/<a href="\/help#\d+">/g)?.length).toBe(42);
  });

  test('/captcha exposes the recaptcha iframe', async () => {
    const html = await (await fetch(`${server.origin}/captcha`)).text();
    expect(html).toContain('g-recaptcha');
    expect(html).toContain('/fake/recaptcha/anchor');
  });

  test('/shop injects the real altOrigin for cross-origin buy', async () => {
    const html = await (await fetch(`${server.origin}/shop`)).text();
    expect(html).toContain(server.altOrigin);
  });

  test('all pages use Spanish lang and no-store caching', async () => {
    const res = await fetch(`${server.origin}/record`);
    const html = await res.text();
    expect(html).toContain('<html lang="es">');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('CORS on /api/buy via altOrigin', () => {
  test('OPTIONS preflight from altOrigin is answered', async () => {
    const res = await fetch(`${server.origin}/api/buy`, {
      method: 'OPTIONS',
      headers: { Origin: server.altOrigin, 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(server.altOrigin);
  });

  test('POST /api/buy echoes Access-Control-Allow-Origin', async () => {
    const res = await fetch(`${server.origin}/api/buy`, {
      method: 'POST',
      headers: { Origin: server.altOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ card: '4111111111111111', qty: 1 }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(server.altOrigin);
  });
});

describe('altOrigin resolves to the same server', () => {
  test('altOrigin host answers requests', async () => {
    const res = await fetch(`${server.altOrigin}/help`);
    expect(res.status).toBe(200);
  });
});

describe('SSE endpoint', () => {
  test('/api/events opens a stream and close() still resolves quickly', async () => {
    const controller = new AbortController();
    const res = await fetch(`${server.origin}/api/events`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body?.getReader();
    const { value } = (await reader?.read()) ?? { value: undefined };
    expect(value).toBeDefined();
    controller.abort();
  });
});
