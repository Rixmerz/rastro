import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpServer } from '../src/mcp/server.ts';
import { isLoopback, resolveToken, startHttpServer, tokenPath, type RunningHttpServer } from '../src/mcp/http.ts';
import type { RpcMethod, RpcResult } from '../src/core/types.ts';

const TOKEN = 'test-token-0123456789';

type Call = { session: string; method: RpcMethod; params: Record<string, unknown> };

let home: string;
let running: RunningHttpServer | undefined;
let calls: Call[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rastro-mcp-http-'));
  process.env.RASTRO_HOME = home;
  process.env.RASTRO_FLOWS = join(home, 'flows');
  delete process.env.RASTRO_MCP_TOKEN;
  calls = [];
});

afterEach(async () => {
  await running?.close();
  running = undefined;
  rmSync(home, { recursive: true, force: true });
  delete process.env.RASTRO_HOME;
  delete process.env.RASTRO_FLOWS;
  delete process.env.RASTRO_MCP_TOKEN;
});

async function start(): Promise<RunningHttpServer> {
  running = await startHttpServer({
    port: 0,
    token: TOKEN,
    createServer: () =>
      createMcpServer((session, method, params) => {
        calls.push({ session, method, params });
        return Promise.resolve({ text: `#1 · ${method}`, data: null } satisfies RpcResult);
      }, 'default'),
  });
  return running;
}

function client(url: string, token = TOKEN): { client: Client; transport: StreamableHTTPClientTransport } {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  return { client: new Client({ name: 'http-test', version: '0.0.0' }), transport };
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
};

function rawPost(url: string, headers: Record<string, string>, body: unknown = INIT): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

describe('rastro mcp --http', () => {
  test('a client with the token lists the same tools as stdio and reaches the daemon', async () => {
    const server = await start();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const { client: c, transport } = client(server.url);
    await c.connect(transport);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toContain('rastro_view');
    expect(tools.map((t) => t.name)).toContain('rastro_routines');
    expect(c.getInstructions()).toMatch(/rastro_routines/);

    const result = await c.callTool({ name: 'rastro_view', arguments: { find: 'Entrar' } });
    expect((result.content as { text: string }[])[0]!.text).toBe('#1 · view');
    expect(calls[0]).toMatchObject({ session: 'default', method: 'view', params: { find: 'Entrar' } });
    expect(server.sessions()).toBe(1);
    await c.close();
  });

  test('two clients get two sessions, and closing one leaves the other working', async () => {
    const server = await start();
    const a = client(server.url);
    const b = client(server.url);
    await a.client.connect(a.transport);
    await b.client.connect(b.transport);
    expect(server.sessions()).toBe(2);
    await a.transport.terminateSession();
    await a.client.close();
    expect(server.sessions()).toBe(1);
    const result = await b.client.callTool({ name: 'rastro_history', arguments: {} });
    expect(result.isError).not.toBe(true);
    await b.client.close();
  });

  test('no token, a wrong token, or another scheme is refused with 401 before any session exists', async () => {
    const server = await start();
    const attempts: Record<string, string>[] = [{}, { authorization: 'Bearer wrong' }, { authorization: `Basic ${TOKEN}` }];
    for (const headers of attempts) {
      const res = await rawPost(server.url, headers);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
    }
    expect(server.sessions()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test('a foreign Host header (DNS rebinding) is refused even with the token', async () => {
    const server = await start();
    // fetch will not let a page set Host; node:http will.
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        server.url,
        { method: 'POST', headers: { host: `evil.example:${server.port}`, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(INIT));
    });
    expect(status).toBe(403);
  });

  test('only /mcp answers, a request without a session must be initialize, and an unknown session is 404', async () => {
    const server = await start();
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await rawPost(server.url.replace('/mcp', '/other'), auth)).status).toBe(404);
    expect((await rawPost(server.url, auth, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(400);
    expect((await rawPost(server.url, { ...auth, 'mcp-session-id': 'nope' }, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(404);
    const bad = await fetch(server.url, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{' });
    expect(bad.status).toBe(400);
  });

  test('closing the server ends every session', async () => {
    const server = await start();
    const { client: c, transport } = client(server.url);
    await c.connect(transport);
    await server.close();
    running = undefined;
    await expect(c.listTools()).rejects.toThrow();
  });
});

describe('token', () => {
  test('RASTRO_MCP_TOKEN wins and nothing is written', () => {
    process.env.RASTRO_MCP_TOKEN = '  from-env  ';
    expect(resolveToken()).toEqual({ token: 'from-env', source: 'env' });
    expect(() => statSync(tokenPath())).toThrow();
  });

  test('otherwise a new token is saved 0600 and reused on the next start', () => {
    const first = resolveToken();
    expect(first.source).toBe('new');
    expect(first.token.length).toBeGreaterThanOrEqual(40);
    expect(statSync(tokenPath()).mode & 0o777).toBe(0o600);
    expect(readFileSync(tokenPath(), 'utf8').trim()).toBe(first.token);
    const second = resolveToken();
    expect(second).toMatchObject({ token: first.token, source: 'file' });
  });

  test('loopback detection', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]']) expect(isLoopback(h)).toBe(true);
    for (const h of ['0.0.0.0', '192.168.1.5', '::']) expect(isLoopback(h)).toBe(false);
  });
});

describe('rastro mcp --http from the CLI', () => {
  const BIN = new URL('../bin/rastro.js', import.meta.url).pathname;

  async function runToExit(args: string[]): Promise<{ code: number | null; stderr: string }> {
    const { spawn } = await import('node:child_process');
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, ...args], { env: process.env });
      let stderr = '';
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stderr }));
    });
  }

  test('--host or --port without --http, and a bad port, are usage errors', async () => {
    const noHttp = await runToExit(['mcp', '--port', '9000']);
    expect(noHttp.code).not.toBe(0);
    expect(noHttp.stderr).toMatch(/need --http/);
    const badPort = await runToExit(['mcp', '--http', '--port', 'x']);
    expect(badPort.code).not.toBe(0);
    expect(badPort.stderr).toMatch(/--port expects/);
  });

  test('serves on the printed URL with the saved token, and never prints the token', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [BIN, 'mcp', '--http', '--port', '0'], { env: process.env });
    try {
      let stderr = '';
      const url = await new Promise<string>((resolve, reject) => {
        child.stderr.on('data', (c: Buffer) => {
          stderr += c.toString('utf8');
          const m = /listening on (\S+)/.exec(stderr);
          if (m && /token is in/.test(stderr)) resolve(m[1]!);
        });
        child.on('exit', (code) => reject(new Error(`exited ${code}: ${stderr}`)));
      });
      const token = readFileSync(tokenPath(), 'utf8').trim();
      expect(stderr).not.toContain(token);
      const { client: c, transport } = client(url, token);
      await c.connect(transport);
      expect((await c.listTools()).tools.length).toBeGreaterThanOrEqual(13);
      await c.close();
    } finally {
      child.kill('SIGTERM');
    }
  });
});

test('past the session cap the least recently used session is closed, not the busy one', async () => {
  running = await startHttpServer({
    port: 0,
    token: TOKEN,
    maxSessions: 2,
    createServer: () => createMcpServer(() => Promise.resolve({ text: 'ok', data: null }), 'default'),
  });
  const a = client(running.url);
  const b = client(running.url);
  const c = client(running.url);
  await a.client.connect(a.transport);
  await b.client.connect(b.transport);
  await a.client.listTools(); // a is now more recent than b
  await c.client.connect(c.transport);
  expect(running.sessions()).toBe(2);
  await expect(a.client.listTools()).resolves.toBeDefined();
  await expect(c.client.listTools()).resolves.toBeDefined();
  await expect(b.client.listTools()).rejects.toThrow();
  for (const x of [a, b, c]) await x.client.close().catch(() => undefined);
});
