// Streamable HTTP transport for `rastro mcp --http`: the same tools as stdio,
// for MCP clients that connect to a URL instead of spawning a process.
//
// The server drives the user's own browser profile, so it is never open:
// every request carries a bearer token, it binds to loopback unless told
// otherwise, and on loopback the Host header is checked against DNS rebinding.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { ensurePrivateDir, rastroHome } from '../core/paths.ts';

export const MCP_PATH = '/mcp';
export const DEFAULT_HTTP_PORT = 7713;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** A client that goes away without ending its session leaves a server and its
 * routine watchers behind; past this many, the least recently used is closed
 * (its client gets a 404 and initializes again, as the protocol expects). */
export const MAX_SESSIONS = 32;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export interface HttpServerOptions {
  host?: string;
  port?: number;
  /** Bearer token clients must send. */
  token: string;
  /** Builds the MCP server of one client session. */
  createServer: () => McpServer;
  /** Runs once per session after its server connects (the routine watcher). */
  onSession?: (server: McpServer) => void;
  /** Runs when a session's transport closes. */
  onSessionClosed?: (server: McpServer) => void;
  /** `MAX_SESSIONS` by default. */
  maxSessions?: number;
}

export interface RunningHttpServer {
  url: string;
  port: number;
  sessions(): number;
  close(): Promise<void>;
}

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host.replace(/^\[|\]$/g, ''));
}

/** Where the generated token lives when `RASTRO_MCP_TOKEN` is not set. */
export function tokenPath(): string {
  return join(rastroHome(), 'mcp-http.token');
}

/**
 * `RASTRO_MCP_TOKEN` when set; otherwise the token saved by an earlier run, so
 * a client's configuration survives a restart; otherwise a new one, saved 0600.
 */
export function resolveToken(): { token: string; source: 'env' | 'file' | 'new'; path?: string } {
  const env = process.env.RASTRO_MCP_TOKEN;
  if (env !== undefined && env.trim() !== '') return { token: env.trim(), source: 'env' };
  const path = tokenPath();
  if (existsSync(path)) {
    const saved = readFileSync(path, 'utf8').trim();
    if (saved.length > 0) return { token: saved, source: 'file', path };
  }
  ensurePrivateDir(rastroHome());
  const token = randomBytes(32).toString('base64url');
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { token, source: 'new', path };
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const given = Buffer.from(match[1]!, 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function sendError(res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

class BodyTooLarge extends Error {}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text.length === 0 ? undefined : JSON.parse(text));
      } catch {
        reject(new SyntaxError('body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

function hostsFor(host: string, port: number): string[] {
  const names = isLoopback(host) ? ['127.0.0.1', 'localhost', '[::1]'] : [host.includes(':') ? `[${host}]` : host];
  // A client leaves the default port out of the Host header.
  return port === 80 ? [...names, ...names.map((h) => `${h}:80`)] : names.map((h) => `${h}:${port}`);
}

/** Starts the HTTP server; resolves once it listens. */
export async function startHttpServer(opts: HttpServerOptions): Promise<RunningHttpServer> {
  const host = opts.host ?? '127.0.0.1';
  const maxSessions = opts.maxSessions ?? MAX_SESSIONS;
  // Insertion order doubles as recency: a session is re-inserted on every use.
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();
  let allowedHosts: string[] = [];

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://rastro');
    if (url.pathname !== MCP_PATH) return sendError(res, 404, `not found: the MCP endpoint is ${MCP_PATH}`);
    // Before the token: a rebinding page must not even learn the endpoint exists.
    if (isLoopback(host) && !allowedHosts.includes(req.headers.host ?? '')) {
      return sendError(res, 403, 'invalid Host header');
    }
    if (!authorized(req, opts.token)) {
      return sendError(res, 401, 'missing or wrong bearer token', { 'www-authenticate': 'Bearer' });
    }

    let body: unknown;
    if (req.method === 'POST') {
      try {
        body = await readJson(req);
      } catch (err) {
        return sendError(res, err instanceof BodyTooLarge ? 413 : 400, err instanceof BodyTooLarge ? 'body too large' : 'body is not JSON');
      }
    }

    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (existing) {
      sessions.delete(sessionId as string);
      sessions.set(sessionId as string, existing);
      await existing.transport.handleRequest(req, res, body);
      return;
    }
    if (typeof sessionId === 'string') return sendError(res, 404, 'unknown session: initialize again');
    if (req.method !== 'POST' || !isInitializeRequest(body)) {
      return sendError(res, 400, 'no session: the first request must be initialize');
    }

    while (sessions.size >= maxSessions) {
      const [oldest] = sessions.values();
      if (oldest === undefined) break;
      // onclose removes it from the map.
      await oldest.transport.close().catch(() => undefined);
      if (sessions.size >= maxSessions && oldest.transport.sessionId !== undefined) sessions.delete(oldest.transport.sessionId);
    }
    const server = opts.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server });
        opts.onSession?.(server);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id !== undefined && sessions.delete(id)) opts.onSessionClosed?.(server);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const http: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      sendError(res, 500, err instanceof Error ? err.message : String(err));
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen({ host, port: opts.port ?? DEFAULT_HTTP_PORT }, () => {
      http.off('error', reject);
      resolve();
    });
  });
  const address = http.address();
  if (address === null || typeof address === 'string') throw new Error('mcp http server did not bind to a port');
  allowedHosts = hostsFor(host, address.port);
  const shown = host.includes(':') ? `[${host}]` : host;

  return {
    url: `http://${shown}:${address.port}${MCP_PATH}`,
    port: address.port,
    sessions: () => sessions.size,
    close: async () => {
      for (const { transport } of [...sessions.values()]) await transport.close().catch(() => undefined);
      sessions.clear();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
