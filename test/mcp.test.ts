import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.ts';
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
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.RASTRO_HOME;
});

describe('tool listing', () => {
  test('lists all 10 tools with short descriptions', async () => {
    const { client } = await connect(() => Promise.resolve({ text: 'ok', data: null }));
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(10);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'rastro_open',
        'rastro_view',
        'rastro_act',
        'rastro_navigate',
        'rastro_effects',
        'rastro_trace',
        'rastro_request',
        'rastro_history',
        'rastro_detail',
        'rastro_export',
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.description).toBeDefined();
      expect(tool.description!.length).toBeLessThanOrEqual(160);
    }
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
