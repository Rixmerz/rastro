// Unix-socket JSON-RPC server for a single session's daemon. One request is
// processed at a time so actions never interleave; idle timeout and
// SIGTERM/SIGINT shut the engine down and remove the socket.

import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { appendFileSync, chmodSync, rmSync, writeFileSync } from 'node:fs';
import type { Engine, RpcRequest, RpcResponse, RpcResult } from '../core/types.ts';
import { RastroError } from '../core/types.ts';
import { assertSocketPathFits, ensurePrivateDir, runtimeDir, sessionPaths } from '../core/paths.ts';

export interface RunDaemonOptions {
  idleMs?: number;
  /** Called once the socket is listening, before any request is handled. */
  onListening?: () => void;
}

function defaultIdleMs(): number {
  return Number(process.env.RASTRO_IDLE_MS) || 3_600_000;
}


function logLine(logPath: string, line: string): void {
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging is best-effort; a failed write here must not crash the daemon.
  }
}

function toResponse(id: number, result: RpcResult): RpcResponse {
  return { id, ok: true, result };
}

function errorResponse(id: number, err: unknown): RpcResponse {
  if (err instanceof RastroError) {
    return { id, ok: false, error: { message: err.message, hint: err.hint } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { id, ok: false, error: { message } };
}

/**
 * Runs the daemon for `session` until idle timeout, `close`, or a termination
 * signal. Resolves once the socket is removed and the engine is shut down.
 */
export async function runDaemon(
  session: string,
  engine: Engine & { shutdown(): Promise<void> },
  opts: RunDaemonOptions = {},
): Promise<void> {
  const paths = sessionPaths(session);
  assertSocketPathFits(paths.socket);
  const idleMs = opts.idleMs ?? defaultIdleMs();
  const logPath = `${paths.root}/daemon.log`;

  ensurePrivateDir(paths.root);
  ensurePrivateDir(runtimeDir());
  rmSync(paths.socket, { force: true });

  // The pid is what makes a wedged daemon manageable: a socket that nobody
  // answers says nothing about whether a process is still holding a browser.
  writeFileSync(paths.pid, `${String(process.pid)}\n`, { mode: 0o600 });
  // And this is what makes it findable in `ps` without decoding an argv.
  process.title = `rastro[${session}]`;

  let idleTimer: ReturnType<typeof setTimeout>;
  let queue = Promise.resolve();
  let shuttingDown = false;

  await new Promise<void>((resolveListen, rejectListen) => {
    const server: Server = createServer((socket: Socket) => {
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (line.trim().length > 0) {
            handleLine(line, socket);
          }
        }
      });
      socket.on('error', (err) => logLine(logPath, `socket error: ${String(err)}`));
    });

    function handleLine(line: string, socket: Socket): void {
      resetIdle();
      queue = queue.then(async () => {
        let request: RpcRequest;
        try {
          request = JSON.parse(line) as RpcRequest;
        } catch (err) {
          logLine(logPath, `bad request: ${String(err)}`);
          return;
        }
        let response: RpcResponse;
        try {
          if (request.method === 'close') {
            const result = await engine.close(request.params);
            response = toResponse(request.id, result);
            socket.write(`${JSON.stringify(response)}\n`);
            // engine.close() already shut the engine itself down (R17) — the
            // daemon only has its own socket/timers left to tear down.
            await shutdown({ engineAlreadyShutDown: true });
            return;
          }
          const fn = engine[request.method as keyof Engine] as
            | ((params: Record<string, unknown>) => Promise<RpcResult>)
            | undefined;
          if (typeof fn !== 'function') {
            response = { id: request.id, ok: false, error: { message: `unknown method ${request.method}` } };
          } else {
            const result = await fn.call(engine, request.params);
            response = toResponse(request.id, result);
          }
        } catch (err) {
          response = errorResponse(request.id, err);
          logLine(logPath, `error handling ${request.method}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        }
        socket.write(`${JSON.stringify(response)}\n`);
      });
    }

    function resetIdle(): void {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        void onIdle();
      }, idleMs);
    }

    // R14: a human `record start` can sit quiet for the whole idle window —
    // check the engine for an open session before exiting, and reschedule
    // instead of tearing the daemon down under it.
    async function onIdle(): Promise<void> {
      try {
        const result = await engine.status({});
        const data = result.data as { open?: boolean } | null | undefined;
        if (data?.open) {
          resetIdle();
          return;
        }
      } catch (err) {
        logLine(logPath, `idle status check failed: ${String(err)}`);
      }
      await shutdown();
    }

    async function shutdown(opts: { engineAlreadyShutDown?: boolean } = {}): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      clearTimeout(idleTimer);
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      server.close();
      rmSync(paths.socket, { force: true });
      rmSync(paths.pid, { force: true });
      // R17: engine.close() (the RPC method) already shut the engine down;
      // calling engine.shutdown() again here hit an already-closed database.
      if (!opts.engineAlreadyShutDown) {
        try {
          await engine.shutdown();
        } catch (err) {
          logLine(logPath, `shutdown error: ${String(err)}`);
        }
      }
      resolveListen();
    }

    function onSignal(): void {
      void shutdown();
    }

    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);

    server.on('error', rejectListen);
    server.listen(paths.socket, () => {
      chmodSync(paths.socket, 0o600);
      resetIdle();
      opts.onListening?.();
    });
  });
}
