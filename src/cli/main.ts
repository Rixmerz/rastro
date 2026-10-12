#!/usr/bin/env node
// CLI entry point. Parses argv, calls the daemon, and applies the output
// contract (text vs --json, >4 KB spills to a file).

import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import { writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { RastroError } from '../core/types.ts';
import type { RpcMethod } from '../core/types.ts';
import { call, listSessions } from '../daemon/client.ts';
import { ensurePrivateDir, resolveFlowRef, sessionPaths } from '../core/paths.ts';
import { describeAllowWrite, describeBinding, discoverProfiles, formatProfiles, inspectLock, loadBinding, OWN_PROFILE, resolveProfileRef, saveBinding } from '../core/profiles.ts';
import { describeLink, findRoutine, loadRoutines, readLink } from '../routines/registry.ts';
import { clientFileName, emitClient, envVars, type EmitLang } from '../link/emit.ts';
import { dispatchRoutine, type EngineChoice } from '../routines/dispatch.ts';
import { contentHash, lastRun } from '../routines/state.ts';
import { secretGet, secretList, secretRemove, secretSet } from '../security/vault.ts';
import { readSecretInteractively } from './prompt.ts';
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

/** Version of the `--json` envelope. Bumped when its shape, or the shape of a
 * command's `data`, changes in a way a parser would notice. */
const JSON_SCHEMA_VERSION = 1;

/** Every `--json` answer is one line on stdout: `{schemaVersion, ok, data}`
 * on success, `{schemaVersion, ok: false, error}` on failure. A routine that
 * ran and failed is `ok: false` with its result in `data`. */
function printJson(data: unknown, ok = true): void {
  console.log(JSON.stringify({ schemaVersion: JSON_SCHEMA_VERSION, ok, data }));
}

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
        'allow-upload': { type: 'string' },
        dialogs: { type: 'string' },
        'pw-trace': { type: 'boolean' },
        'quiet-ms': { type: 'string' },
        'max-window-ms': { type: 'string' },
        'timeout-ms': { type: 'string' },
        profile: { type: 'string' },
      });
      return {
        method: 'open',
        params: {
          url: positionals[0],
          headed: bool(values.headed),
          allowWrite: splitList(str(values['allow-write'])),
          allowUpload: splitList(str(values['allow-upload']))?.map((p) => resolvePath(p)),
          dialogs: str(values.dialogs),
          pwTrace: bool(values['pw-trace']),
          quietMs: toNumber(str(values['quiet-ms']), '--quiet-ms'),
          maxWindowMs: toNumber(str(values['max-window-ms']), '--max-window-ms'),
          timeoutMs: toNumber(str(values['timeout-ms']), '--timeout-ms'),
          profile: str(values.profile),
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
    case 'read': {
      const { values } = sub(argv, {
        region: { type: 'string' },
        ref: { type: 'string' },
        find: { type: 'string' },
        max: { type: 'string' },
      });
      return {
        method: 'read',
        params: { region: str(values.region), ref: str(values.ref), find: str(values.find), max: toNumber(str(values.max), '--max') },
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
      const { values, positionals } = sub(argv, { select: { type: 'string' }, close: { type: 'string' } });
      // `tabs use t2` used to list the tabs and ignore the rest without a word,
      // so the tab never changed and nothing said why.
      if (positionals.length > 0) {
        throw new UsageError(`tabs takes no positional argument (got "${positionals[0]!}")\nusage: ${USAGE.tabs ?? ''}`);
      }
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
      const { values, positionals } = sub(argv, { bodies: { type: 'boolean' }, reveal: { type: 'boolean' } });
      const format = requirePositional(positionals, 0, 'format', USAGE.export ?? '');
      return {
        method: 'export',
        params: {
          format,
          path: positionals[1] === undefined ? undefined : resolvePath(positionals[1]),
          bodies: bool(values.bodies),
          reveal: bool(values.reveal),
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
    return { method: 'recordStop', params: { save: save === undefined ? undefined : resolveFlowRef(save) } };
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
    const file = resolveFlowRef(requirePositional(positionals, 0, 'file', USAGE['flow save'] ?? ''));
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
    const file = resolveFlowRef(requirePositional(positionals, 0, 'file', USAGE['flow run'] ?? ''));
    return {
      method: 'flowRun',
      params: {
        file: resolvePath(file),
        from: toNumber(str(values.from), '--from'),
        params: parseKeyValues(list(values.param), '--param'),
      },
    };
  }
  if (sub_ === 'link') {
    const { values, positionals } = sub(argv, {
      param: { type: 'string', multiple: true },
      from: { type: 'string' },
      to: { type: 'string' },
    });
    const ref = requirePositional(positionals, 0, 'file', USAGE['flow link'] ?? '');
    // A bare name links the routine `routine run` would run, so the recipe
    // lands next to the file that will use it (routine dirs, RASTRO_FLOWS).
    const file = flowFileFor(ref);
    return {
      method: 'flowLink',
      params: {
        file: resolvePath(file),
        params: parseKeyValues(list(values.param), '--param'),
        from: toNumber(str(values.from), '--from'),
        to: toNumber(str(values.to), '--to'),
      },
    };
  }
  if (sub_ === 'export') {
    const { values, positionals } = sub(argv, { out: { type: 'string' }, playwright: { type: 'boolean' } });
    const file = requirePositional(positionals, 0, 'file', USAGE['flow export'] ?? '');
    const out = str(values.out);
    return {
      method: 'flowExport',
      params: { file: resolveFlowRef(file), out: out === undefined ? undefined : resolvePath(out), format: 'playwright' },
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

/** Whether the user named a session, as opposed to getting the default. A
 * routine's own `session:` only yields to an explicit choice. */
function sessionIsExplicit(argv: string[]): boolean {
  return argv.includes('-s') || argv.includes('--session') || process.env.RASTRO_SESSION !== undefined;
}

function showRoutine(name: string, json: boolean): void {
  const routine = findRoutine(name);
  const run = lastRun(routine.name);
  if (json) {
    printJson({ ...routine, lastRun: run ?? null });
    return;
  }
  const lines = [
    `${routine.name} · ${routine.tool.effect} · ${routine.verified ? 'verified' : 'unverified'}`,
    routine.tool.description,
    `file: ${routine.file}`,
  ];
  if (routine.tool.session) lines.push(`session: ${routine.tool.session}`);
  if (routine.tool.allowWrite) lines.push(`allow write: ${routine.tool.allowWrite.join(', ')}`);
  if (routine.tool.allowUpload) lines.push(`allow upload: ${routine.tool.allowUpload.join(', ')}`);
  if (routine.tool.login) lines.push(`login: ${routine.tool.login}`);
  const link = describeLink(routine.link);
  if (link) lines.push(`${link} (${routine.link!.file})`);
  for (const w of routine.link?.recipe?.warnings ?? []) lines.push(`link warning: ${w}`);
  for (const [param, def] of Object.entries(routine.flow.params ?? {})) {
    const source = def.from !== undefined ? ` (from ${def.from}, not supplied by the caller)` : '';
    const type = def.enum ? def.enum.join('|') : (def.type ?? 'string');
    const optional = def.default !== undefined ? ` = ${def.default}` : '';
    lines.push(`param ${param}: ${type}${optional}${source}${def.description ? ` — ${def.description}` : ''}`);
  }
  for (const w of routine.warnings) lines.push(`warning: ${w}`);
  if (run) lines.push(`last run: ${run.at} ${run.ok ? 'ok' : `failed (${run.reason ?? ''})`} via ${run.engine}`);
  console.log(lines.join('\n'));
}

function listRoutines(json: boolean): void {
  const catalog = loadRoutines();
  if (json) {
    printJson(catalog);
    return;
  }
  const lines: string[] = [];
  for (const r of catalog.routines) {
    const link = describeLink(r.link);
    lines.push(`${r.name}  ${r.tool.effect}  ${r.verified ? 'verified' : 'unverified'}${link ? `  ${link}` : ''}  ${r.tool.description}`);
    for (const w of r.warnings) lines.push(`  warning: ${w}`);
  }
  if (catalog.routines.length === 0) lines.push('no routines (a flow becomes one with a tool: block)');
  for (const p of catalog.problems) lines.push(`problem: ${p.name} (${p.file}): ${p.error}`);
  for (const s of catalog.shadowed) lines.push(`shadowed: ${s.file} by ${s.by}`);
  console.log(lines.join('\n'));
}

/** A bare name means the routine `routine run` would run, else a flow file. */
function flowFileFor(ref: string): string {
  try {
    return ref.includes('/') || /\.ya?ml$/i.test(ref) ? resolveFlowRef(ref) : findRoutine(ref).file;
  } catch {
    return resolveFlowRef(ref);
  }
}

/**
 * `flow emit`: the flow's linked recipe as a standalone client. Runs in the
 * CLI: the recipe and the flow are files, and nothing here needs a browser.
 * Only a fresh recipe is emitted; an unverified one is emitted with a warning
 * in the file and in the answer.
 */
function emitFlow(args: string[], json: boolean): void {
  const { values, positionals } = sub(args, { lang: { type: 'string' }, out: { type: 'string' } });
  const lang = str(values.lang) ?? 'ts';
  if (lang !== 'ts' && lang !== 'py') throw new UsageError(`--lang expects ts or py, got "${lang}"`);
  const flowFile = resolvePath(flowFileFor(requirePositional(positionals, 0, 'name', USAGE['flow emit'] ?? '')));
  if (!existsSync(flowFile)) throw new RastroError(`no flow ${flowFile}`);
  const link = readLink(flowFile, contentHash(readFileSync(flowFile, 'utf8')));
  if (!link) throw new RastroError(`${basename(flowFile)} is not linked`, `run: rastro flow link ${basename(flowFile).replace(/\.ya?ml$/i, '')} --param ...`);
  if (link.state === 'invalid') throw new RastroError(`the recipe cannot be read: ${link.error ?? ''}`, `fix ${link.file} or link again`);
  if (link.state === 'stale') throw new RastroError('the recipe is stale: the flow changed since it was linked', 'run flow link again, then emit');
  const recipe = link.recipe!;
  const out = str(values.out) === undefined ? join(dirname(link.file), clientFileName(recipe.flow, lang)) : resolvePath(str(values.out)!);
  writeFileSync(out, emitClient(recipe, lang as EmitLang, { source: basename(link.file), verified: link.verified }), { mode: 0o644 });

  const env = Object.values(envVars(recipe));
  const paginated = recipe.requests.filter((r) => r.paginate).map((r) => r.id);
  const data = { file: out, lang, flow: recipe.flow, verified: link.verified, params: recipe.params, env, paginated, warnings: recipe.warnings ?? [] };
  if (json) {
    printJson(data);
    return;
  }
  const lines = [`emitted ${out}`, `params: ${recipe.params.length > 0 ? recipe.params.join(', ') : 'none'}`];
  if (env.length > 0) lines.push(`from the environment (keyring params): ${env.join(', ')}`);
  if (paginated.length > 0) lines.push(`follows pages: ${paginated.join(', ')}`);
  lines.push('session: pass a Cookie header (--cookie / $COOKIE) or a Rastro cookies.json (--cookie-file / $RASTRO_COOKIES)');
  if (!link.verified) lines.push(`warning: the recipe is not verified yet; run: rastro routine run ${recipe.flow} --engine http`);
  for (const w of recipe.warnings ?? []) lines.push(`link warning: ${w}`);
  console.log(lines.join('\n'));
}

function printError(err: unknown, json = false): number {
  const usage = err instanceof UsageError;
  const message = err instanceof Error ? err.message : String(err);
  const hint = err instanceof RastroError ? err.hint : undefined;
  console.error(`error: ${message}`);
  if (hint) console.error(`hint: ${hint}`);
  if (json) {
    const error: { kind: 'usage' | 'runtime'; message: string; hint?: string } = { kind: usage ? 'usage' : 'runtime', message };
    if (hint) error.hint = hint;
    console.log(JSON.stringify({ schemaVersion: JSON_SCHEMA_VERSION, ok: false, error }));
  }
  return usage ? 2 : 1;
}

/** Applies the output contract: text vs --json, and the 4 KB spill-to-file rule. */
function printResult(session: string, command: string, json: boolean, result: { text: string; data: unknown }): void {
  if (json) {
    printJson(result.data, (result.data as { ok?: unknown } | null)?.ok !== false);
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

/**
 * Stops a daemon without asking it nicely. `close` goes through the same
 * serialised queue as every other request, so it cannot reach a daemon that is
 * wedged — which is precisely when you need it gone. This reads the pid file
 * and signals the process directly.
 */
function killDaemon(session: string, force: boolean): string {
  const paths = sessionPaths(session);
  if (!existsSync(paths.pid)) {
    rmSync(paths.socket, { force: true });
    return `no daemon for ${session}`;
  }
  const pid = Number(readFileSync(paths.pid, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 1) throw new RastroError(`unreadable pid file for ${session}`, paths.pid);

  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    // The process is already gone; the files it should have removed are not.
    rmSync(paths.socket, { force: true });
    rmSync(paths.pid, { force: true });
    return `daemon ${String(pid)} was already gone; cleaned up ${session}`;
  }
  return force
    ? `killed ${session} (pid ${String(pid)})`
    : `asked ${session} (pid ${String(pid)}) to stop; --force if it does not`;
}

/**
 * Profile commands run in the CLI: listing reads other browsers' files and
 * binding only writes the session's `profile.json`, so neither needs the
 * daemon. Binding is refused while the session runs, because the profile is
 * a property of the browser process it already launched.
 */
async function runProfile(session: string, args: string[], json: boolean): Promise<void> {
  const [action, ...refParts] = args;
  const paths = sessionPaths(session);
  if (action === 'list') {
    const profiles = discoverProfiles();
    const bound = loadBinding(paths);
    if (json) {
      const rows = profiles.map((p) => ({
        ref: p.ref,
        browser: p.browser.id,
        label: p.browser.label,
        profileDirectory: p.profileDirectory,
        profileName: p.profileName ?? null,
        userDataDir: p.userDataDir,
        installed: p.executable !== undefined,
        lock: inspectLock(p.userDataDir),
      }));
      printJson({ session, bound, profiles: rows });
    } else {
      console.log(formatProfiles(profiles, bound, session));
    }
    return;
  }
  if (action === undefined || action === 'show') {
    const bound = loadBinding(paths);
    if (json) printJson({ session, bound });
    else if (bound === null) console.log(`${session}: Rastro's own profile`);
    else console.log(`${session}: ${describeBinding(bound)} (${bound.userDataDir}) · ${describeAllowWrite(bound.allowWrite)} by default`);
    return;
  }
  if (action === 'use') {
    const { values, positionals } = sub(refParts, { 'allow-write': { type: 'string' } });
    const ref = positionals.join(' ').trim();
    if (ref === '') throw new UsageError(`missing profile\nusage: ${USAGE.profile}`);
    const allowWrite = splitList(str(values['allow-write']));
    const running = (await listSessions()).some((s) => s.session === session && s.state !== 'stopped');
    if (running) {
      throw new RastroError(`session ${session} is running`, `close it first (rastro -s ${session} close); the profile is fixed when the browser starts`);
    }
    const resolved = ref.toLowerCase() === OWN_PROFILE ? null : resolveProfileRef(ref);
    if (resolved === null && allowWrite !== undefined) {
      throw new UsageError(`--allow-write is saved with a borrowed profile; for Rastro's own profile pass it to open\nusage: ${USAGE.profile}`);
    }
    const binding = resolved === null ? null : { ...resolved, ...(allowWrite !== undefined ? { allowWrite } : {}) };
    ensurePrivateDir(paths.root);
    saveBinding(paths, binding);
    if (json) {
      printJson({ session, bound: binding });
      return;
    }
    if (binding === null) {
      console.log(`${session}: back on Rastro's own profile`);
      return;
    }
    const lock = inspectLock(binding.userDataDir);
    const note =
      lock.state === 'held' && !lock.byRastro
        ? `\n${binding.label} is open right now (pid ${String(lock.pid)}): close it completely before rastro open`
        : '';
    console.log(
      `${session}: ${describeBinding(binding)} · ${describeAllowWrite(binding.allowWrite)} by default — ${binding.label} must be closed while this session runs${note}`,
    );
    return;
  }
  throw new UsageError(`unknown "profile ${action}"\nusage: ${USAGE.profile}`);
}

/**
 * The vault lives entirely in the CLI process: no daemon, no session. A stored
 * value is only ever read again inside the daemon while a flow resolves a
 * `secret:` parameter, which is why there is no plain `get` here.
 */
function runSecret(args: string[], json: boolean): void {
  const [sub, name, extra] = args;
  const reveal = args.includes('--reveal');

  if (sub === 'list') {
    const names = secretList();
    if (json) printJson(names);
    else console.log(names.join('\n'));
    return;
  }

  if (sub === undefined || name === undefined) {
    throw new RastroError(`usage: ${USAGE.secret ?? 'rastro secret set|list|rm <name>'}`);
  }

  if (sub === 'set') {
    // A value on the command line would land in shell history and in any
    // agent transcript, which is the whole thing this command exists to avoid.
    if (extra !== undefined && !extra.startsWith('--')) {
      throw new RastroError('the value cannot be passed as an argument', `run: rastro secret set ${name}`);
    }
    secretSet(name, readSecretInteractively(`value for ${name}`, ['secret', 'set', name]));
    if (json) printJson({ name, stored: true });
    else console.log(`stored ${name}`);
    return;
  }

  if (sub === 'rm') {
    const removed = secretRemove(name);
    if (json) printJson({ name, removed });
    else console.log(removed ? `removed ${name}` : `no secret ${name}`);
    return;
  }

  if (sub === 'get') {
    if (!reveal) throw new RastroError('refusing to print a secret', 'add --reveal if you really mean it (human use only)');
    const value = secretGet(name);
    if (value === null) throw new RastroError(`no secret ${name}`);
    if (json) printJson({ name, value });
    else console.log(value);
    return;
  }

  throw new RastroError(`unknown secret subcommand "${sub}"`, USAGE.secret);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { session, json, help, version, rest } = parseGlobalFlags(argv);

  if (version) {
    if (json) printJson({ version: VERSION });
    else console.log(VERSION);
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

  if ((command === 'record' || command === 'flow' || command === 'routine') && (args[0] === undefined || args.includes('-h') || args.includes('--help'))) {
    const key = args[0] === undefined ? command : `${command} ${args[0]}`;
    console.log(`usage: ${USAGE[key] ?? TOP_LEVEL_HELP}`);
    return;
  }

  if (command === 'kill') {
    try {
      const message = killDaemon(session, args.includes('--force'));
      if (json) printJson({ session, message });
      else console.log(message);
    } catch (err) {
      process.exitCode = printError(err, json);
    }
    return;
  }

  if (command === 'secret') {
    try {
      runSecret(args, json);
    } catch (err) {
      process.exitCode = printError(err, json);
    }
    return;
  }

  if (command === 'profiles' || command === 'profile') {
    try {
      await runProfile(session, command === 'profiles' ? ['list'] : args, json);
    } catch (err) {
      process.exitCode = printError(err, json);
    }
    return;
  }

  if (command === 'status') {
    const sessions = await listSessions();
    let current = sessions.find((s) => s.session === session);
    if (current === undefined) {
      current = { session, state: 'stopped' as const };
      sessions.push(current);
    }
    if (json) {
      printJson(sessions);
    } else {
      for (const s of sessions) {
        console.log(`${s.session}: ${s.state}`);
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
        if (json) printJson({ session, running: false });
        else console.log(`session ${session} is not running`);
        return;
      }
      process.exitCode = printError(err, json);
    }
    return;
  }

  if (command === 'flow' && args[0] === 'emit') {
    try {
      emitFlow(args.slice(1), json);
    } catch (err) {
      process.exitCode = printError(err, json);
    }
    return;
  }

  if (command === 'routine' && (args[0] === 'list' || args[0] === 'show')) {
    try {
      if (args[0] === 'list') listRoutines(json);
      else showRoutine(requirePositional(args, 1, 'name', USAGE['routine show'] ?? ''), json);
    } catch (err) {
      process.exitCode = printError(err, json);
    }
    return;
  }

  if (command === 'mcp') {
    let routines: string | undefined;
    let routinesOnly: boolean | undefined;
    try {
      const { values } = sub(args, { routines: { type: 'string' }, 'routines-only': { type: 'boolean' } });
      routines = str(values.routines);
      routinesOnly = bool(values['routines-only']);
      if (routines !== undefined && routines !== 'tools' && routines !== 'catalog' && routines !== 'off') {
        throw new UsageError(`--routines expects tools, catalog or off, got "${routines}"`);
      }
    } catch (err) {
      process.exitCode = printError(err, json);
      return;
    }
    try {
      // Not a literal specifier: avoids a compile-time dependency on a module
      // owned by src/engine's parallel build (src/mcp/server.ts). The extension
      // has to track this file's own: `.ts` unbuilt, `.js` once shipped.
      const ext = import.meta.filename.endsWith('.ts') ? '.ts' : '.js';
      const specifier = new URL(`../mcp/server${ext}`, import.meta.url).href;
      const mod = (await import(specifier)) as {
        runMcpServer: (opts: { routines?: 'tools' | 'catalog' | 'off'; routinesOnly?: boolean }) => Promise<void>;
      };
      const opts: { routines?: 'tools' | 'catalog' | 'off'; routinesOnly?: boolean } = {};
      if (routines !== undefined) opts.routines = routines as 'tools' | 'catalog' | 'off';
      if (routinesOnly) opts.routinesOnly = true;
      await mod.runMcpServer(opts);
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
    } else if (command === 'routine') {
      const [sub_, ...subArgs] = args;
      if (sub_ !== 'run') throw new UsageError(`unknown "routine ${sub_ ?? ''}"\nusage: ${USAGE.routine}`);
      const { values, positionals } = sub(subArgs, { param: { type: 'string', multiple: true }, engine: { type: 'string' } });
      const engine = str(values.engine) ?? 'auto';
      if (engine !== 'auto' && engine !== 'browser' && engine !== 'http') {
        throw new UsageError(`--engine expects auto, browser or http, got "${engine}"`);
      }
      const routine = findRoutine(requirePositional(positionals, 0, 'name', USAGE['routine run'] ?? ''));
      const runSession = sessionIsExplicit(argv) ? session : (routine.tool.session ?? session);
      const result = await dispatchRoutine(routine, parseKeyValues(list(values.param), '--param') ?? {}, runSession, {
        engine: engine as EngineChoice,
        callFn: call,
        timeoutMs: Number(process.env.RASTRO_ROUTINE_TIMEOUT_MS) || 15 * 60_000,
      });
      printResult(runSession, command, json, result);
      if ((result.data as { ok?: boolean } | null)?.ok === false) process.exitCode = 1;
      return;
    } else {
      target = dispatch(command, args);
    }
    const method: RpcMethod = target.method;
    const result = await call(session, method, target.params);
    printResult(session, command, json, result);
  } catch (err) {
    process.exitCode = printError(err, json);
  }
}

main().catch((err: unknown) => {
  process.exitCode = printError(err, process.argv.includes('--json'));
});
