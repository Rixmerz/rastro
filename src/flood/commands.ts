// `rastro flood …` and the MCP flood tools share these: start (foreground or
// detached), status, show, resume, stop, list. All of it runs in the caller's
// process; the only daemons involved are the worker sessions themselves.

import { spawn } from 'node:child_process';
import { existsSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RastroError } from '../core/types.ts';
import { ensurePrivateDir, floodDir, floodsDir } from '../core/paths.ts';
import { mapPaths, readMap, runFlood, type CallFn, type FloodOptions } from './coordinator.ts';
import { findEndpoint, findState, formatEndpoint, formatMapMd, formatState, summaryLine, type FloodLimits, type FloodMap } from './map.ts';

export const FLOOD_DEFAULTS: FloodLimits & { mdBudget: number; actionTimeoutMs: number } = {
  depth: 3,
  budget: 300,
  timeMs: 10 * 60_000,
  workers: 2,
  rate: 2,
  concurrency: 2,
  ignoreRobots: false,
  skip: [],
  include: [],
  fill: true,
  mdBudget: 4000,
  actionTimeoutMs: 5_000,
};

/** `https://www.shop.test:8080/x` → `www-shop-test`. */
export function defaultFloodName(url: string): string {
  let host = 'site';
  try {
    host = new URL(url).hostname;
  } catch {
    // keep the fallback
  }
  return host.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'site';
}

/** `90s`, `10m`, `1h`, or plain milliseconds. */
export function parseDuration(value: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value.trim());
  if (!m) throw new RastroError(`invalid duration "${value}"`, 'use 90s, 10m, 1h or milliseconds');
  const n = Number(m[1]);
  const unit = m[2] ?? 'ms';
  return Math.round(n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit]!);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pid of a flood still running under this name, if any. */
export function runningPid(name: string): number | undefined {
  const file = mapPaths(floodDir(name)).pid;
  if (!existsSync(file)) return undefined;
  const pid = Number(readFileSync(file, 'utf8').trim());
  if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return pid;
  rmSync(file, { force: true });
  return undefined;
}

/** Runs a flood in this process, holding the pid file while it runs. */
export async function runFloodHere(opts: FloodOptions, call: CallFn, log: (line: string) => void, resume?: { from?: string }): Promise<FloodMap> {
  const existing = runningPid(opts.name);
  if (existing !== undefined && existing !== process.pid) {
    throw new RastroError(`flood ${opts.name} is already running (pid ${String(existing)})`, `rastro flood stop ${opts.name}`);
  }
  ensurePrivateDir(opts.dir);
  const paths = mapPaths(opts.dir);
  writeFileSync(paths.pid, `${String(process.pid)}\n`, { mode: 0o600 });
  try {
    const previous = resume ? readMap(opts.dir) : undefined;
    return await runFlood(opts, { call, log }, previous ? { map: previous, ...(resume?.from !== undefined ? { from: resume.from } : {}) } : undefined);
  } finally {
    rmSync(paths.pid, { force: true });
  }
}

/** Starts `rastro <args>` detached, logging to the flood's directory, and
 * returns once the child is on its way. The child is the same CLI command
 * without `--detach`. */
export function detachFlood(name: string, args: string[]): { pid: number; log: string } {
  const dir = floodDir(name);
  ensurePrivateDir(dir);
  const paths = mapPaths(dir);
  const existing = runningPid(name);
  if (existing !== undefined) throw new RastroError(`flood ${name} is already running (pid ${String(existing)})`, `rastro flood stop ${name}`);
  const logFd = openSync(paths.log, 'a', 0o600);
  const bin = fileURLToPath(new URL('../../bin/rastro.js', import.meta.url));
  const child = spawn(process.execPath, [bin, ...args.filter((a) => a !== '--detach')], {
    stdio: ['ignore', logFd, logFd],
    detached: true,
    env: process.env,
  });
  child.unref();
  // Claimed now, so a status right after the start sees it running; the
  // child rewrites it with the same pid.
  writeFileSync(paths.pid, `${String(child.pid ?? 0)}\n`, { mode: 0o600 });
  return { pid: child.pid ?? 0, log: paths.log };
}

export function stopFlood(name: string): string {
  const dir = floodDir(name);
  const pid = runningPid(name);
  if (pid === undefined) return `flood ${name} is not running`;
  writeFileSync(mapPaths(dir).stop, '', { mode: 0o600 });
  return `flood ${name} (pid ${String(pid)}) stops after the actions in flight; the map keeps what is left as unexplored`;
}

export function floodStatus(name: string): { text: string; map: FloodMap; running: boolean } {
  const map = readMap(floodDir(name));
  const pid = runningPid(name);
  const running = pid !== undefined;
  const status = running ? summaryLine(map).replace(/^\S+/, 'running') : summaryLine(map);
  return { text: `${name}: ${status}\nmap: ${mapPaths(floodDir(name)).md}`, map, running };
}

export function listFloods(): { name: string; status: string; running: boolean }[] {
  const root = floodsDir();
  if (!existsSync(root)) return [];
  const out: { name: string; status: string; running: boolean }[] = [];
  for (const name of readdirSync(root).sort()) {
    if (!existsSync(mapPaths(floodDir(name)).json)) continue;
    try {
      const { map, running } = floodStatus(name);
      out.push({ name, status: running ? 'running' : map.status, running });
    } catch {
      out.push({ name, status: 'unreadable', running: false });
    }
  }
  return out;
}

/** `flood show <name>` is the map.md; with an id, one state or endpoint. */
export function showFlood(name: string, id?: string, budget?: number): { text: string; data: unknown } {
  const map = readMap(floodDir(name));
  if (id === undefined) return { text: formatMapMd(map, budget ?? FLOOD_DEFAULTS.mdBudget), data: map };
  const state = findState(map, id);
  if (state) return { text: formatState(map, state), data: state };
  const endpoint = findEndpoint(map, id);
  if (endpoint) return { text: formatEndpoint(map, endpoint), data: endpoint };
  throw new RastroError(`no state or endpoint ${id} in flood ${name}`, `rastro flood show ${name}`);
}

/** New depth for a resume: `+n` adds to the previous limit. */
export function resumeDepth(previous: number, value: string | undefined): number {
  if (value === undefined) return previous + 1;
  const rel = /^\+(\d+)$/.exec(value.trim());
  if (rel) return previous + Number(rel[1]);
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new RastroError(`invalid --depth "${value}"`, 'a level number, or +n to go n levels deeper');
  return n;
}
