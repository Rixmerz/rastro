#!/usr/bin/env node
// CLI entry point. Parses argv, calls the daemon, and applies the output
// contract (text vs --json, >4 KB spills to a file).

import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { RastroError } from '../core/types.ts';
import type { RpcMethod } from '../core/types.ts';
import { call, listSessions } from '../daemon/client.ts';
import { ensurePrivateDir, sessionPaths } from '../core/paths.ts';
import {
  UsageError,
  USAGE,
  TOP_LEVEL_HELP,
  parseGlobalFlags,
  parseKeyValues,
  resolvePath,
  splitList,
  toNumber,
} from './args.ts';
import type { Dispatch } from './args.ts';
import { VERSION } from '../version.ts';

const MAX_INLINE_BYTES = 4096;

function sub(argv: string[], options: ParseArgsConfig['options']): { values: Record<string, string | boolean | (string | boolean)[] | undefined>; positionals: string[] } {
  try {
    const result = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
    return { values: result.values, positionals: result.positionals };
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

function str(v: string | boolean | (string | boolean)[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function bool(v: string | boolean | (string | boolean)[] | undefined): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function list(v: string | boolean | (string | boolean)[] | undefined): string[] {
  if (v === undefined) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.filter((x): x is string => typeof x === 'string');
}

function requirePositional(positionals: string[], index: number, name: string, usage: string): string {
  const value = positionals[index];
  if (value === undefined) throw new UsageError(`missing ${name}\nusage: ${usage}`);
  return value;
}

/** Maps one CLI command + its remaining args to an RPC method and params. */
function dispatch(command: string, argv: string[]): Dispatch {
  switch (command) {
    case 'open': {
      const { values, positionals } = sub(argv, {
        headed: { type: 'boolean' },
        'allow-write': { type: 'string' },
        dialogs: { type: 'string' },
        'pw-trace': { type: 'boolean' },
        'quiet-ms': { type: 'string' },
        'max-window-ms': { type: 'string' },
        'timeout-ms': { type: 'string' },
      });
      return {
        method: 'open',
        params: {
          url: positionals[0],
          headed: bool(values.headed),
          allowWrite: splitList(str(values['allow-write'])),
          dialogs: str(values.dialogs),
          pwTrace: bool(values['pw-trace']),
          quietMs: toNumber(str(values['quiet-ms']), '--quiet-ms'),
          maxWindowMs: toNumber(str(values['max-window-ms']), '--max-window-ms'),
          timeoutMs: toNumber(str(values['timeout-ms']), '--timeout-ms'),
        },
      };
    }
    case 'goto': {
      const { positionals } = sub(argv, {});
      return { method: 'goto', params: { url: requirePositional(positionals, 0, 'url', USAGE.goto ?? '') } };
    }
    case 'back':
    case 'forward':
    case 'reload':
      sub(argv, {});
      return { method: command, params: {} };
    case 'view': {
      const { values } = sub(argv, {
        region: { type: 'string' },
        all: { type: 'boolean' },
        urls: { type: 'boolean' },
        find: { type: 'string' },
      });
      return {
        method: 'view',
        params: { region: str(values.region), all: bool(values.all), urls: bool(values.urls), find: str(values.find) },
      };
    }
    case 'act': {
      const { values, positionals } = sub(argv, { secret: { type: 'boolean' } });
      const ref = requirePositional(positionals, 0, 'ref', USAGE.act ?? '');
      const kind = requirePositional(positionals, 1, 'kind', USAGE.act ?? '');
      return { method: 'act', params: { ref, kind, value: positionals[2], secret: bool(values.secret) } };
    }
    case 'click':
    case 'dblclick':
    case 'check':
    case 'uncheck':
    case 'hover': {
      const { positionals } = sub(argv, {});
      const ref = requirePositional(positionals, 0, 'ref', USAGE[command] ?? '');
      return { method: 'act', params: { ref, kind: command } };
    }
    case 'fill':
    case 'type': {
      const { values, positionals } = sub(argv, { secret: { type: 'boolean' } });
      const ref = requirePositional(positionals, 0, 'ref', USAGE[command] ?? '');
      return { method: 'act', params: { ref, kind: command, value: positionals[1], secret: bool(values.secret) } };
    }
    case 'select': {
      const { positionals } = sub(argv, {});
      const ref = requirePositional(positionals, 0, 'ref', USAGE.select ?? '');
      const value = requirePositional(positionals, 1, 'value', USAGE.select ?? '');
      return { method: 'act', params: { ref, kind: 'select', value } };
    }
    case 'press': {
      const { positionals } = sub(argv, {});
      const ref = requirePositional(positionals, 0, 'ref', USAGE.press ?? '');
      const key = requirePositional(positionals, 1, 'key', USAGE.press ?? '');
      return { method: 'act', params: { ref, kind: 'press', value: key } };
    }
    case 'scroll': {
      const { positionals } = sub(argv, {});
      const ref = requirePositional(positionals, 0, 'ref', USAGE.scroll ?? '');
      return { method: 'act', params: { ref, kind: 'scroll', value: positionals[1] } };
    }
    case 'upload': {
      const { positionals } = sub(argv, {});
      const ref = requirePositional(positionals, 0, 'ref', USAGE.upload ?? '');
      const file = requirePositional(positionals, 1, 'file', USAGE.upload ?? '');
      return { method: 'act', params: { ref, kind: 'upload', value: resolvePath(file) } };
    }
    case 'detail': {
      const { positionals } = sub(argv, {});
      return { method: 'detail', params: { ref: requirePositional(positionals, 0, 'ref', USAGE.detail ?? '') } };
    }
    case 'history': {
      const { values } = sub(argv, {
        limit: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
      });
      return {
        method: 'history',
        params: {
          limit: toNumber(str(values.limit), '--limit'),
          from: toNumber(str(values.from), '--from'),
          to: toNumber(str(values.to), '--to'),
        },
      };
    }
    case 'effects': {
      const { values, positionals } = sub(argv, { all: { type: 'boolean' } });
      const id = requirePositional(positionals, 0, 'id', USAGE.effects ?? '');
      return { method: 'effects', params: { action: toNumber(id, 'id'), all: bool(values.all) } };
    }
    case 'trace': {
      const { values } = sub(argv, {
        action: { type: 'string' },
        since: { type: 'string' },
        type: { type: 'string' },
        bg: { type: 'boolean' },
        limit: { type: 'string' },
      });
      return {
        method: 'trace',
        params: {
          action: toNumber(str(values.action), '--action'),
          since: toNumber(str(values.since), '--since'),
          type: splitList(str(values.type)),
          bg: bool(values.bg),
          limit: toNumber(str(values.limit), '--limit'),
        },
      };
    }
    case 'request': {
      const { values, positionals } = sub(argv, {
        body: { type: 'boolean' },
        full: { type: 'boolean' },
        curl: { type: 'boolean' },
        reveal: { type: 'boolean' },
      });
      const id = requirePositional(positionals, 0, 'id', USAGE.request ?? '');
      return {
        method: 'request',
        params: { id, body: bool(values.body), full: bool(values.full), curl: bool(values.curl), reveal: bool(values.reveal) },
      };
    }
    case 'snapshot': {
      const { values, positionals } = sub(argv, { before: { type: 'boolean' }, after: { type: 'boolean' } });
      const id = requirePositional(positionals, 0, 'id', USAGE.snapshot ?? '');
      const phase = bool(values.before) ? 'before' : 'after';
      return { method: 'snapshot', params: { action: toNumber(id, 'id'), phase } };
    }
    case 'screenshot': {
      const { values, positionals } = sub(argv, { full: { type: 'boolean' } });
      return {
        method: 'screenshot',
        params: { path: positionals[0] === undefined ? undefined : resolvePath(positionals[0]), full: bool(values.full) },
      };
    }
    case 'console': {
      const { values } = sub(argv, { errors: { type: 'boolean' }, limit: { type: 'string' } });
      return { method: 'console', params: { errors: bool(values.errors), limit: toNumber(str(values.limit), '--limit') } };
    }
    case 'cookies':
    case 'storage': {
      const { values } = sub(argv, { reveal: { type: 'boolean' } });
      return { method: command, params: { reveal: bool(values.reveal) } };
    }
    case 'tabs': {
      const { values } = sub(argv, { select: { type: 'string' }, close: { type: 'string' } });
      return { method: 'tabs', params: { select: str(values.select), close: str(values.close) } };
    }
    case 'eval': {
      const { values, positionals } = sub(argv, { ref: { type: 'string' } });
      const expr = requirePositional(positionals, 0, 'expr', USAGE.eval ?? '');
      return { method: 'eval', params: { expr, ref: str(values.ref) } };
    }
    case 'replay': {
      const { values, positionals } = sub(argv, { yes: { type: 'boolean' } });
      const id = requirePositional(positionals, 0, 'requestId', USAGE.replay ?? '');
      return { method: 'replay', params: { id, yes: bool(values.yes) } };
    }
    case 'export': {
      const { values, positionals } = sub(argv, { bodies: { type: 'boolean' } });
      const format = requirePositional(positionals, 0, 'format', USAGE.export ?? '');
      return {
        method: 'export',
        params: {
          format,
          path: positionals[1] === undefined ? undefined : resolvePath(positionals[1]),
          bodies: bool(values.bodies),
        },
      };
    }
    default:
      throw new UsageError(`unknown command "${command}"\n\n${TOP_LEVEL_HELP}`);
  }
}

function dispatchRecord(sub_: string, argv: string[]): Dispatch {
  if (sub_ === 'start') {
    const { values, positionals } = sub(argv, {
      continue: { type: 'string' },
      at: { type: 'string' },
    });
    return {
      method: 'recordStart',
      params: { url: positionals[0], continue: str(values.continue), at: toNumber(str(values.at), '--at') },
    };
  }
  if (sub_ === 'stop') {
    const { values } = sub(argv, { save: { type: 'string' } });
    const save = str(values.save);
    return { method: 'recordStop', params: { save: save === undefined ? undefined : resolvePath(save) } };
  }
  throw new UsageError(`unknown "record ${sub_}"\nusage: ${USAGE['record start']}\n       ${USAGE['record stop']}`);
}

function dispatchFlow(sub_: string, argv: string[]): Dispatch {
  if (sub_ === 'save') {
    const { values, positionals } = sub(argv, {
      from: { type: 'string' },
      to: { type: 'string' },
      name: { type: 'string' },
    });
    const file = requirePositional(positionals, 0, 'file', USAGE['flow save'] ?? '');
    return {
      method: 'flowSave',
      params: {
        file: resolvePath(file),
        from: toNumber(str(values.from), '--from'),
        to: toNumber(str(values.to), '--to'),
        name: str(values.name),
      },
    };
  }
  if (sub_ === 'run') {
    const { values, positionals } = sub(argv, {
      from: { type: 'string' },
      param: { type: 'string', multiple: true },
    });
    const file = requirePositional(positionals, 0, 'file', USAGE['flow run'] ?? '');
    return {
      method: 'flowRun',
      params: {
        file: resolvePath(file),
        from: toNumber(str(values.from), '--from'),
        params: parseKeyValues(list(values.param), '--param'),
      },
    };
  }
  if (sub_ === 'export') {
    const { values, positionals } = sub(argv, { out: { type: 'string' }, playwright: { type: 'boolean' } });
    const file = requirePositional(positionals, 0, 'file', USAGE['flow export'] ?? '');
    const out = str(values.out);
    return {
      method: 'flowExport',
      params: { file: resolvePath(file), out: out === undefined ? undefined : resolvePath(out), format: 'playwright' },
    };
  }
  if (sub_ === 'import') {
    const { positionals } = sub(argv, {});
    const file = requirePositional(positionals, 0, 'chrome.json', USAGE['flow import'] ?? '');
    const out = requirePositional(positionals, 1, 'out.yaml', USAGE['flow import'] ?? '');
    return { method: 'flowImport', params: { file: resolvePath(file), out: resolvePath(out) } };
  }
  throw new UsageError(`unknown "flow ${sub_}"`);
}

function printError(err: unknown): number {
  if (err instanceof UsageError) {
    console.error(`error: ${err.message}`);
    return 2;
  }
  if (err instanceof RastroError) {
    console.error(`error: ${err.message}`);
    if (err.hint) console.error(`hint: ${err.hint}`);
    return 1;
  }
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  return 1;
}

/** Applies the output contract: text vs --json, and the 4 KB spill-to-file rule. */
function printResult(session: string, command: string, json: boolean, result: { text: string; data: unknown }): void {
  if (json) {
    console.log(JSON.stringify(result.data));
    return;
  }
  const bytes = Buffer.byteLength(result.text, 'utf8');
  if (bytes <= MAX_INLINE_BYTES) {
    console.log(result.text);
    return;
  }
  const paths = sessionPaths(session);
  ensurePrivateDir(paths.out);
  const fileName = `${command}-${new Date().toISOString().replace(/:/g, '-')}.txt`;
  const filePath = join(paths.out, fileName);
  writeFileSync(filePath, result.text, { mode: 0o600 });
  chmodSync(filePath, 0o600);
  const lines = result.text.split('\n');
  console.log(`output written to ${filePath} (${lines.length} lines)`);
  console.log(lines.slice(0, 20).join('\n'));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { session, json, help, version, rest } = parseGlobalFlags(argv);

  if (version) {
    console.log(VERSION);
    return;
  }

  const [command, ...args] = rest;

  if (help || command === undefined) {
    if (command !== undefined && USAGE[command] !== undefined) {
      console.log(`usage: ${USAGE[command]}`);
    } else {
      console.log(TOP_LEVEL_HELP);
    }
    return;
  }

  if ((command === 'record' || command === 'flow') && (args[0] === undefined || args.includes('-h') || args.includes('--help'))) {
    const key = args[0] === undefined ? command : `${command} ${args[0]}`;
    console.log(`usage: ${USAGE[key] ?? TOP_LEVEL_HELP}`);
    return;
  }

  if (command === 'status') {
    const sessions = await listSessions();
    let current = sessions.find((s) => s.session === session);
    if (current === undefined) {
      current = { session, alive: false };
      sessions.push(current);
    }
    if (json) {
      console.log(JSON.stringify(sessions));
    } else {
      for (const s of sessions) {
        console.log(`${s.session}: ${s.alive ? 'running' : 'stopped'}`);
      }
    }
    return;
  }

  if (command === 'close') {
    try {
      const result = await call(session, 'close', {}, { spawn: false });
      printResult(session, command, json, result);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ECONNREFUSED') {
        console.log(`session ${session} is not running`);
        return;
      }
      process.exitCode = printError(err);
    }
    return;
  }

  if (command === 'mcp') {
    try {
      // Not a literal specifier: avoids a compile-time dependency on a module
      // owned by src/engine's parallel build (src/mcp/server.ts).
      const specifier = new URL('../mcp/server.ts', import.meta.url).href;
      const mod = (await import(specifier)) as { runMcpServer: () => Promise<void> };
      await mod.runMcpServer();
    } catch (err) {
      console.error(`error: mcp server unavailable: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
    return;
  }

  try {
    let target: Dispatch;
    if (command === 'record') {
      const [sub_, ...subArgs] = args;
      target = dispatchRecord(sub_ ?? '', subArgs);
    } else if (command === 'flow') {
      const [sub_, ...subArgs] = args;
      target = dispatchFlow(sub_ ?? '', subArgs);
    } else {
      target = dispatch(command, args);
    }
    const method: RpcMethod = target.method;
    const result = await call(session, method, target.params);
    printResult(session, command, json, result);
  } catch (err) {
    process.exitCode = printError(err);
  }
}

main().catch((err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
