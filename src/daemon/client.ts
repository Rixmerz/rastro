// CLI/MCP-facing client: connects to a session's daemon socket, auto-spawning
// the daemon on first use and retrying once if the socket was stale.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, openSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RastroError } from '../core/types.ts';
import type { RpcMethod, RpcResponse, RpcResult } from '../core/types.ts';
import { assertSocketPathFits, ensurePrivateDir, runtimeDir, sessionPaths } from '../core/paths.ts';

export interface CallOptions {
  /** Set to false to fail instead of spawning a daemon (used by `close`, `status`). */
  spawn?: boolean;
  timeoutMs?: number;
}

let nextId = 1;


function defaultCallTimeoutMs(): number {
  return Number(process.env.RASTRO_CALL_TIMEOUT_MS) || 120_000;
}

function daemonMainPath(): string {
  const ext = import.meta.filename.endsWith('.ts') ? '.ts' : '.js';
  return fileURLToPath(new URL(`./main${ext}`, import.meta.url));
}

/** One request/response round trip over an already-open socket. */
function roundTrip(socketPath: string, method: RpcMethod, params: Record<string, unknown>, timeoutMs: number): Promise<RpcResult> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const id = nextId++;
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out waiting for ${method} after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      clearTimeout(timer);
      const line = buffer.slice(0, newline);
      socket.end();
      let response: RpcResponse;
      try {
        response = JSON.parse(line) as RpcResponse;
      } catch (err) {
        reject(new Error(`invalid daemon response: ${String(err)}`));
        return;
      }
      if (response.ok) {
        resolve(response.result);
      } else {
        reject(new RastroError(response.error.message, response.error.hint));
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForReady(child: ChildProcess, logPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new RastroError('daemon did not become ready in time', `see ${logPath}`));
    }, 20_000);
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new RastroError(`daemon exited before becoming ready (code ${String(code)})`, `see ${logPath}`));
    });
  });
}

async function spawnDaemon(session: string): Promise<void> {
  const paths = sessionPaths(session);
  ensurePrivateDir(paths.root);
  const logFd = openSync(`${paths.root}/daemon.log`, 'a');
  const child = spawn(process.execPath, [daemonMainPath(), session], {
    stdio: ['ignore', 'pipe', logFd],
    detached: true,
    env: process.env,
  });
  try {
    await waitForReady(child, `${paths.root}/daemon.log`);
  } finally {
    child.stdout?.removeAllListeners('data');
    child.stdout?.destroy();
    child.unref();
  }
}

/** Calls `method` on `session`'s daemon, spawning it first if needed. */
export async function call(
  session: string,
  method: RpcMethod,
  params: Record<string, unknown>,
  opts: CallOptions = {},
): Promise<RpcResult> {
  const paths = sessionPaths(session);
  assertSocketPathFits(paths.socket);
  const timeoutMs = opts.timeoutMs ?? defaultCallTimeoutMs();
  const allowSpawn = opts.spawn !== false;

  try {
    return await roundTrip(paths.socket, method, params, timeoutMs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!allowSpawn || (code !== 'ENOENT' && code !== 'ECONNREFUSED')) {
      throw err;
    }
    if (existsSync(paths.socket)) {
      rmSync(paths.socket, { force: true });
    }
    await spawnDaemon(session);
    return roundTrip(paths.socket, method, params, timeoutMs);
  }
}

export type SessionState = 'running' | 'busy' | 'stopped';

/**
 * Lists sessions with a socket, pinging each without spawning.
 *
 * A timeout is NOT death. The daemon serialises requests, so anything slow —
 * a navigation, a flow, a 9-second XHR — leaves `status` waiting, and treating
 * that as dead used to delete the socket of a perfectly healthy daemon. The
 * next command then found no socket, spawned a second daemon on the same
 * browser profile, and the first was orphaned with its Chromium still open:
 * exactly the zombie this function was supposed to report on. Only a refused
 * or absent socket means nobody is listening, and only then is it cleaned up.
 */
export async function listSessions(): Promise<{ session: string; state: SessionState }[]> {
  const dir = runtimeDir();
  if (!existsSync(dir)) return [];
  const sockets = readdirSync(dir).filter((f) => f.endsWith('.sock'));
  const results: { session: string; state: SessionState }[] = [];
  for (const file of sockets) {
    const session = file.slice(0, -'.sock'.length);
    try {
      await call(session, 'status', {}, { spawn: false, timeoutMs: 2_000 });
      results.push({ session, state: 'running' });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ECONNREFUSED') {
        rmSync(sessionPaths(session).socket, { force: true });
        results.push({ session, state: 'stopped' });
      } else {
        results.push({ session, state: 'busy' });
      }
    }
  }
  return results;
}
