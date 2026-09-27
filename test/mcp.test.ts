import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, routineToolsOf } from '../src/mcp/server.ts';
import { contentHash, markVerified } from '../src/routines/state.ts';
import { stringifyRecipe } from '../src/link/recipe.ts';
import { createServer } from 'node:http';
import { RastroError } from '../src/core/types.ts';
import type { RpcMethod, RpcResult } from '../src/core/types.ts';

type Call = { session: string; method: RpcMethod; params: Record<string, unknown> };

/** Connects a fresh server (backed by `callFn`) to a fresh in-memory client. */
async function connect(callFn: (session: string, method: RpcMethod, params: Record<string, unknown>) => Promise<RpcResult>) {
  const server = createMcpServer(callFn, 'default');
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rastro-mcp-test-'));
  process.env.RASTRO_HOME = home;
  // Never read the real user's routines from a test.
  process.env.RASTRO_FLOWS = join(home, 'flows');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.RASTRO_HOME;
  delete process.env.RASTRO_FLOWS;
});

describe('tool listing', () => {
  test('lists the 11 browser tools and the 2 routine tools with short descriptions', async () => {
    const { client } = await connect(() => Promise.resolve({ text: 'ok', data: null }));
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(13);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'rastro_open',
        'rastro_view',
        'rastro_read',
        'rastro_act',
        'rastro_navigate',
        'rastro_effects',
        'rastro_trace',
        'rastro_request',
        'rastro_history',
        'rastro_detail',
        'rastro_export',
        'rastro_routines',
        'rastro_routine_run',
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.description).toBeDefined();
      expect(tool.description!.length).toBeLessThanOrEqual(160);
    }
  });

  test('every connected agent is told to check routines before browsing', async () => {
    const { client } = await connect(() => Promise.resolve({ text: 'ok', data: null }));
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toMatch(/call rastro_routines/);
    expect(instructions).toMatch(/do NOT retry/);
    expect(instructions.length).toBeLessThan(1200);
  });

  test('rastro_read reaches the read method with its region, ref and find', async () => {
    const calls: Call[] = [];
    const { client } = await connect((session, method, params) => {
      calls.push({ session, method, params });
      return Promise.resolve({ text: 'https://mail.test · main · 20 chars\nHola profe, ¿qué tal?', data: null });
    });
    const result = await client.callTool({ name: 'rastro_read', arguments: { region: 'main', find: 'profe' } });
    expect((result.content as { text: string }[])[0]!.text).toContain('Hola profe');
    expect(calls[0]).toMatchObject({ method: 'read', params: { region: 'main', find: 'profe' } });
  });

  test('rastro_request input schema has no reveal field', async () => {
    const { client } = await connect(() => Promise.resolve({ text: 'ok', data: null }));
    const { tools } = await client.listTools();
    const request = tools.find((t) => t.name === 'rastro_request');
    expect(request).toBeDefined();
    expect(Object.keys(request!.inputSchema.properties ?? {})).not.toContain('reveal');
  });
});

test('rastro_open drops empty-string entries from allowWrite and allowUpload (S10)', async () => {
  const calls: Call[] = [];
  const { client } = await connect((session, method, params) => {
    calls.push({ session, method, params });
    return Promise.resolve({ text: 'opened', data: null });
  });
  await client.callTool({
    name: 'rastro_open',
    arguments: { url: 'https://example.test', allowWrite: ['', 'x'], allowUpload: ['', 'x'] },
  });
  expect(calls[0]!.params.allowWrite).toEqual(['x']);
  expect(calls[0]!.params.allowUpload).toEqual(['x']);
});

test('rastro_act maps params exactly', async () => {
  const calls: Call[] = [];
  const { client } = await connect((session, method, params) => {
    calls.push({ session, method, params });
    return Promise.resolve({ text: 'clicked', data: null });
  });
  await client.callTool({
    name: 'rastro_act',
    arguments: { ref: 'e3', kind: 'fill', value: 'hello', secret: true, session: 'work' },
  });
  expect(calls).toEqual([{ session: 'work', method: 'act', params: { ref: 'e3', kind: 'fill', value: 'hello', secret: true } }]);
});

test('emits a resource_link for each file the RPC result returns', async () => {
  const { client } = await connect(() =>
    Promise.resolve({ text: 'exported', data: null, files: ['/tmp/trace.har', '/tmp/shot.png'] }),
  );
  const result = await client.callTool({ name: 'rastro_export', arguments: { format: 'har' } });
  const links = (result.content as { type: string; uri?: string; mimeType?: string }[]).filter((c) => c.type === 'resource_link');
  expect(links).toEqual([
    { type: 'resource_link', uri: 'file:///tmp/trace.har', name: 'trace.har', mimeType: 'application/json' },
    { type: 'resource_link', uri: 'file:///tmp/shot.png', name: 'shot.png', mimeType: 'image/png' },
  ]);
});

test('isError on RastroError, with the hint on its own line', async () => {
  const { client } = await connect(() => Promise.reject(new RastroError('session not open', 'run rastro_open first')));
  const result = await client.callTool({ name: 'rastro_view', arguments: {} });
  expect(result.isError).toBe(true);
  const content = result.content as { type: string; text: string }[];
  expect(content[0]!.text).toBe('error: session not open\nhint: run rastro_open first');
});

test('truncates large text to a file and links it', async () => {
  const bigText = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
  const { client } = await connect(() => Promise.resolve({ text: bigText, data: null }));
  const result = await client.callTool({ name: 'rastro_history', arguments: {} });
  const content = result.content as { type: string; text?: string; uri?: string }[];
  const text = content[0]!;
  expect(text.type).toBe('text');
  expect(text.text).toContain('line 0');
  expect(text.text).toContain('output truncated');
  expect(text.text!.split('\n').length).toBeLessThanOrEqual(22);

  const link = content.find((c) => c.type === 'resource_link');
  expect(link).toBeDefined();
  const filePath = link!.uri!.replace('file://', '');
  expect(existsSync(filePath)).toBe(true);
  expect(readFileSync(filePath, 'utf8')).toBe(bigText);
  expect(statSync(filePath).mode & 0o777).toBe(0o600);
});

// ---------------------------------------------------------------------------
// Routine tools.
// ---------------------------------------------------------------------------

describe('routine tools', () => {
  const ROUTINE = `name: add-note
tool:
  description: Add a note with a title
  effect: write
params:
  title: { type: string, description: the note title }
  count: { type: integer, description: how many, default: "1" }
  password: { from: "secret:notes" }
steps:
  - open: https://notes.example/new
`;

  function flowsDir(): string {
    const dir = process.env.RASTRO_FLOWS!;
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  async function connectWith(
    callFn: Parameters<typeof createMcpServer>[0],
    opts: Parameters<typeof createMcpServer>[2] = {},
  ) {
    const server = createMcpServer(callFn, 'default', opts);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return { client, server };
  }

  test('an unverified routine is only in the catalog; verified, it gets its own tool', async () => {
    const file = join(flowsDir(), 'add-note.yaml');
    writeFileSync(file, ROUTINE);
    const { client, server } = await connectWith(() => Promise.resolve({ text: 'ok', data: null }));

    let names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('add-note');
    const catalog = await client.callTool({ name: 'rastro_routines', arguments: {} });
    const text = (catalog.content as { text: string }[])[0]!.text;
    expect(text).toContain('add-note · write · unverified — Add a note with a title');
    expect(text).toContain('params: title:string, count:integer?');
    expect(text).not.toContain('password');

    markVerified(contentHash(ROUTINE), file);
    routineToolsOf(server)!.reload();
    const tools = (await client.listTools()).tools;
    names = tools.map((t) => t.name);
    expect(names).toContain('add-note');
    const tool = tools.find((t) => t.name === 'add-note')!;
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(['count', 'title']);
    expect(tool.inputSchema.required).toEqual(['title']);
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  });

  test('the dedicated tool runs routineRun on the routine file with the given params', async () => {
    const file = join(flowsDir(), 'add-note.yaml');
    writeFileSync(file, ROUTINE);
    markVerified(contentHash(ROUTINE), file);
    const calls: Call[] = [];
    const { client } = await connectWith((session, method, params) => {
      calls.push({ session, method, params });
      return Promise.resolve({ text: 'add-note ok · 1 steps', data: { ok: true } });
    });
    const result = await client.callTool({ name: 'add-note', arguments: { title: 'Hola', count: 2 } });
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([{ session: 'default', method: 'routineRun', params: { file, params: { title: 'Hola', count: 2 } } }]);
  });

  test('a first good run through rastro_routine_run promotes the routine', async () => {
    const file = join(flowsDir(), 'add-note.yaml');
    writeFileSync(file, ROUTINE);
    const { client } = await connectWith(() => {
      // What the daemon does on success.
      markVerified(contentHash(ROUTINE), file);
      return Promise.resolve({ text: 'add-note ok · 1 steps', data: { ok: true } });
    });
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('add-note');
    await client.callTool({ name: 'rastro_routine_run', arguments: { name: 'add-note', params: { title: 'x' } } });
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('add-note');
  });

  test('bad params fail before the daemon is called', async () => {
    writeFileSync(join(flowsDir(), 'add-note.yaml'), ROUTINE);
    const calls: Call[] = [];
    const { client } = await connectWith((session, method, params) => {
      calls.push({ session, method, params });
      return Promise.resolve({ text: 'ok', data: null });
    });
    const result = await client.callTool({ name: 'rastro_routine_run', arguments: { name: 'add-note', params: { count: 'x' } } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/param count: expected an integer/);
    expect(calls).toEqual([]);
  });

  test('a timeout says the routine may still be running and must not be retried', async () => {
    writeFileSync(join(flowsDir(), 'add-note.yaml'), ROUTINE);
    const { client } = await connectWith(() => Promise.reject(new Error('timed out waiting for routineRun after 900000ms')));
    const result = await client.callTool({ name: 'rastro_routine_run', arguments: { name: 'add-note', params: { title: 'x' } } });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toMatch(/still running/);
    expect(text).toMatch(/Do NOT run it again/);
  });

  test('a broken edit removes the tool and shows up in the catalog', async () => {
    const file = join(flowsDir(), 'add-note.yaml');
    writeFileSync(file, ROUTINE);
    markVerified(contentHash(ROUTINE), file);
    const { client, server } = await connectWith(() => Promise.resolve({ text: 'ok', data: null }));
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('add-note');

    writeFileSync(file, ROUTINE.replace('effect: write', 'effect: sometimes'));
    routineToolsOf(server)!.reload();
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('add-note');
    const catalog = await client.callTool({ name: 'rastro_routines', arguments: {} });
    expect((catalog.content as { text: string }[])[0]!.text).toMatch(/problem: add-note .*tool\.effect/);
  });

  test('the watcher picks up a newly verified routine without a reload call', async () => {
    const file = join(flowsDir(), 'add-note.yaml');
    writeFileSync(file, ROUTINE);
    const { client, server } = await connectWith(() => Promise.resolve({ text: 'ok', data: null }));
    const controller = routineToolsOf(server)!;
    controller.watch();
    try {
      markVerified(contentHash(ROUTINE), file);
      const start = Date.now();
      while (!controller.liveTools().includes('add-note') && Date.now() - start < 5000) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect((await client.listTools()).tools.map((t) => t.name)).toContain('add-note');
    } finally {
      controller.close();
    }
  });

  test('a dedicated tool sees a recipe verified after it was registered and replays over http', async () => {
    const hits: string[] = [];
    const http = createServer((r, res) => {
      hits.push(`${r.method} ${r.url}`);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    try {
      const routineText = ROUTINE.replace('https://notes.example/new', `http://127.0.0.1:${port}/new`).replace(
        '  password: { from: "secret:notes" }\n',
        '',
      );
      const file = join(flowsDir(), 'add-note.yaml');
      writeFileSync(file, routineText);
      markVerified(contentHash(routineText), file);
      const calls: Call[] = [];
      const { client } = await connectWith((session, method, params) => {
        calls.push({ session, method, params });
        return Promise.resolve({ text: 'browser', data: { ok: true } });
      });
      expect((await client.listTools()).tools.map((t) => t.name)).toContain('add-note');

      // Linked and verified only now, after the tool exists.
      const recipeText = stringifyRecipe({
        flow: 'add-note',
        flowHash: contentHash(routineText),
        params: ['title', 'count'],
        requests: [{ id: 'q1', method: 'GET', url: `http://127.0.0.1:${port}/new`, query: [{ name: 't', value: '{{title}}' }], expect: '2xx' }],
      });
      writeFileSync(join(flowsDir(), 'add-note.link.yaml'), recipeText);
      markVerified(contentHash(recipeText), join(flowsDir(), 'add-note.link.yaml'), 'verified-links');

      const result = await client.callTool({ name: 'add-note', arguments: { title: 'Hola' } });
      expect(result.isError).toBeFalsy();
      expect((result.content as { text: string }[])[0]!.text).toContain('add-note ok · 1 steps · http');
      expect(calls).toEqual([]);
      expect(hits).toEqual(['GET /new?t=Hola']);
    } finally {
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });

  test('--routines-only exposes no browser tool; catalog mode no per-routine tool', async () => {
    const file = join(flowsDir(), 'add-note.yaml');
    writeFileSync(file, ROUTINE);
    markVerified(contentHash(ROUTINE), file);
    const only = await connectWith(() => Promise.resolve({ text: 'ok', data: null }), { routinesOnly: true });
    expect((await only.client.listTools()).tools.map((t) => t.name).sort()).toEqual(['add-note', 'rastro_routine_run', 'rastro_routines']);

    const catalog = await connectWith(() => Promise.resolve({ text: 'ok', data: null }), { routines: 'catalog' });
    const names = (await catalog.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('rastro_routines');
    expect(names).not.toContain('add-note');

    const off = await connectWith(() => Promise.resolve({ text: 'ok', data: null }), { routines: 'off' });
    expect((await off.client.listTools()).tools).toHaveLength(11);
  });
});
