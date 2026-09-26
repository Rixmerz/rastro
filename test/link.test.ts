import { createServer, type IncomingMessage, type Server } from 'node:http';
import { describe, expect, test, afterEach } from 'vitest';
import type { RequestRecord } from '../src/core/types.ts';
import { compileRecipe, NotLinkable, parseMultipart, type CompileInput } from '../src/link/compile.ts';
import { CookieJar } from '../src/link/jar.ts';
import { parseRecipe, stringifyRecipe, type Recipe } from '../src/link/recipe.ts';
import { runRecipe } from '../src/link/run.ts';

let seq = 0;

function req(partial: Partial<RequestRecord> & { method: string; url: string }): RequestRecord {
  seq += 1;
  return {
    id: `r${seq}`,
    cdpId: `c${seq}`,
    tabId: 't1',
    t: seq,
    resourceType: 'document',
    initiator: { type: 'other', stackHasInterval: false },
    requestHeaders: {},
    timing: { startMs: seq },
    origin: 'page',
    isNavigation: true,
    actionId: 1,
    bucket: 'attributed',
    status: 200,
    mimeType: 'text/html',
    ...partial,
  };
}

function input(requests: RequestRecord[], bodies: Record<string, string>, over: Partial<CompileInput> = {}): CompileInput {
  return {
    flow: 'add-note',
    flowHash: 'a'.repeat(64),
    requests,
    body: (r) => bodies[r.id] ?? null,
    params: {},
    callerParams: [],
    secretParams: [],
    uploads: {},
    cookies: [],
    containsSecret: () => false,
    ...over,
  };
}

const FORM_HTML = '<form><input type="hidden" name="csrf" value="c1xk3j2h1g0f"><input name="title"></form>';

describe('compile', () => {
  test('a CSRF form post: token extracted, param bound, redirect hop folded in', () => {
    const get = req({ method: 'GET', url: 'https://app.test/form' });
    const post = req({
      method: 'POST',
      url: 'https://app.test/note',
      requestHeaders: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'sid=zzz', 'sec-fetch-mode': 'navigate' },
      postData: 'csrf=c1xk3j2h1g0f&title=Primera',
      status: 303,
      responseHeaders: { location: '/notes/7' },
    });
    const hop = req({ method: 'GET', url: 'https://app.test/notes/7', redirectedFrom: post.id });
    const recipe = compileRecipe(input([hop, post, get], { [get.id]: FORM_HTML }, { params: { title: 'Primera' }, callerParams: ['title'] }));

    expect(recipe.requests).toHaveLength(2);
    const [q1, q2] = recipe.requests;
    expect(q1).toMatchObject({ id: 'q1', method: 'GET', url: 'https://app.test/form', expect: '2xx', extract: { csrf: { input: 'csrf' } } });
    expect(q2).toMatchObject({
      method: 'POST',
      url: 'https://app.test/note',
      form: [
        { name: 'csrf', value: '{{csrf}}' },
        { name: 'title', value: '{{title}}' },
      ],
      expect: '3xx',
    });
    expect(q2!.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });
    expect(parseRecipe(stringifyRecipe(recipe))).toEqual(recipe);
  });

  test('a JSON id handed out by one call and sent by the next keeps its number type', () => {
    const draft = req({ method: 'GET', url: 'https://app.test/api/draft', resourceType: 'xhr', mimeType: 'application/json' });
    const save = req({
      method: 'POST',
      url: 'https://app.test/api/save',
      resourceType: 'xhr',
      requestHeaders: { 'content-type': 'application/json' },
      postData: JSON.stringify({ itemid: 834211, name: 'Clase 5' }),
    });
    const recipe = compileRecipe(
      input([draft, save], { [draft.id]: JSON.stringify({ data: { itemid: 834211 } }) }, { params: { name: 'Clase 5' }, callerParams: ['name'] }),
    );
    expect(recipe.requests[0]!.extract).toEqual({ itemid: { json: 'data.itemid' } });
    expect(recipe.requests[1]!.json).toEqual({ itemid: '{{itemid|number}}', name: '{{name}}' });
  });

  test('a value handed out in a redirect Location is read from it', () => {
    const create = req({ method: 'POST', url: 'https://app.test/create', postData: '', status: 302, responseHeaders: { Location: '/items/98765?x=1' } });
    const hop = req({ method: 'GET', url: 'https://app.test/items/98765?x=1', redirectedFrom: create.id });
    const edit = req({ method: 'GET', url: 'https://app.test/api/item?id=98765', resourceType: 'fetch', mimeType: 'application/json' });
    const recipe = compileRecipe(input([create, hop, edit], {}));
    const rule = recipe.requests[0]!.extract!['id'];
    expect(rule).toMatchObject({ from: 'location' });
    expect(new RegExp((rule as { regex: string }).regex).exec('https://app.test/items/555?x=1')?.[1]).toBe('555');
    expect(recipe.requests[1]!.query).toEqual([{ name: 'id', value: '{{id}}' }]);
  });

  test('a value that arrives in the final URL of a redirect chain is read from its query', () => {
    const go = req({ method: 'GET', url: 'https://app.test/go', status: 302, responseHeaders: { location: '/b' } });
    const b = req({ method: 'GET', url: 'https://app.test/b', status: 302, responseHeaders: { location: '/view?id=4321' }, redirectedFrom: go.id });
    const view = req({ method: 'GET', url: 'https://app.test/view?id=4321', redirectedFrom: b.id });
    const mod = req({ method: 'POST', url: 'https://app.test/mod', requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, postData: 'course=4321' });
    const recipe = compileRecipe(input([go, b, view, mod], {}));
    expect(recipe.requests[0]!.extract).toEqual({ course: { query: 'id' } });
    expect(recipe.requests[1]!.form).toEqual([{ name: 'course', value: '{{course}}' }]);
  });

  test('a double-submit token is read from the jar, never written down', () => {
    const post = req({
      method: 'POST',
      url: 'https://app.test/save',
      requestHeaders: { 'content-type': 'application/x-www-form-urlencoded', 'X-CSRFToken': 'Tk9zZ4yQ81hLmW2e' },
      postData: 'token=Tk9zZ4yQ81hLmW2e',
    });
    const recipe = compileRecipe(input([post], {}, { cookies: [{ name: 'csrftoken', value: 'Tk9zZ4yQ81hLmW2e' }] }));
    expect(recipe.requests[0]!.form).toEqual([{ name: 'token', value: '{{cookie:csrftoken}}' }]);
    expect(recipe.requests[0]!.headers!['x-csrftoken']).toBe('{{cookie:csrftoken}}');
    expect(stringifyRecipe(recipe)).not.toContain('Tk9zZ4yQ81hLmW2e');
  });

  test('a secret param is bound, and the file never holds it', () => {
    const login = req({
      method: 'POST',
      url: 'https://app.test/login',
      requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'user=ada&password=hunter2-S3cret',
    });
    const recipe = compileRecipe(
      input([login], {}, {
        params: { user: 'ada', password: 'hunter2-S3cret' },
        secretParams: ['password'],
        containsSecret: (t) => t.includes('hunter2-S3cret'),
      }),
    );
    expect(recipe.requests[0]!.form).toEqual([
      { name: 'user', value: '{{user}}' },
      { name: 'password', value: '{{password}}' },
    ]);
  });

  test('a secret that would leak through an unbound body aborts the link', () => {
    const post = req({ method: 'POST', url: 'https://app.test/raw', requestHeaders: { 'content-type': 'text/plain' }, postData: 'k=topsecretvalue' });
    expect(() => compileRecipe(input([post], {}, { containsSecret: (t) => t.includes('topsecretvalue') }))).toThrow(NotLinkable);
  });

  test('a short value shared by several fields is left as recorded, with a warning', () => {
    const post = req({
      method: 'POST',
      url: 'https://app.test/add',
      requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'section=1&course=1',
    });
    const recipe = compileRecipe(input([post], {}, { params: { seccion: '1' } }));
    expect(recipe.requests[0]!.form).toEqual([
      { name: 'section', value: '1' },
      { name: 'course', value: '1' },
    ]);
    expect(recipe.warnings?.[0]).toMatch(/too short to tell apart/);
  });

  test('an Authorization header nothing produced makes the flow not linkable', () => {
    const call = req({ method: 'GET', url: 'https://app.test/api/me', resourceType: 'fetch', requestHeaders: { Authorization: 'Bearer eyJhbGciOi.xyz' } });
    expect(() => compileRecipe(input([call], {}))).toThrow(/Authorization header/);
  });

  test('an untraced token-looking constant is flagged without printing it', () => {
    const post = req({
      method: 'POST',
      url: 'https://app.test/p',
      requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'nonce=a8f3b2c19d7e4f60aa31',
    });
    const recipe = compileRecipe(input([post], {}));
    expect(recipe.warnings).toEqual(['q1 nonce: sends a constant that looks like a token and was not found in any earlier response']);
  });

  test('reads nobody consumes are dropped; background traffic never enters', () => {
    const page = req({ method: 'GET', url: 'https://app.test/panel' });
    const me = req({ method: 'GET', url: 'https://app.test/api/me', resourceType: 'xhr' });
    const beacon = req({ method: 'POST', url: 'https://app.test/collect', resourceType: 'ping', bucket: 'background' });
    const save = req({ method: 'POST', url: 'https://app.test/save', postData: '' });
    const recipe = compileRecipe(input([page, me, beacon, save], {}));
    expect(recipe.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['POST https://app.test/save']);
  });

  test('page-script POSTs are dropped only when the flow names the write that matters', () => {
    const page = req({ method: 'GET', url: 'https://app.test/form' });
    const chatter = req({ method: 'POST', url: 'https://app.test/lib/ajax/service.php?sesskey=AbCd123456&info=load', resourceType: 'xhr', requestHeaders: { 'content-type': 'application/json' }, postData: '[{"methodname":"load"}]' });
    const save = req({ method: 'POST', url: 'https://app.test/save', requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, postData: 'sesskey=AbCd123456&name=Ada', status: 303 });
    const bodies = { [page.id]: '<input name="sesskey" value="AbCd123456">' };
    const params = { params: { name: 'Ada' }, callerParams: ['name'] };

    const named = compileRecipe(input([page, chatter, save], bodies, { ...params, expected: ['POST /save 3xx'] }));
    expect(named.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['GET /form', 'POST /save']);
    expect(named.warnings).toEqual(['dropped page-script POSTs that send no file and are not in the flow\'s expect.requests: POST /lib/ajax/service.php']);

    const unnamed = compileRecipe(input([page, chatter, save], bodies, params));
    expect(unnamed.requests).toHaveLength(3);
    expect(unnamed.warnings?.[0]).toMatch(/kept every page-script POST/);
  });

  test('a multipart upload binds the file part to the upload param', () => {
    const body = [
      '--XYZ',
      'Content-Disposition: form-data; name="title"',
      '',
      'Clase 5',
      '--XYZ',
      'Content-Disposition: form-data; name="repo_upload_file"; filename="clase5.pdf"',
      'Content-Type: application/pdf',
      '',
      '',
      '--XYZ--',
      '',
    ].join('\r\n');
    const post = req({ method: 'POST', url: 'https://app.test/upload', resourceType: 'xhr', requestHeaders: { 'content-type': 'multipart/form-data; boundary=XYZ' }, postData: body });
    const recipe = compileRecipe(input([post], {}, { params: { name: 'Clase 5', archivo: '/home/u/clase5.pdf' }, uploads: { 'clase5.pdf': 'archivo' } }));
    expect(recipe.requests[0]!.multipart).toEqual([
      { name: 'title', value: '{{name}}' },
      { name: 'repo_upload_file', file: '{{archivo}}', contentType: 'application/pdf' },
    ]);
    expect(recipe.requests[0]!.headers?.['content-type']).toBeUndefined();
    expect(parseMultipart(body, 'XYZ').map((p) => p.name)).toEqual(['title', 'repo_upload_file']);
  });

  test('a multipart body the browser did not expose is refused, not linked without the file', () => {
    const post = req({ method: 'POST', url: 'https://app.test/upload', requestHeaders: { 'content-type': 'multipart/form-data; boundary=XYZ' } });
    expect(() => compileRecipe(input([post], {}))).toThrow(/did not expose the upload body/);
  });
});

describe('cookie jar', () => {
  test('an export scoped to a recipe keeps only the cookies its hosts would send', () => {
    const jar = CookieJar.fromBrowser(
      [
        { name: 'MoodleSession', value: 'm', domain: 'lms.example.edu', path: '/', expires: -1, secure: true },
        { name: 'sso', value: 's', domain: '.example.edu', path: '/', expires: -1, secure: true },
        { name: 'mail', value: 'o', domain: 'outlook.example.com', path: '/', expires: -1, secure: true },
      ],
      ['lms.example.edu'],
    );
    expect(jar.cookies.map((c) => c.name).sort()).toEqual(['MoodleSession', 'sso']);
  });

  test('domain, path, host-only and expiry', () => {
    const jar = CookieJar.fromBrowser([
      { name: 'a', value: '1', domain: '.example.edu', path: '/', expires: -1, secure: false },
      { name: 'b', value: '2', domain: 'lms.example.edu', path: '/course', expires: -1, secure: true },
    ]);
    expect(jar.header('https://lms.example.edu/course/view.php')).toBe('b=2; a=1');
    expect(jar.header('https://sso.example.edu/')).toBe('a=1');
    expect(jar.header('http://lms.example.edu/course')).toBe('a=1');
    jar.store('https://lms.example.edu/login', ['a=; Max-Age=0; Domain=example.edu; Path=/', 'c=3; Path=/']);
    expect(jar.header('https://lms.example.edu/')).toBe('c=3');
    jar.store('https://lms.example.edu/', ['evil=1; Domain=other.test']);
    expect(jar.cookies.find((c) => c.name === 'evil')?.domain).toBe('lms.example.edu');
  });
});

describe('http runner', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  function body(r: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let data = '';
      r.on('data', (c: Buffer) => (data += c.toString()));
      r.on('end', () => resolve(data));
    });
  }

  type Reply = { status: number; headers?: Record<string, string | string[]>; body?: string };

  async function serve(handler: (r: IncomingMessage, text: string) => Reply): Promise<string> {
    server = createServer((r, res) => {
      void body(r).then((text) => {
        const out = handler(r, text);
        res.writeHead(out.status, out.headers ?? {});
        res.end(out.body ?? '');
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  }

  function recipe(origin: string): Recipe {
    return {
      flow: 'add-note',
      flowHash: 'a'.repeat(64),
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
      ],
    };
  }

  test('extracts the fresh token, keeps cookies across redirects, reports the write', async () => {
    const created: string[] = [];
    let token = 0;
    const origin = await serve((r, text): Reply => {
      const authed = (r.headers.cookie ?? '').includes('sid=ok');
      if (r.url === '/form') {
        token += 1;
        return authed ? { status: 200, headers: { 'content-type': 'text/html' }, body: `<input name="csrf" value="tok${token}">` } : { status: 302, headers: { location: '/login' } };
      }
      if (r.url === '/note' && r.method === 'POST') {
        const form = new URLSearchParams(text);
        if (form.get('csrf') !== `tok${token}`) return { status: 403 };
        created.push(form.get('title')!);
        return { status: 303, headers: { location: '/notes/1', 'set-cookie': 'last=1; Path=/' } };
      }
      if (r.url === '/notes/1') return { status: 200, body: 'ok' };
      return { status: 404 };
    });
    const jar = new CookieJar();
    jar.store(origin, ['sid=ok; Path=/']);
    const result = await runRecipe(recipe(origin), { params: { title: 'Segunda' }, jar, assertUploadAllowed: () => {} });

    expect(result).toMatchObject({ ok: true, requestsSent: 2, finalUrl: `${origin}/notes/1` });
    expect(result.writes).toEqual([{ method: 'POST', path: '/note', status: 303, location: `${origin}/notes/1` }]);
    expect(created).toEqual(['Segunda']);
    expect(jar.header(`${origin}/`)).toContain('last=1');
  });

  test('an expired session fails before the write, so falling back is safe', async () => {
    const origin = await serve((r) => (r.url === '/form' ? { status: 302, headers: { location: '/login' } } : { status: 200 }));
    const result = await runRecipe(recipe(origin), { params: { title: 'x' }, jar: new CookieJar(), assertUploadAllowed: () => {} });
    expect(result).toMatchObject({ ok: false, failedRequest: 'q1', beforeWrite: true });
    expect(result.reason).toMatch(/q1 GET \/form answered 302 → \/login where 2xx was recorded/);
  });

  test('a failure on the write itself is not safe to retry', async () => {
    const origin = await serve((r) => (r.url === '/form' ? { status: 200, body: '<input name="csrf" value="tok">' } : { status: 500 }));
    const result = await runRecipe(recipe(origin), { params: { title: 'x' }, jar: new CookieJar(), assertUploadAllowed: () => {} });
    expect(result).toMatchObject({ ok: false, failedRequest: 'q2', beforeWrite: false });
    expect(result.writes).toHaveLength(1);
  });
});
