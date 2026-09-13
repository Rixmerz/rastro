import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { call, listSessions } from '../src/daemon/client.ts';
import { RastroError } from '../src/core/types.ts';

const FAKE_ENGINE = new URL('./helpers/fake-engine.ts', import.meta.url).pathname;

let home: string;
let runtime: string;
const openedSessions: string[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'rastro-daemon-home-'));
  runtime = mkdtempSync(join(tmpdir(), 'rastro-daemon-run-'));
  process.env.RASTRO_HOME = home;
  process.env.XDG_RUNTIME_DIR = runtime;
  process.env.RASTRO_ENGINE_MODULE = FAKE_ENGINE;
});

afterAll(async () => {
  for (const session of openedSessions) {
    try {
      await call(session, 'close', {}, { spawn: false, timeoutMs: 2000 });
    } catch {
      // Already gone — fine, this is best-effort cleanup.
    }
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(runtime, { recursive: true, force: true });
  delete process.env.RASTRO_HOME;
  delete process.env.XDG_RUNTIME_DIR;
  delete process.env.RASTRO_ENGINE_MODULE;
});

function socketPath(session: string): string {
  return join(runtime, 'rastro', `${session}.sock`);
}

function track(session: string): string {
  openedSessions.push(session);
  return session;
}

/** `close` answers before it finishes removing the socket (see design.md decision 4); poll instead of racing it. */
async function waitUntilGone(path: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`${path} was not removed in time`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('daemon lifecycle', () => {
  test('auto-spawns on first call and reuses the daemon on the second', async () => {
    const session = track('spawn-reuse');
    const first = await call(session, 'view', { a: 1 });
    expect(first.data).toEqual({ method: 'view', params: { a: 1 } });
    expect(existsSync(socketPath(session))).toBe(true);

    // Reusing an already-listening daemon never spawns: the round trip alone
    // must succeed well within the 20s spawn-wait budget.
    const start = Date.now();
    const second = await call(session, 'view', { a: 2 }, { timeoutMs: 2000 });
    expect(second.data).toEqual({ method: 'view', params: { a: 2 } });
    expect(Date.now() - start).toBeLessThan(2000);

    const sockets = readdirSync(join(runtime, 'rastro')).filter((f) => f === `${session}.sock`);
    expect(sockets).toHaveLength(1);
  });

  test('socket file is created with mode 0600', async () => {
    const session = track('socket-mode');
    await call(session, 'view', {});
    const mode = statSync(socketPath(session)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('a RastroError from the engine propagates with its hint', async () => {
    const session = track('error-hint');
    await call(session, 'view', {});
    await expect(call(session, 'goto', { url: 'x' })).rejects.toMatchObject({
      message: 'boom',
      hint: 'try again',
    });
    await expect(call(session, 'goto', { url: 'x' })).rejects.toBeInstanceOf(RastroError);
  });

  test('unknown method returns an error', async () => {
    const session = track('unknown-method');
    await expect(call(session, 'nope' as never, {})).rejects.toThrow(/unknown method nope/);
  });

  test('a stale socket file is detected and replaced', async () => {
    const session = track('stale-socket');
    const sock = socketPath(session);
    writeFileSync(sock, '');
    const result = await call(session, 'view', {});
    expect(result.data).toEqual({ method: 'view', params: {} });
    expect(existsSync(sock)).toBe(true);
  });

  test('close shuts the daemon down and removes the socket', async () => {
    const session = track('close-session');
    await call(session, 'view', {});
    expect(existsSync(socketPath(session))).toBe(true);

    const result = await call(session, 'close', {}, { spawn: false });
    expect(result.text).toBe('closed');

    await waitUntilGone(socketPath(session));

    // No spawn: an ENOENT/ECONNREFUSED here proves the daemon is gone, not
    // merely that the round trip hasn't happened yet.
    await expect(call(session, 'view', {}, { spawn: false, timeoutMs: 2000 })).rejects.toThrow();
  });

  test('the daemon exits after its idle timeout', async () => {
    // RASTRO_IDLE_MS is read by the daemon process at spawn time (it is a
    // separate `node` process launched by call()), so setting it here only
    // affects daemons spawned after this point.
    const session = track('idle-timeout');
    process.env.RASTRO_IDLE_MS = '300';
    await call(session, 'view', {});
    delete process.env.RASTRO_IDLE_MS;
    expect(existsSync(socketPath(session))).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(existsSync(socketPath(session))).toBe(false);
  });

  test('status lists sessions with liveness and cleans up dead sockets', async () => {
    const session = track('status-session');
    await call(session, 'view', {});
    const before = await listSessions();
    expect(before.find((s) => s.session === session)).toEqual({ session, alive: true });

    await call(session, 'close', {}, { spawn: false });
    await waitUntilGone(socketPath(session));
    const after = await listSessions();
    expect(after.find((s) => s.session === session)).toBeUndefined();
  });
});
