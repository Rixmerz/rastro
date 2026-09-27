// MCP server: exposes the daemon's RPC methods as tools over stdio, for
// agents that speak MCP instead of the CLI.

import { extname, basename, join } from 'node:path';
import { writeFileSync, chmodSync, watch, type FSWatcher } from 'node:fs';
import { z } from 'zod';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { call } from '../daemon/client.ts';
import { RastroError } from '../core/types.ts';
import { VERSION } from '../version.ts';
import type { RpcMethod, RpcResult } from '../core/types.ts';
import { ensurePrivateDir, routineDirs, routinesStateDir, sessionPaths } from '../core/paths.ts';
import type { FlowParam, ToolManifest } from '../flow/format.ts';
import { describeLink, loadRoutines, type Routine, type RoutineCatalog } from '../routines/registry.ts';
import { dispatchRoutine, type EngineChoice } from '../routines/dispatch.ts';
import { isCallerParam, isRequired, validateRoutineParams } from '../routines/params.ts';

type CallFn = (
  session: string,
  method: RpcMethod,
  params: Record<string, unknown>,
  opts?: { timeoutMs?: number },
) => Promise<RpcResult>;

/** `tools`: the two stable routine tools plus one per verified routine.
 * `catalog`: only the stable two. `off`: none. */
export type RoutineExposure = 'tools' | 'catalog' | 'off';

export interface McpServerOptions {
  routines?: RoutineExposure;
  /** Expose nothing but the routine tools: an agent that may only run vetted routines. */
  routinesOnly?: boolean;
  /** Routine directories; `routineDirs()` by default. */
  dirs?: string[];
}

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

/**
 * What every connected agent reads in its system prompt, whether or not it
 * ever loads the skill: the one habit that matters is checking for a routine
 * before browsing, and never rerunning one that already wrote something.
 */
export function serverInstructions(exposure: RoutineExposure, routinesOnly: boolean): string {
  const routines =
    'Saved routines do whole site tasks (publish a file, create an assignment...) from typed params. ' +
    'Before browsing a site, call rastro_routines; if one covers the task, run it (its own tool, or rastro_routine_run) instead of navigating. ' +
    'Some replay over plain HTTP without a browser. ' +
    'Read its result: "retry is safe" means nothing was written; "a write was sent: do NOT retry" or "still running" means check the site or rastro_history before any new attempt.';
  const browser =
    'For anything no routine covers: rastro_open (with allowWrite for hosts that must receive writes), rastro_view to act, rastro_read for the text a page says (view lists only what can be acted on), rastro_act; ' +
    'each action returns a one-line effect summary, and rastro_effects / rastro_trace / rastro_request dig into what it caused.';
  if (exposure === 'off') return browser;
  if (routinesOnly) return `${routines} This server exposes routines only.`;
  return `${routines} ${browser}`;
}

const controllers = new WeakMap<McpServer, RoutineTools>();

/** The routine-tool controller of a server built by `createMcpServer`, if any. */
export function routineToolsOf(server: McpServer): RoutineTools | undefined {
  return controllers.get(server);
}

export function createMcpServer(
  callFn: CallFn = call,
  defaultSession = process.env.RASTRO_SESSION ?? 'default',
  opts: McpServerOptions = {},
): McpServer {
  const exposure: RoutineExposure = opts.routinesOnly && opts.routines === 'off' ? 'catalog' : (opts.routines ?? 'tools');
  const server = new McpServer({ name: 'rastro', version: VERSION }, { instructions: serverInstructions(exposure, opts.routinesOnly === true) });
  if (exposure !== 'off') {
    controllers.set(server, new RoutineTools(server, callFn, defaultSession, exposure, opts.dirs));
  }
  if (opts.routinesOnly) return server;

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
    'rastro_read',
    'Reads the visible text view leaves out (a mail body, a paragraph): of main, a region, one ref, or lines around a word.',
    { region: z.string().optional(), ref: z.string().optional(), find: z.string().optional(), max: z.number().int().positive().optional() },
    (a) => ({ method: 'read', params: { region: a.region, ref: a.ref, find: a.find, max: a.max } }),
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

// ---------------------------------------------------------------------------
// Routine tools.
// ---------------------------------------------------------------------------

/** How long a routine may run before the client stops waiting. Long on
 * purpose: a timeout does not stop the daemon, and an agent that reads it as a
 * failure and retries duplicates whatever the routine writes. */
function routineTimeoutMs(): number {
  return Number(process.env.RASTRO_ROUTINE_TIMEOUT_MS) || 15 * 60_000;
}

const RELOAD_DEBOUNCE_MS = 250;

function paramSchema(def: FlowParam): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  if (def.enum) {
    schema = z.enum(def.enum as [string, ...string[]]);
  } else {
    switch (def.type ?? 'string') {
      case 'integer':
        schema = z.number().int();
        break;
      case 'number':
        schema = z.number();
        break;
      case 'boolean':
        schema = z.boolean();
        break;
      case 'url':
        schema = z.string().url();
        break;
      case 'path':
        schema = z.string().describe('absolute path');
        break;
      default:
        schema = z.string();
    }
  }
  const hints = [def.description, def.type === 'path' ? 'absolute path' : undefined, def.example !== undefined ? `e.g. ${String(def.example)}` : undefined]
    .filter((h): h is string => h !== undefined && h.length > 0);
  if (hints.length > 0) schema = schema.describe(hints.join('; '));
  return isRequired(def) ? schema : schema.optional();
}

/** The input shape of a routine's own tool. Keyring parameters are left out:
 * the agent can neither see nor override what the routine resolves itself. */
export function routineInputShape(routine: Routine): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, def] of Object.entries(routine.flow.params ?? {})) {
    if (isCallerParam(def)) shape[name] = paramSchema(def);
  }
  return shape;
}

function annotationsFor(tool: ToolManifest): { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } {
  return {
    readOnlyHint: tool.effect === 'read',
    destructiveHint: tool.effect === 'destructive',
    idempotentHint: tool.effect === 'read',
    openWorldHint: true,
  };
}

function describeParam(name: string, def: FlowParam): string {
  const type = def.enum ? def.enum.join('|') : (def.type ?? 'string');
  return `${name}:${type}${isRequired(def) ? '' : '?'}`;
}

export function formatCatalog(catalog: RoutineCatalog): string {
  const lines: string[] = [];
  for (const r of catalog.routines) {
    const params = Object.entries(r.flow.params ?? {})
      .filter(([, def]) => isCallerParam(def))
      .map(([name, def]) => describeParam(name, def));
    const link = describeLink(r.link);
    lines.push(`${r.name} · ${r.tool.effect} · ${r.verified ? 'verified' : 'unverified'}${link ? ` · ${link}` : ''} — ${r.tool.description}`);
    if (params.length > 0) lines.push(`  params: ${params.join(', ')}`);
    for (const w of r.warnings) lines.push(`  warning: ${w}`);
  }
  if (catalog.routines.length === 0) lines.push('no routines (a flow becomes one with a tool: block)');
  for (const p of catalog.problems) lines.push(`problem: ${p.name} (${p.file}): ${p.error}`);
  for (const s of catalog.shadowed) lines.push(`shadowed: ${s.file} by ${s.by}`);
  return lines.join('\n');
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && !(err instanceof RastroError) && /^timed out waiting for/.test(err.message);
}

/**
 * Owns the routine tools of one server: the stable catalog/run pair, and one
 * tool per verified routine kept in step with the files on disk. Every change
 * goes through `reload`, which never throws: a bad file loses its tool and
 * shows up in the catalog instead.
 */
export class RoutineTools {
  private readonly server: McpServer;
  private readonly callFn: CallFn;
  private readonly defaultSession: string;
  private readonly exposure: RoutineExposure;
  private readonly dirs: string[] | undefined;
  private readonly live = new Map<string, { tool: RegisteredTool; hash: string }>();
  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(server: McpServer, callFn: CallFn, defaultSession: string, exposure: RoutineExposure, dirs?: string[]) {
    this.server = server;
    this.callFn = callFn;
    this.defaultSession = defaultSession;
    this.exposure = exposure;
    this.dirs = dirs;
    this.registerStable();
    this.reload();
  }

  private catalog(): RoutineCatalog {
    return loadRoutines(this.dirs ?? routineDirs());
  }

  private registerStable(): void {
    this.server.registerTool(
      'rastro_routines',
      {
        description: 'Lists saved routines: what each does, its params, whether it is verified, and any problem.',
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      () => {
        try {
          return { content: [{ type: 'text', text: formatCatalog(this.catalog()) }] };
        } catch (err) {
          return errorResult(err);
        }
      },
    );
    this.server.registerTool(
      'rastro_routine_run',
      {
        description: 'Runs a saved routine by name with its params, verified or not. See rastro_routines.',
        inputSchema: {
          name: z.string(),
          params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
          engine: z.enum(['auto', 'browser', 'http']).optional().describe('auto (default) replays over http only when the routine has a verified recipe'),
          session: sessionField,
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async (args) => {
        const input = args as { name: string; params?: Record<string, unknown>; session?: string; engine?: EngineChoice };
        const routine = this.catalog().routines.find((r) => r.name === input.name);
        if (!routine) {
          const catalog = this.catalog();
          const problem = catalog.problems.find((p) => p.name === input.name);
          const text = problem
            ? `error: routine ${input.name} is unusable: ${problem.error}`
            : `error: no routine ${input.name}\nhint: list them with rastro_routines`;
          return { content: [{ type: 'text', text }], isError: true };
        }
        return this.run(routine, input.params ?? {}, input.session, input.engine);
      },
    );
  }

  private async run(routine: Routine, params: Record<string, unknown>, session?: string, engine: EngineChoice = 'auto'): Promise<CallToolResult> {
    const target = session ?? routine.tool.session ?? this.defaultSession;
    try {
      // Validate here too, so a bad value fails before a daemon (and a
      // browser) is started for nothing.
      validateRoutineParams(routine.flow, params);
      const result = await dispatchRoutine(routine, params, target, { engine, callFn: this.callFn, timeoutMs: routineTimeoutMs() });
      const data = result.data as { ok?: boolean } | null;
      return { content: buildContent(target, routine.name, result), isError: data?.ok === false };
    } catch (err) {
      if (isTimeout(err)) {
        const text = `routine ${routine.name} is still running in session ${target} or its outcome is unknown.\n` +
          'Do NOT run it again: check rastro_history to see how it ended.';
        return { content: [{ type: 'text', text }], isError: true };
      }
      return errorResult(err);
    } finally {
      // A first good run is what promotes a routine to its own tool.
      this.reload();
    }
  }

  /** Brings the per-routine tools in line with the files. Never throws. */
  reload(): void {
    if (this.exposure !== 'tools') return;
    let desired: Routine[];
    try {
      desired = this.catalog().routines.filter((r) => r.verified);
    } catch {
      desired = [];
    }
    const wanted = new Map(desired.map((r) => [r.name, r]));

    for (const [name, entry] of this.live) {
      const next = wanted.get(name);
      if (next === undefined || next.hash !== entry.hash) {
        entry.tool.remove();
        this.live.delete(name);
      }
    }
    for (const routine of desired) {
      if (this.live.has(routine.name)) continue;
      try {
        const tool = this.server.registerTool(
          routine.name,
          {
            description: routine.tool.description,
            inputSchema: routineInputShape(routine),
            annotations: annotationsFor(routine.tool),
          },
          // Re-read at call time: linking or verifying a recipe does not change
          // the flow's hash, so the routine captured here would never learn
          // about it and would run in the browser forever.
          (args) => this.run(this.catalog().routines.find((r) => r.name === routine.name) ?? routine, args as Record<string, unknown>),
        );
        this.live.set(routine.name, { tool, hash: routine.hash });
      } catch {
        // A schema the SDK rejects (a malformed enum, say) leaves the routine
        // reachable through rastro_routine_run, which reports the problem.
      }
    }
  }

  /** Current per-routine tool names, for tests and diagnostics. */
  liveTools(): string[] {
    return [...this.live.keys()].sort();
  }

  /** Watches the routine directories and the verification markers. */
  watch(): void {
    const verified = join(routinesStateDir(), 'verified');
    ensurePrivateDir(verified);
    for (const dir of [...(this.dirs ?? routineDirs()), verified]) {
      try {
        this.watchers.push(watch(dir, () => this.schedule()));
      } catch {
        // A directory that does not exist yet simply has nothing to watch.
      }
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.reload(), RELOAD_DEBOUNCE_MS);
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
}

export async function runMcpServer(opts?: { session?: string } & McpServerOptions): Promise<void> {
  const server = createMcpServer(call, opts?.session ?? process.env.RASTRO_SESSION ?? 'default', opts ?? {});
  await server.connect(new StdioServerTransport());
  routineToolsOf(server)?.watch();
}
