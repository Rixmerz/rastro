// MCP server: exposes the daemon's RPC methods as tools over stdio, for
// agents that speak MCP instead of the CLI.

import { extname, basename, join } from 'node:path';
import { writeFileSync, chmodSync } from 'node:fs';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { call } from '../daemon/client.ts';
import { RastroError } from '../core/types.ts';
import type { RpcMethod, RpcResult } from '../core/types.ts';
import { ensurePrivateDir, sessionPaths } from '../core/paths.ts';

type CallFn = (session: string, method: RpcMethod, params: Record<string, unknown>) => Promise<RpcResult>;

const MAX_INLINE_BYTES = 4096;

const ACT_KINDS = ['click', 'dblclick', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'hover', 'scroll', 'upload'] as const;
const NAVIGATE_TO = ['goto', 'back', 'forward', 'reload'] as const;
const EXPORT_FORMATS = ['har', 'perfetto', 'pw-trace'] as const;

const sessionField = z.string().optional().describe('Session to target (defaults to the server session or "default").');

function resolveSession(input: { session?: string }, defaultSession: string): string {
  return input.session ?? defaultSession;
}

// S10 (CWE-697): an empty string in an allowlist array matches unintended
// hosts/paths downstream (the engine's own guard rejects it, but the MCP
// tool should never forward one in the first place).
function dropEmpty(values: string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  return values.filter((v) => v.length > 0);
}

function mimeTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.har':
    case '.json':
      return 'application/json';
    case '.png':
      return 'image/png';
    case '.txt':
      return 'text/plain';
    case '.zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}

function resourceLink(path: string): { type: 'resource_link'; uri: string; name: string; mimeType: string } {
  return { type: 'resource_link', uri: `file://${path}`, name: basename(path), mimeType: mimeTypeFor(path) };
}

/** Writes `text` under the session's out dir (mode 0600) and returns the path. */
function spillToFile(session: string, tool: string, text: string): string {
  const paths = sessionPaths(session);
  ensurePrivateDir(paths.out);
  const fileName = `${tool}-${new Date().toISOString().replace(/:/g, '-')}.txt`;
  const filePath = join(paths.out, fileName);
  writeFileSync(filePath, text, { mode: 0o600 });
  chmodSync(filePath, 0o600);
  return filePath;
}

/** Builds the tool result content: text (truncated to a file past 4 KB) plus resource_links for `result.files`. */
function buildContent(session: string, tool: string, result: RpcResult): CallToolResult['content'] {
  const content: CallToolResult['content'] = [];
  const bytes = Buffer.byteLength(result.text, 'utf8');
  if (bytes <= MAX_INLINE_BYTES) {
    content.push({ type: 'text', text: result.text });
  } else {
    const lines = result.text.split('\n');
    const filePath = spillToFile(session, tool, result.text);
    const preview = lines.slice(0, 20).join('\n');
    content.push({ type: 'text', text: `${preview}\n... output truncated, full text written to ${filePath} (${lines.length} lines)` });
    content.push(resourceLink(filePath));
  }
  for (const file of result.files ?? []) {
    content.push(resourceLink(file));
  }
  return content;
}

function errorResult(err: unknown): CallToolResult {
  if (err instanceof RastroError) {
    const text = err.hint === undefined ? `error: ${err.message}` : `error: ${err.message}\nhint: ${err.hint}`;
    return { content: [{ type: 'text', text }], isError: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `error: ${message}` }], isError: true };
}

export function createMcpServer(callFn: CallFn = call, defaultSession = process.env.RASTRO_SESSION ?? 'default'): McpServer {
  const server = new McpServer({ name: 'rastro', version: '0.1.0' });

  function register(
    name: string,
    description: string,
    shape: Record<string, z.ZodTypeAny>,
    toDispatch: (args: Record<string, unknown>) => { method: RpcMethod; params: Record<string, unknown> },
  ): void {
    server.registerTool(name, { description, inputSchema: { ...shape, session: sessionField } }, async (args) => {
      const session = resolveSession(args as { session?: string }, defaultSession);
      try {
        const { method, params } = toDispatch(args as Record<string, unknown>);
        const result = await callFn(session, method, params);
        return { content: buildContent(session, name, result) };
      } catch (err) {
        return errorResult(err);
      }
    });
  }

  register(
    'rastro_open',
    'Opens the browser session, optionally navigating to a URL.',
    {
      url: z.string().optional(),
      allowWrite: z.array(z.string()).optional(),
      allowUpload: z.array(z.string()).optional(),
      headed: z.boolean().optional(),
    },
    (a) => ({
      method: 'open',
      params: {
        url: a.url,
        allowWrite: dropEmpty(a.allowWrite as string[] | undefined),
        allowUpload: dropEmpty(a.allowUpload as string[] | undefined),
        headed: a.headed,
      },
    }),
  );

  register(
    'rastro_view',
    'Views the current page as a minimal accessibility tree, optionally filtered.',
    { region: z.string().optional(), find: z.string().optional(), urls: z.boolean().optional() },
    (a) => ({ method: 'view', params: { region: a.region, find: a.find, urls: a.urls } }),
  );

  register(
    'rastro_act',
    'Performs an action (click, fill, type, etc.) on an element referenced by ref.',
    { ref: z.string(), kind: z.enum(ACT_KINDS), value: z.string().optional(), secret: z.boolean().optional() },
    (a) => ({ method: 'act', params: { ref: a.ref, kind: a.kind, value: a.value, secret: a.secret } }),
  );

  register(
    'rastro_navigate',
    'Navigates the current tab: go to a URL, or go back, forward, or reload.',
    { to: z.enum(NAVIGATE_TO), url: z.string().optional() },
    (a) => ({ method: a.to as RpcMethod, params: { url: a.url } }),
  );

  register(
    'rastro_effects',
    'Summarizes the network and DOM effects caused by an action.',
    { action: z.number(), all: z.boolean().optional() },
    (a) => ({ method: 'effects', params: { action: a.action, all: a.all } }),
  );

  register(
    'rastro_trace',
    'Lists trace events, optionally scoped to an action, time, type, or background bucket.',
    {
      action: z.number().optional(),
      since: z.number().optional(),
      type: z.array(z.string()).optional(),
      bg: z.boolean().optional(),
      limit: z.number().optional(),
    },
    (a) => ({ method: 'trace', params: { action: a.action, since: a.since, type: a.type, bg: a.bg, limit: a.limit } }),
  );

  register(
    'rastro_request',
    'Shows details of a captured network request by id.',
    { id: z.string(), body: z.boolean().optional(), curl: z.boolean().optional() },
    (a) => ({ method: 'request', params: { id: a.id, body: a.body, curl: a.curl } }),
  );

  register(
    'rastro_history',
    'Lists recorded actions in the current session.',
    { limit: z.number().optional() },
    (a) => ({ method: 'history', params: { limit: a.limit } }),
  );

  register(
    'rastro_detail',
    'Shows full detail for an element referenced by ref.',
    { ref: z.string() },
    (a) => ({ method: 'detail', params: { ref: a.ref } }),
  );

  register(
    'rastro_export',
    'Exports the session trace as a HAR, Perfetto, or Playwright trace file.',
    { format: z.enum(EXPORT_FORMATS) },
    (a) => ({ method: 'export', params: { format: a.format } }),
  );

  return server;
}

export async function runMcpServer(opts?: { session?: string }): Promise<void> {
  const server = createMcpServer(call, opts?.session ?? process.env.RASTRO_SESSION ?? 'default');
  await server.connect(new StdioServerTransport());
}
