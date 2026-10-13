// `rastro flood …`: the scripted crawl and its map. Runs in the CLI process,
// which coordinates the worker daemons; `--detach` hands that to a child.

import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import { RastroError } from '../core/types.ts';
import { floodDir } from '../core/paths.ts';
import { call } from '../daemon/client.ts';
import { mapPaths, readMap, type FloodOptions } from '../flood/coordinator.ts';
import { summaryLine } from '../flood/map.ts';
import {
  defaultFloodName,
  detachFlood,
  FLOOD_DEFAULTS,
  floodStatus,
  listFloods,
  parseDuration,
  resumeDepth,
  runFloodHere,
  showFlood,
  stopFlood,
} from '../flood/commands.ts';
import { UsageError, USAGE, splitList, toNumber } from './args.ts';

type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

const LIMIT_OPTIONS: ParseArgsConfig['options'] = {
  workers: { type: 'string' },
  depth: { type: 'string' },
  budget: { type: 'string' },
  time: { type: 'string' },
  rate: { type: 'string' },
  concurrency: { type: 'string' },
  skip: { type: 'string' },
  include: { type: 'string' },
  'ignore-robots': { type: 'boolean' },
  'no-fill': { type: 'boolean' },
  'md-budget': { type: 'string' },
  'quiet-ms': { type: 'string' },
  'timeout-ms': { type: 'string' },
  detach: { type: 'boolean' },
};

function sub(argv: string[], options: ParseArgsConfig['options']): { values: Values; positionals: string[] } {
  try {
    const result = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
    return { values: result.values, positionals: result.positionals };
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

function str(v: Values[string]): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function positive(v: Values[string], flag: string): number | undefined {
  const n = toNumber(str(v), flag);
  if (n !== undefined && !(n > 0)) throw new UsageError(`${flag} must be positive`);
  return n;
}

function printJson(data: unknown): void {
  console.log(JSON.stringify({ schemaVersion: 1, ok: true, data }));
}

/** Limits from flags over `base` (the defaults, or a resumed flood's own). */
function limitsFrom(values: Values, base: typeof FLOOD_DEFAULTS): typeof FLOOD_DEFAULTS {
  const time = str(values.time);
  const workers = positive(values.workers, '--workers');
  if (workers !== undefined && (!Number.isInteger(workers) || workers > 16)) throw new UsageError('--workers must be an integer from 1 to 16');
  return {
    ...base,
    depth: toNumber(str(values.depth), '--depth') ?? base.depth,
    budget: positive(values.budget, '--budget') ?? base.budget,
    timeMs: time !== undefined ? parseDuration(time) : base.timeMs,
    workers: workers ?? base.workers,
    rate: positive(values.rate, '--rate') ?? base.rate,
    concurrency: positive(values.concurrency, '--concurrency') ?? base.concurrency,
    skip: splitList(str(values.skip)) ?? base.skip,
    include: splitList(str(values.include)) ?? base.include,
    ignoreRobots: values['ignore-robots'] === true ? true : base.ignoreRobots,
    fill: values['no-fill'] === true ? false : base.fill,
    mdBudget: positive(values['md-budget'], '--md-budget') ?? base.mdBudget,
    actionTimeoutMs: positive(values['timeout-ms'], '--timeout-ms') ?? base.actionTimeoutMs,
  };
}

async function runForeground(opts: FloodOptions, json: boolean, resume?: { from?: string }): Promise<void> {
  const log = (line: string): void => {
    if (!json) console.error(line);
  };
  const map = await runFloodHere(opts, call, log, resume);
  const paths = mapPaths(opts.dir);
  if (json) {
    printJson({ name: opts.name, status: map.status, stopReason: map.stopReason ?? null, map: paths.json, md: paths.md, summary: summaryLine(map) });
    return;
  }
  console.log(`${opts.name}: ${summaryLine(map)}`);
  console.log(`map: ${paths.md}`);
  console.log(`read it: rastro flood show ${opts.name} · one item: rastro flood show ${opts.name} <S#|E#>`);
}

function detached(name: string, rawArgs: string[], json: boolean): void {
  const { pid, log } = detachFlood(name, rawArgs);
  if (json) printJson({ name, pid, log, map: mapPaths(floodDir(name)).md });
  else console.log(`flood ${name} running in the background (pid ${String(pid)})\nprogress: rastro flood status ${name} · log: ${log}\nstop: rastro flood stop ${name}`);
}

export async function runFloodCommand(session: string, args: string[], json: boolean, rawArgv: string[]): Promise<void> {
  const [first, ...rest] = args;
  switch (first) {
    case undefined:
      throw new UsageError(`usage: ${USAGE.flood ?? ''}`);
    case 'list': {
      sub(rest, {});
      const floods = listFloods();
      if (json) printJson(floods);
      else console.log(floods.length === 0 ? 'no floods yet' : floods.map((f) => `${f.name}: ${f.status}`).join('\n'));
      return;
    }
    case 'status': {
      const { positionals } = sub(rest, {});
      const names = positionals.length > 0 ? positionals : listFloods().map((f) => f.name);
      if (names.length === 0) {
        if (json) printJson([]);
        else console.log('no floods yet');
        return;
      }
      const rows = names.map((n) => floodStatus(n));
      if (json) printJson(rows.map((r) => ({ name: r.map.name, running: r.running, status: r.map.status, summary: summaryLine(r.map), stats: r.map.stats })));
      else console.log(rows.map((r) => r.text).join('\n'));
      return;
    }
    case 'show': {
      const { values, positionals } = sub(rest, { 'md-budget': { type: 'string' } });
      const name = positionals[0];
      if (name === undefined) throw new UsageError(`missing name\nusage: ${USAGE['flood show'] ?? ''}`);
      const shown = showFlood(name, positionals[1], positive(values['md-budget'], '--md-budget'));
      if (json) printJson(shown.data);
      else console.log(shown.text);
      return;
    }
    case 'stop': {
      const { positionals } = sub(rest, {});
      const name = positionals[0];
      if (name === undefined) throw new UsageError(`missing name\nusage: ${USAGE['flood stop'] ?? ''}`);
      const message = stopFlood(name);
      if (json) printJson({ name, message });
      else console.log(message);
      return;
    }
    case 'resume': {
      const { values, positionals } = sub(rest, { ...LIMIT_OPTIONS, from: { type: 'string' } });
      const name = positionals[0];
      if (name === undefined) throw new UsageError(`missing name\nusage: ${USAGE['flood resume'] ?? ''}`);
      const dir = floodDir(name);
      const previous = readMap(dir);
      const from = str(values.from);
      if (from !== undefined && !previous.states.some((s) => s.id.toLowerCase() === from.toLowerCase())) {
        throw new RastroError(`no state ${from} in flood ${name}`, `rastro flood show ${name}`);
      }
      const base = { ...FLOOD_DEFAULTS, ...previous.limits };
      const limits = limitsFrom({ ...values, depth: undefined }, base);
      limits.depth = resumeDepth(previous.limits.depth, str(values.depth));
      if (values.detach === true) {
        detached(name, rawArgv, json);
        return;
      }
      const opts: FloodOptions = { ...limits, name, url: previous.seed.url, session: previous.seed.session, dir };
      const quiet = toNumber(str(values['quiet-ms']), '--quiet-ms');
      if (quiet !== undefined) opts.quietMs = quiet;
      await runForeground(opts, json, from !== undefined ? { from } : {});
      return;
    }
    default: {
      const { values, positionals } = sub(args, { ...LIMIT_OPTIONS, name: { type: 'string' } });
      const url = positionals[0];
      if (url === undefined || positionals.length > 1) throw new UsageError(`usage: ${USAGE.flood ?? ''}`);
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('not http');
      } catch {
        throw new UsageError(`not an http(s) url: ${url}`);
      }
      const name = str(values.name) ?? defaultFloodName(url);
      const dir = floodDir(name);
      const limits = limitsFrom(values, FLOOD_DEFAULTS);
      if (values.detach === true) {
        detached(name, rawArgv, json);
        return;
      }
      const opts: FloodOptions = { ...limits, name, url, session, dir };
      const quiet = toNumber(str(values['quiet-ms']), '--quiet-ms');
      if (quiet !== undefined) opts.quietMs = quiet;
      await runForeground(opts, json);
    }
  }
}
