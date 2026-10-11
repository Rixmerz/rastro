import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { RequestRecord } from '../src/core/types.ts';
import { compileRecipe, type CompileInput } from '../src/link/compile.ts';
import { emitClient, envVars } from '../src/link/emit.ts';
import { CookieJar } from '../src/link/jar.ts';
import { detectPagination, nextPageUrl, withItems } from '../src/link/paginate.ts';
import { parseRecipe, stringifyRecipe, type Recipe } from '../src/link/recipe.ts';
import { runRecipe } from '../src/link/run.ts';

const run = promisify(execFile);

describe('pagination detection', () => {
  test('a cursor handed out in the response and sent back as a query param', () => {
    const p = detectPagination('https://api.test/v1/items?cursor=abc&limit=2', { data: [{ id: 1 }, { id: 2 }], meta: { next_cursor: 'def' } });
    expect(p).toEqual({ query: 'cursor', next: { json: 'meta.next_cursor' }, items: 'data', maxPages: 10 });
  });

  test('a next URL, same origin only', () => {
    expect(detectPagination('https://api.test/jobs', { results: [{ id: 1 }], next: 'https://api.test/jobs?page=2' })).toMatchObject({ next: { url: 'next' }, items: 'results' });
    expect(detectPagination('https://api.test/jobs', { results: [{ id: 1 }], next: 'https://evil.test/jobs?page=2' })).toBeUndefined();
  });

  test('a page number steps by one, an offset by the limit', () => {
    expect(detectPagination('https://api.test/jobs?page=1', [{ id: 1 }])).toEqual({ query: 'page', next: { step: 1 }, items: '', maxPages: 10 });
    expect(detectPagination('https://api.test/jobs?offset=0&limit=25', { hits: { hits: [{}, {}] } })).toMatchObject({ query: 'offset', next: { step: 25 }, items: 'hits.hits' });
  });

  test('nothing to page through: no list, or no way to ask for the next page', () => {
    expect(detectPagination('https://api.test/me', { name: 'Ada' })).toBeUndefined();
    expect(detectPagination('https://api.test/jobs', { results: [{ id: 1 }] })).toBeUndefined();
  });

  test('a numeric step stops at a short page; a cursor at an empty one', () => {
    const step = { query: 'page', next: { step: 1 }, items: '', maxPages: 10 } as const;
    expect(nextPageUrl(step, 'https://a.test/x?page=1', [], 2, 2)).toBe('https://a.test/x?page=2');
    expect(nextPageUrl(step, 'https://a.test/x?page=2', [], 2, 1)).toBeUndefined();
    const cursor = { query: 'c', next: { json: 'next' }, items: 'data', maxPages: 10 } as const;
    expect(nextPageUrl(cursor, 'https://a.test/x', { next: null }, 2, 2)).toBeUndefined();
  });

  test('merged items replace the list in the first page', () => {
    expect(withItems({ meta: { n: 1 }, data: { rows: [1] } }, 'data.rows', [1, 2, 3])).toEqual({ meta: { n: 1 }, data: { rows: [1, 2, 3] } });
  });

  test('compile marks a paginated product request and says so', () => {
    const r: RequestRecord = {
      id: 'r1',
      cdpId: 'c1',
      tabId: 't1',
      t: 1,
      method: 'GET',
      url: 'https://api.test/jobs?page=1',
      resourceType: 'fetch',
      initiator: { type: 'script', stackHasInterval: false },
      requestHeaders: {},
      timing: { startMs: 1 },
      origin: 'page',
      isNavigation: false,
      actionId: 1,
      bucket: 'attributed',
      status: 200,
      mimeType: 'application/json',
    };
    const input: CompileInput = {
      flow: 'jobs',
      flowHash: 'a'.repeat(64),
      requests: [r],
      body: () => JSON.stringify({ jobs: [{ id: 1 }, { id: 2 }] }),
      params: {},
      callerParams: [],
      secretParams: [],
      uploads: {},
      cookies: [],
      containsSecret: () => false,
    };
    const recipe = compileRecipe(input);
    expect(recipe.requests[0]!.paginate).toEqual({ query: 'page', next: { step: 1 }, items: 'jobs', maxPages: 10 });
    expect(recipe.warnings?.join('\n')).toMatch(/q1: looks like one page of a list and steps page by 1/);
    expect(parseRecipe(stringifyRecipe(recipe))).toEqual(recipe);
  });

  test('a write never paginates', () => {
    const bad = { flow: 'x', flowHash: 'a'.repeat(64), params: [], requests: [{ id: 'q1', method: 'POST', url: 'https://a.test/', paginate: { query: 'p', next: { step: 1 }, items: '', maxPages: 2 } }] };
    expect(() => parseRecipe(stringifyRecipe(bad as Recipe))).toThrow(/only a read can paginate/);
  });
});

// A small site: a form behind a session cookie, a CSRF-protected post, and a
// paginated JSON list behind an API key that comes from the keyring.
function site() {
  const created: string[] = [];
  let token = 0;
  const JOBS = [{ id: 1, title: 'a' }, { id: 2, title: 'b' }, { id: 3, title: 'c' }, { id: 4, title: 'd' }, { id: 5, title: 'e' }];
  const handler = (r: IncomingMessage, text: string): { status: number; headers?: Record<string, string>; body?: string } => {
    const url = new URL(r.url ?? '/', 'http://x');
    if (!(r.headers.cookie ?? '').includes('sid=ok')) return { status: 302, headers: { location: '/login' } };
    if (url.pathname === '/form') {
      token += 1;
      return { status: 200, headers: { 'content-type': 'text/html' }, body: `<form><input type="hidden" name="csrf" value="tok${token}"></form>` };
    }
    if (url.pathname === '/note' && r.method === 'POST') {
      const form = new URLSearchParams(text);
      if (form.get('csrf') !== `tok${token}`) return { status: 403 };
      created.push(form.get('title')!);
      return { status: 303, headers: { location: '/notes', 'set-cookie': 'last=1; Path=/' } };
    }
    if (url.pathname === '/notes') return { status: 200, headers: { 'content-type': 'text/html' }, body: 'ok' };
    if (url.pathname === '/api/jobs') {
      if (r.headers['x-api-key'] !== 'k-123') return { status: 401 };
      const page = Number(url.searchParams.get('page'));
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ total: JOBS.length, jobs: JOBS.slice((page - 1) * 2, page * 2) }) };
    }
    return { status: 404 };
  };
  return { created, handler };
}

function recipeFor(origin: string): Recipe {
  return {
    flow: 'add-note',
    flowHash: 'b'.repeat(64),
    params: ['title'],
    requests: [
      { id: 'q1', method: 'GET', url: `${origin}/form`, expect: '2xx', extract: { csrf: { input: 'csrf' } } },
      {
        id: 'q2',
        method: 'POST',
        url: `${origin}/note`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        form: [
          { name: 'csrf', value: '{{csrf}}' },
          { name: 'title', value: '{{title}}' },
        ],
        expect: '3xx',
      },
      {
        id: 'q3',
        method: 'GET',
        url: `${origin}/api/jobs`,
        query: [{ name: 'page', value: '1' }],
        headers: { 'x-api-key': '{{apiKey}}' },
        expect: '2xx',
        xhr: true,
        paginate: { query: 'page', next: { step: 1 }, items: 'jobs', maxPages: 10 },
      },
    ],
    outputs: [{ as: 'jobs', request: 'GET /api/jobs* 2xx', json: 'jobs', fields: { id: 'id', name: 'title' } }],
  };
}

describe('replaying a paginated recipe', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  test('the runner fetches every page and the capture sees all items', async () => {
    const { handler } = site();
    server = createServer((r, res) => {
      let text = '';
      r.on('data', (c: Buffer) => (text += c.toString()));
      r.on('end', () => {
        const out = handler(r, text);
        res.writeHead(out.status, out.headers ?? {});
        res.end(out.body ?? '');
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const jar = new CookieJar();
    jar.store(origin, ['sid=ok; Path=/']);
    const result = await runRecipe(recipeFor(origin), { params: { title: 'Hola', apiKey: 'k-123' }, jar, assertUploadAllowed: () => {} });
    expect(result.ok).toBe(true);
    expect(result.requestsSent).toBe(5);
    expect(result.outputs?.['jobs']).toHaveLength(5);
    expect((result.outputs?.['jobs'] as { name: string }[]).map((j) => j.name).join('')).toBe('abcde');
  });
});

describe('emitted clients', () => {
  let server: Server;
  let origin: string;
  let dir: string;
  let state: ReturnType<typeof site>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rastro-emit-'));
    server = createServer((r, res) => {
      let text = '';
      r.on('data', (c: Buffer) => (text += c.toString()));
      r.on('end', () => {
        const out = state.handler(r, text);
        res.writeHead(out.status, out.headers ?? {});
        res.end(out.body ?? '');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  test('keyring parameters become environment variables', () => {
    expect(envVars(recipeFor('http://x.test'))).toEqual({ apiKey: 'API_KEY' });
  });

  test('the client holds no credential and says whether the recipe was verified', () => {
    const ts = emitClient(recipeFor(origin), 'ts', { source: 'add-note.link.yaml', verified: false });
    expect(ts).toContain('NOT verified yet');
    expect(ts).toContain('WARNING: this client sends writes');
    expect(ts).not.toContain('k-123');
    expect(ts).not.toContain('sid=ok');
  });

  const expected = {
    outputs: { jobs: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }, { id: 4, name: 'd' }, { id: 5, name: 'e' }] },
    requestsSent: 5,
  };

  test('TypeScript: runs under node with the same result as the runner', async () => {
    state = site();
    const file = join(dir, 'add-note.client.ts');
    writeFileSync(file, emitClient(recipeFor(origin), 'ts', { source: 'add-note.link.yaml', verified: true }));
    const { stdout } = await run(process.execPath, [file, '--title', 'Desde TS', '--cookie', 'sid=ok'], { env: { ...process.env, API_KEY: 'k-123' } });
    const result = JSON.parse(stdout) as Record<string, unknown>;
    expect(result).toMatchObject({ ...expected, finalUrl: `${origin}/notes` });
    expect(result['writes']).toEqual([{ method: 'POST', url: `${origin}/note`, status: 303 }]);
    expect(state.created).toEqual(['Desde TS']);
  });

  test('TypeScript: an expired session stops before the write', async () => {
    state = site();
    const file = join(dir, 'add-note.client.ts');
    writeFileSync(file, emitClient(recipeFor(origin), 'ts', { source: 'add-note.link.yaml', verified: true }));
    const err = await run(process.execPath, [file, '--title', 'x'], { env: { ...process.env, API_KEY: 'k-123' } }).catch((e: { code: number; stderr: string }) => e);
    expect(err).toMatchObject({ code: 1 });
    expect((err as { stderr: string }).stderr).toMatch(/q1 GET .*\/form answered 302 where 2xx was recorded/);
    expect(state.created).toEqual([]);
  });

  test('Python: runs with the standard library and the same result', async () => {
    state = site();
    const file = join(dir, 'add_note_client.py');
    writeFileSync(file, emitClient(recipeFor(origin), 'py', { source: 'add-note.link.yaml', verified: true }));
    const cookies = join(dir, 'cookies.json');
    writeFileSync(cookies, JSON.stringify([{ name: 'sid', value: 'ok', domain: '127.0.0.1', hostOnly: true, path: '/', secure: false, expires: -1 }]));
    const { stdout } = await run('python3', ['-I', file, '--title', 'Desde Py', '--cookie-file', cookies], { env: { ...process.env, API_KEY: 'k-123' } });
    const result = JSON.parse(stdout) as Record<string, unknown>;
    expect(result).toMatchObject({ ...expected, finalUrl: `${origin}/notes` });
    expect(result['writes']).toEqual([{ method: 'POST', url: `${origin}/note`, status: 303 }]);
    expect(state.created).toEqual(['Desde Py']);
  });

  test('Python: a missing keyring variable fails before any request', async () => {
    state = site();
    const file = join(dir, 'add_note_client.py');
    writeFileSync(file, emitClient(recipeFor(origin), 'py', { source: 'add-note.link.yaml', verified: true }));
    const env = { ...process.env };
    delete env['API_KEY'];
    const err = await run('python3', ['-I', file, '--title', 'x', '--cookie', 'sid=ok'], { env }).catch((e: { code: number; stderr: string }) => e);
    expect(err).toMatchObject({ code: 1 });
    expect((err as { stderr: string }).stderr).toMatch(/missing environment variable API_KEY/);
    expect(state.created).toEqual([]);
  });
});
