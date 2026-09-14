// Argument parsing helpers shared by src/cli/main.ts.

import { resolve } from 'node:path';
import type { RpcMethod } from '../core/types.ts';

/** A usage/argument mistake — CLI exits 2, distinct from a daemon-side error (exit 1). */
export class UsageError extends Error {}

export interface GlobalFlags {
  session: string;
  json: boolean;
  help: boolean;
  version: boolean;
  rest: string[];
}

/** Extracts -s/--session, --json, -h/--help, --version wherever they appear. */
export function parseGlobalFlags(argv: string[]): GlobalFlags {
  const rest: string[] = [];
  let session = process.env.RASTRO_SESSION ?? 'default';
  let json = false;
  let help = false;
  let version = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-s' || arg === '--session') {
      const value = argv[++i];
      if (value === undefined) throw new UsageError('--session requires a value');
      session = value;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg === '--version') {
      version = true;
    } else if (arg !== undefined) {
      rest.push(arg);
    }
  }
  return { session, json, help, version, rest };
}

/** Resolves a user-supplied path against the CLI's cwd, before it crosses to the daemon. */
export function resolvePath(path: string): string {
  return resolve(process.cwd(), path);
}

export function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function toNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (Number.isNaN(n)) throw new UsageError(`${flag} expects a number, got "${value}"`);
  return n;
}

/** `k=v` pairs (repeated `--param`) into an object. */
export function parseKeyValues(pairs: string[] | undefined, flag: string): Record<string, string> | undefined {
  if (pairs === undefined || pairs.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) throw new UsageError(`${flag} expects key=value, got "${pair}"`);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

export interface Dispatch {
  method: RpcMethod;
  params: Record<string, unknown>;
}

export const USAGE: Record<string, string> = {
  open: 'rastro open [url] [--headed] [--allow-write h1,h2] [--allow-upload dir,dir] [--dialogs accept|dismiss] [--pw-trace] [--quiet-ms n] [--max-window-ms n] [--timeout-ms n]',
  goto: 'rastro goto <url>',
  back: 'rastro back',
  forward: 'rastro forward',
  reload: 'rastro reload',
  view: 'rastro view [--region r] [--all] [--urls] [--find text]',
  act: 'rastro act <ref> <kind> [value] [--secret]',
  click: 'rastro click <ref>',
  fill: 'rastro fill <ref> <value> [--secret]',
  type: 'rastro type <ref> [value] [--secret]',
  press: 'rastro press <ref> <key>',
  select: 'rastro select <ref> <value>',
  check: 'rastro check <ref>',
  uncheck: 'rastro uncheck <ref>',
  hover: 'rastro hover <ref>',
  dblclick: 'rastro dblclick <ref>',
  scroll: 'rastro scroll <ref> [up|down]',
  upload: 'rastro upload <ref> <file>',
  detail: 'rastro detail <ref>',
  history: 'rastro history [--limit n] [--from id] [--to id]',
  effects: 'rastro effects <id> [--all]',
  trace: 'rastro trace [--action id] [--since ms] [--type a,b] [--bg] [--limit n]',
  request: 'rastro request <id> [--body] [--full] [--curl] [--reveal]',
  snapshot: 'rastro snapshot <id> [--before|--after]',
  screenshot: 'rastro screenshot [path] [--full]',
  console: 'rastro console [--errors] [--limit n]',
  cookies: 'rastro cookies [--reveal]',
  storage: 'rastro storage [--reveal]',
  tabs: 'rastro tabs [--select t2] [--close t2]',
  eval: 'rastro eval <expr> [--ref e5]',
  replay: 'rastro replay <requestId> [--yes]',
  export: 'rastro export <har|perfetto|pw-trace> [path] [--bodies] [--reveal]',
  'record start': 'rastro record start [url] [--continue flow.yaml --at n]',
  'record stop': 'rastro record stop [--save flow.yaml]',
  secret: 'rastro secret set <name> | rastro secret list | rastro secret rm <name>',
  'flow save': 'rastro flow save <name|file> [--from id] [--to id] [--name n]',
  'flow run': 'rastro flow run <name|file> [--from n] [--param k=v ...]',
  'flow export': 'rastro flow export <file> [--out path] [--playwright]',
  'flow import': 'rastro flow import <chrome.json> <out.yaml>',
  status: 'rastro status',
  close: 'rastro close',
  mcp: 'rastro mcp',
};

export const TOP_LEVEL_HELP = `rastro — a browser for AI agents

usage: rastro [-s|--session name] [--json] <command> [args]

commands:
  open, goto, back, forward, reload
  view, act (click, fill, type, press, select, check, uncheck, hover, dblclick, scroll, upload)
  detail, history, effects, trace, request, snapshot, screenshot
  console, cookies, storage, tabs, eval, replay, export
  record start|stop, flow save|run|export|import
  secret set|list|rm
  status, close, mcp

global flags:
  -s, --session <name>   session to use (default: $RASTRO_SESSION or "default")
  --json                 print machine-readable JSON instead of text
  -h, --help             show this help, or "rastro <command> --help"
  --version              print the version

run "rastro <command> --help" for a command's usage line.`;
