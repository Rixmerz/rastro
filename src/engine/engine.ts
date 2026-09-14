// Implements the `Engine` RPC surface: every command an agent or the CLI can
// issue against a session. Orchestrates session.ts (browser lifecycle),
// recorder.ts (trace capture) and the pure attribution/format modules.

import { appendFileSync, chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Locator, Page } from 'playwright-core';
import type {
  ActionKind,
  ActionRecord,
  AriaNode,
  Engine,
  EventBucket,
  EventType,
  LocatorBundle,
  RpcResult,
} from '../core/types.ts';
import { RastroError } from '../core/types.ts';
import { ensureSessionDirs, sessionPaths, type SessionPaths } from '../core/paths.ts';
import { TraceStore } from '../store/db.ts';
import { BodyStore } from '../store/bodies.ts';
import { SecretRegistry, MASK, isSensitiveFieldName, maskBody, maskHeaders } from '../security/redact.ts';
import { buildView, findRef, formatView, newInteractiveCount } from '../perception/view.ts';
import { captureBundle } from '../perception/locators.ts';
import { attributeEvent, attributeRequests, type ActionWindow } from '../attribution/attribute.ts';
import { waitForQuiet } from '../attribution/quiet.ts';
import { buildSummary, formatSummary } from '../format/summary.ts';
import {
  formatConsole,
  formatCookies,
  formatDetail,
  formatEffects,
  formatHistory,
  formatRequest,
  formatStorage,
  formatTabs,
  formatTrace,
  toCurl,
} from '../format/output.ts';
import { toHar } from '../export/har.ts';
import { toPerfetto } from '../export/perfetto.ts';
import { Session, type TabRecord } from './session.ts';
import { Recorder } from './recorder.ts';
import { detectBlocked } from './blocked.ts';
import { VERSION } from '../version.ts';
import { FlowController } from './flows.ts';

const OpenParamsSchema = z.object({
  url: z.string().optional(),
  headed: z.boolean().optional(),
  allowWrite: z.array(z.string()).optional(),
  allowUpload: z.array(z.string()).optional(),
  dialogs: z.enum(['accept', 'dismiss']).optional(),
  pwTrace: z.boolean().optional(),
  quietMs: z.number().positive().optional(),
  maxWindowMs: z.number().positive().optional(),
  timeoutMs: z.number().positive().optional(),
});

const ViewParamsSchema = z.object({
  region: z.string().optional(),
  all: z.boolean().optional(),
  urls: z.boolean().optional(),
  find: z.string().optional(),
});

const ActParamsSchema = z.object({
  ref: z.string(),
  kind: z.enum([
    'click',
    'dblclick',
    'fill',
    'type',
    'press',
    'select',
    'check',
    'uncheck',
    'hover',
    'scroll',
    'upload',
  ]),
  value: z.string().optional(),
  secret: z.boolean().optional(),
});

const NavParamsSchema = z.object({ url: z.string().optional() });
const RefParamsSchema = z.object({ ref: z.string() });
const RequestParamsSchema = z.object({
  id: z.string(),
  body: z.boolean().optional(),
  full: z.boolean().optional(),
  curl: z.boolean().optional(),
  reveal: z.boolean().optional(),
});
const RevealParamsSchema = z.object({ reveal: z.boolean().optional() });
const ExportParamsSchema = z.object({
  format: z.enum(['har', 'perfetto', 'pw-trace']),
  path: z.string().optional(),
  bodies: z.boolean().optional(),
  reveal: z.boolean().optional(),
});
const ActionIdSchema = z.object({ action: z.union([z.number(), z.string()]).transform((v) => Number(v)) });
const ReplayParamsSchema = z.object({ id: z.string(), yes: z.boolean().optional() });

function parse<T>(schema: z.ZodType<T>, params: Record<string, unknown>): T {
  const result = schema.safeParse(params);
  if (!result.success) throw new RastroError(`invalid params: ${result.error.message}`);
  return result.data;
}

/** Event types that concern a specific request; per S1/R7 these inherit
 * their bucket/actionId from that request rather than being classified on
 * their own. */
const NETWORK_EVENT_TYPES: EventType[] = ['request', 'response', 'redirect', 'request_failed', 'ws_open', 'ws_close'];

function isRequestRecordLike(node: Record<string, unknown>): node is Record<string, unknown> & {
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
  postData?: string;
} {
  return typeof node.method === 'string' && typeof node.url === 'string' && typeof node.requestHeaders === 'object' && node.requestHeaders !== null;
}

function isCookieRecordLike(node: Record<string, unknown>): boolean {
  return typeof node.name === 'string' && typeof node.domain === 'string' && typeof node.value === 'string' && typeof node.httpOnly === 'boolean';
}

function headerValueOf(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/**
 * Selects an option, failing fast when the value matches none of them.
 *
 * `locator.selectOption` waits the whole timeout for an option that is never
 * going to appear and then reports only that it timed out — 30 seconds and no
 * clue, which for an agent means guessing again. Chrome's own matching is by
 * value, label or index, so mirror that check here and name what is on offer.
 */
async function selectOption(locator: Locator, value: string, timeout: number): Promise<void> {
  const options = await locator.evaluate((el: Element) =>
    el instanceof HTMLSelectElement
      ? Array.from(el.options, (o) => ({ value: o.value, label: o.label }))
      : null,
  );
  if (options && !options.some((o) => o.value === value || o.label === value)) {
    throw new RastroError(
      `no option «${value}»`,
      `available: ${options.map((o) => o.value).join(', ') || '(none)'}`,
    );
  }
  await locator.selectOption(value, { timeout });
}

/** R6: pure so a timed-out quiet window is testable without a real page. */
export function withWindowCutNote(text: string, timedOut: boolean, maxWindowMs: number): string {
  return timedOut ? `${text} · window cut at ${maxWindowMs}ms` : text;
}

interface SessionConfig {
  quietMs: number;
  maxWindowMs: number;
  timeoutMs: number;
  pwTrace: boolean;
}

/** Passed to `perform`; a target step (flow/human capture) can seed
 * `ctx.target` up front by passing `RunActionInput.target` instead of
 * computing it from a live `Locator` mid-perform, the way `act()` does. */
export interface RunActionCtx {
  beforeTree: AriaNode[];
  target?: LocatorBundle;
  targetName?: string;
  value?: string;
  secret: boolean;
}

/** Input to `runAction`, the pipeline every action (agent `act`, a flow step,
 * a captured human event) funnels through. `target`, when provided, is a
 * pre-resolved locator bundle (from a flow step, or from the in-page capture
 * script) rather than one `runAction` needs to derive from `ref`. */
export interface RunActionInput {
  kind: ActionKind;
  source: ActionRecord['source'];
  ref?: string;
  target?: LocatorBundle;
  value?: string;
  secret?: boolean;
  targetName?: string;
  perform: (page: Page, ctx: RunActionCtx) => Promise<void>;
}

/** The engine's actual logic; `createEngine` wraps it into the RPC-shaped
 * `Engine` object the daemon/CLI/flow runner call. Public helpers
 * (`runAction`, `snapshotNow`, `resolveRef`, `store`, `secrets`, `session`)
 * are what a future flow runner reuses. */
export class EngineCore implements Engine {
  readonly store: TraceStore;
  readonly secrets = new SecretRegistry();
  session: Session | undefined;

  private readonly bodies: BodyStore;
  private readonly paths: SessionPaths;
  private readonly recorder: Recorder;
  private readonly attachPromises = new Map<Page, Promise<void>>();
  // Epoch ms of the session's t=0. Persisted in the store so a daemon restart
  // keeps one monotonic timeline; otherwise new action windows would overlap
  // events recorded by the previous daemon and steal their attribution.
  private readonly sessionStartEpoch: number;
  private config: SessionConfig = { quietMs: 500, maxWindowMs: 5000, timeoutMs: 30000, pwTrace: false };
  private readonly flows: FlowController;
  private closed = false;
  private sessionHeaded = false;
  /** Set when `ensureAlive` had to relaunch a dead session; consumed by the
   * next `runAction` so its result can say so (R2). */
  private relaunchedPending = false;
  private readonly secretsFile: string;

  private constructor(paths: SessionPaths) {
    this.paths = paths;
    this.store = TraceStore.open(paths.db);
    const existing = this.store.getSession();
    if (existing) {
      this.sessionStartEpoch = Date.parse(existing.startedAt);
    } else {
      this.sessionStartEpoch = Date.now();
      this.store.setSession({
        name: paths.root.split('/').pop() ?? 'default',
        startedAt: new Date(this.sessionStartEpoch).toISOString(),
        mode: 'agent',
      });
    }
    this.bodies = new BodyStore(paths.bodies);
    this.recorder = new Recorder(this.store, this.bodies, () => this.now());
    this.flows = new FlowController(this);
    // S3: secrets are in-memory only by default, so masking goes blind after
    // a daemon restart even though the values that produced it are still on
    // disk (the profile). Persist them ourselves in a 0600 file next to the
    // db, and reload on construction.
    this.secretsFile = join(paths.root, 'secrets');
    this.loadPersistedSecrets();
    this.wrapSecretPersistence();
  }

  /** Loads secrets persisted by a previous process (S3) before anything else
   * can add one, so the reload itself never re-triggers a write. */
  private loadPersistedSecrets(): void {
    if (!existsSync(this.secretsFile)) return;
    for (const line of readFileSync(this.secretsFile, 'utf8').split('\n')) {
      if (line) this.secrets.add(line);
    }
  }

  /**
   * `secrets` is a plain `SecretRegistry`; other modules (the flow runner)
   * call `.add` on it directly, not through the engine, so persistence has
   * to be wired at the shared instance rather than only around this class's
   * own call site. `secrets` itself stays `readonly` — only the method on
   * the object it points to is replaced.
   */
  private wrapSecretPersistence(): void {
    const add = this.secrets.add.bind(this.secrets);
    this.secrets.add = (value: string): void => {
      const isNew = value.length >= 3 && !this.secrets.has(value);
      add(value);
      if (isNew) this.persistSecret(value);
    };
  }

  private persistSecret(value: string): void {
    appendFileSync(this.secretsFile, `${value}\n`, { mode: 0o600 });
    chmodSync(this.secretsFile, 0o600);
  }

  /**
   * S1/S3: deep-masks any value before it leaves the process as an RpcResult
   * `.data` field, or before an aria snapshot is written to disk. Every
   * string is run through the secret registry (so a typed password/OTP never
   * shows up verbatim, wherever it landed); a `RequestRecord`-shaped or
   * `CookieRecord`-shaped node additionally gets the same header/body/value
   * masking its formatted text already has. `reveal` (only meaningful for
   * request/cookies/storage, which expose it as a param) skips all of it.
   */
  private maskData<T>(value: T, reveal = false): T {
    if (reveal) return value;
    const walk = (node: unknown): unknown => {
      if (typeof node === 'string') return this.secrets.mask(node);
      if (Array.isArray(node)) return node.map(walk);
      if (node !== null && typeof node === 'object') {
        const obj = { ...(node as Record<string, unknown>) };
        if (isRequestRecordLike(obj)) {
          const headers = obj.requestHeaders;
          obj.requestHeaders = maskHeaders(headers, false);
          if (obj.responseHeaders) obj.responseHeaders = maskHeaders(obj.responseHeaders, false);
          if (typeof obj.postData === 'string') {
            obj.postData = maskBody(obj.postData, headerValueOf(headers, 'content-type'), false);
          }
        }
        if (isCookieRecordLike(obj)) obj.value = MASK;
        const out: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(obj)) out[key] = walk(val);
        return out;
      }
      return node;
    };
    return walk(value) as T;
  }

  /**
   * R7/R8: a request/response/failure event's bucket is decided from its
   * request when the request is already known (see `runAction`), but the
   * response/failure can arrive after the action that owns it has already
   * closed its window — the event row lands with `actionId: null` because
   * the recorder does not know attribution. Sweep those up: if the request
   * they reference already has an attribution, copy it onto the event.
   * ponytail: linear scan over network events; fine at session scale.
   */
  private reattributeLateNetworkEvents(): void {
    const orphans = this.store
      .events({ types: NETWORK_EVENT_TYPES })
      .filter((e) => e.actionId === null && e.requestId !== null);
    for (const ev of orphans) {
      const req = this.store.getRequest(ev.requestId!);
      if (req && req.actionId !== null && req.bucket !== null) {
        this.store.setEventAttribution([ev.id], req.actionId, req.bucket);
      }
    }
  }

  static async create(sessionName: string): Promise<EngineCore> {
    const paths = sessionPaths(sessionName);
    ensureSessionDirs(paths);
    return new EngineCore(paths);
  }

  private now(): number {
    return performance.timeOrigin + performance.now() - this.sessionStartEpoch;
  }

  async shutdown(): Promise<void> {
    // R17: `close()` (RPC) and the daemon's own shutdown hook both call this;
    // without the guard the second call hits a closed DatabaseSync.
    if (this.closed) return;
    this.closed = true;
    if (this.session) await this.session.close().catch(() => {});
    this.store.close();
  }

  // --- session lifecycle -------------------------------------------------

  private requireSession(): Session {
    if (!this.session) throw new RastroError('no browser open', 'run rastro open <url>');
    return this.session;
  }

  /** Public for the flow runner and human-capture handler: both need a live
   * page outside of an action (waits, condition checks, capture install). */
  async ensureAlive(): Promise<Page> {
    const session = this.requireSession();
    if (session.dead) {
      // R2: the whole context/browser closed unexpectedly (not just one
      // tab) — relaunch instead of leaving every later call failing with
      // "Target page, context or browser has been closed". `relaunch()`
      // recreates tabs through the same hooks passed at `open()`, so
      // `onPageCreated` still wires the recorder up for us.
      await session.relaunch();
      this.relaunchedPending = true;
    } else if (session.needsRecovery()) {
      const page = await session.recover();
      this.attachPromises.set(page, this.recorder.attach(page, session.activeTabId));
    }
    const page = session.activePage();
    const attaching = this.attachPromises.get(page);
    if (attaching) await attaching;
    return page;
  }

  /** Reads and clears the "relaunched a dead session" flag (R2). */
  private consumeRelaunched(): boolean {
    const value = this.relaunchedPending;
    this.relaunchedPending = false;
    return value;
  }

  async open(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(OpenParamsSchema, rawParams);

    if (!this.session) {
      this.config = {
        quietMs: params.quietMs ?? this.config.quietMs,
        maxWindowMs: params.maxWindowMs ?? this.config.maxWindowMs,
        timeoutMs: params.timeoutMs ?? this.config.timeoutMs,
        pwTrace: params.pwTrace ?? false,
      };

      this.sessionHeaded = params.headed ?? false;
      const session = await Session.launch(
        this.paths,
        { headed: params.headed, allowWrite: params.allowWrite, allowUpload: params.allowUpload, dialogs: params.dialogs },
        {
          onPageCreated: (tab: TabRecord) => {
            this.attachPromises.set(tab.page, this.recorder.attach(tab.page, tab.id));
            // A new tab is activity: without this, a click that only opens a
            // popup (no network/DOM change on the opener) can go quiet before
            // the popup's own `tab_open` event has been recorded, dropping it
            // from the action's attribution window.
            this.recorder.markActivity();
          },
          onTabOpen: (tabId, url) => {
            this.store.addEvent({ t: this.now(), type: 'tab_open', actionId: null, bucket: null, tabId, requestId: null, data: { tabId, url } });
          },
          onTabClose: (tabId) => {
            this.store.addEvent({ t: this.now(), type: 'tab_close', actionId: null, bucket: null, tabId, requestId: null, data: { tabId } });
          },
          onDialog: (tabId, kind, message, handled) => {
            this.store.addEvent({ t: this.now(), type: 'dialog', actionId: null, bucket: null, tabId, requestId: null, data: { kind, message, handled } });
          },
          onDownload: (tabId, filename, path, size) => {
            const data: Record<string, unknown> = { filename, path };
            if (size !== undefined) data.size = size;
            this.store.addEvent({ t: this.now(), type: 'download', actionId: null, bucket: null, tabId, requestId: null, data });
          },
          onBlockedWrite: (tabId, method, url, host) => {
            this.store.addEvent({ t: this.now(), type: 'blocked_write', actionId: null, bucket: null, tabId, requestId: null, data: { method, url, host } });
          },
          onCrash: (tabId) => {
            this.store.addEvent({ t: this.now(), type: 'crash', actionId: null, bucket: null, tabId, requestId: null, data: { target: tabId } });
          },
        },
      );
      this.session = session;
      if (this.config.pwTrace) await session.context.tracing.start({ screenshots: true, snapshots: true });
    } else {
      // R10: `open` on an already-open session must not silently drop these
      // params — apply them to the live session instead of ignoring them.
      this.config = {
        quietMs: params.quietMs ?? this.config.quietMs,
        maxWindowMs: params.maxWindowMs ?? this.config.maxWindowMs,
        timeoutMs: params.timeoutMs ?? this.config.timeoutMs,
        pwTrace: this.config.pwTrace,
      };
      const applyOpts: { allowWrite?: string[]; allowUpload?: string[]; dialogs?: 'accept' | 'dismiss' } = {};
      if (params.allowWrite !== undefined) applyOpts.allowWrite = params.allowWrite;
      if (params.allowUpload !== undefined) applyOpts.allowUpload = params.allowUpload;
      if (params.dialogs !== undefined) applyOpts.dialogs = params.dialogs;
      this.session.applyOptions(applyOpts);
      // Headed is not a per-request option: it decides the browser process, so
      // switching it means relaunching, and the new value has to travel with
      // the call. Relying on the session to "keep" it left `record start`
      // relaunching headless on an already-open session.
      if (params.headed !== undefined && params.headed !== this.sessionHeaded) {
        this.sessionHeaded = params.headed;
        await this.session.relaunch(params.headed);
      }
    }

    const page = await this.ensureAlive();
    if (!params.url) {
      return { text: `session open · ${page.url()}`, data: { url: page.url() } };
    }

    return this.runAction({
      kind: 'open',
      source: 'agent',
      perform: async (page) => {
        await page.goto(params.url!, { timeout: this.config.timeoutMs });
      },
    });
  }

  async goto(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(NavParamsSchema, rawParams);
    if (!params.url) throw new RastroError('goto requires a url');
    return this.runAction({
      kind: 'goto',
      source: 'agent',
      perform: async (page) => {
        await page.goto(params.url!, { timeout: this.config.timeoutMs });
      },
    });
  }

  async back(): Promise<RpcResult> {
    return this.runAction({ kind: 'back', source: 'agent', perform: async (page) => {
      await page.goBack({ timeout: this.config.timeoutMs });
    } });
  }

  async forward(): Promise<RpcResult> {
    return this.runAction({ kind: 'forward', source: 'agent', perform: async (page) => {
      await page.goForward({ timeout: this.config.timeoutMs });
    } });
  }

  async reload(): Promise<RpcResult> {
    return this.runAction({ kind: 'reload', source: 'agent', perform: async (page) => {
      await page.reload({ timeout: this.config.timeoutMs });
    } });
  }

  // --- perception ----------------------------------------------------------

  private async safeTitle(page: Page): Promise<string> {
    try {
      return await page.title();
    } catch {
      return '';
    }
  }

  async snapshotNow(): Promise<{ url: string; title: string; tree: AriaNode[] }> {
    const page = await this.ensureAlive();
    const tree = (await page.ariaSnapshotJSON({ mode: 'ai' })) as unknown as AriaNode[];
    return { url: page.url(), title: await this.safeTitle(page), tree };
  }

  async view(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(ViewParamsSchema, rawParams);
    const page = await this.ensureAlive();
    const session = this.requireSession();
    const { url, title, tree } = await this.snapshotNow();
    this.store.addSnapshot({ t: this.now(), tabId: session.activeTabId, url, title, tree: this.maskData(tree) });

    if (params.all) {
      // S3: the aria YAML can hold a typed password/OTP verbatim; mask it
      // the same way as everything else this registry knows about, and keep
      // the file owner-only.
      const yamlText = await page.ariaSnapshot({ mode: 'ai' });
      const filePath = join(this.paths.out, `view-${Date.now()}.yaml`);
      writeFileSync(filePath, this.secrets.mask(yamlText), { mode: 0o600 });
      return { text: filePath, data: { file: filePath }, files: [filePath] };
    }

    const view = buildView({ url, title, tree }, params);
    return { text: formatView(view, { urls: params.urls }), data: this.maskData(view) };
  }

  /** Resolves a ref against the page's current aria tree. Callers must have
   * taken a snapshot on this page first (an action's "before" snapshot, or a
   * `view`) so the ref is known to Playwright. */
  async resolveRef(page: Page, ref: string): Promise<Locator> {
    const locator = page.locator(`aria-ref=${ref}`);
    if ((await locator.count()) === 0) {
      throw new RastroError(`ref ${ref} not found`, 'run rastro view');
    }
    return locator;
  }

  async detail(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(RefParamsSchema, rawParams);
    const page = await this.ensureAlive();
    const tree = (await page.ariaSnapshotJSON({ mode: 'ai' })) as unknown as AriaNode[];
    const node = findRef(tree, params.ref);
    if (!node) throw new RastroError(`ref ${params.ref} not found`, 'run rastro view');
    const locator = await this.resolveRef(page, params.ref);
    const info = await locator
      .evaluate((el: Element) => {
        const tag = el.tagName.toLowerCase();
        const href = tag === 'a' ? (el.getAttribute('href') ?? undefined) : undefined;
        const form = el.closest('form');
        const inputType = tag === 'input' ? (el.getAttribute('type') ?? 'text') : undefined;
        const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test') ?? el.getAttribute('data-qa') ?? undefined;
        const disabled = (el as HTMLInputElement).disabled === true;
        return {
          tag,
          href,
          formMethod: form?.getAttribute('method') ?? undefined,
          formAction: form?.getAttribute('action') ?? undefined,
          inputType,
          testId,
          disabled,
        };
      })
      .catch(() => ({ tag: undefined, href: undefined, formMethod: undefined, formAction: undefined, inputType: undefined, testId: undefined, disabled: undefined }));

    const detail = {
      ref: params.ref,
      role: node.role,
      name: node.name ?? '',
      ...info,
    };
    return { text: formatDetail(detail), data: detail };
  }

  /** Timeout (ms) actions and waits should use; set by `open`'s params. */
  get timeoutMs(): number {
    return this.config.timeoutMs;
  }

  // --- the action pipeline ---------------------------------------------

  /** Public: the flow runner and the human-capture handler both drive
   * actions (source 'flow'/'human') through this pipeline directly, rather
   * than through the source-'agent' RPC methods above. */
  async runAction(input: RunActionInput): Promise<RpcResult> {
    const page = await this.ensureAlive();
    const session = this.requireSession();
    const tabId = session.activeTabId;

    // R8: a previous action's request may have resolved after that action's
    // own window closed; catch it up before this action starts its own
    // classification so a stale null-actionId event doesn't linger forever.
    this.reattributeLateNetworkEvents();

    const id = this.store.nextActionId();
    const t0 = this.now();
    const urlBefore = page.url();

    const beforeTree = (await page.ariaSnapshotJSON({ mode: 'ai' })) as unknown as AriaNode[];
    // S3: snapshots are at-rest data; mask before storing, not before use —
    // `beforeTree` itself stays raw for ref lookups and the diff below.
    const snapshotBefore = this.store.addSnapshot({ t: t0, tabId, url: urlBefore, title: await this.safeTitle(page), tree: this.maskData(beforeTree) });
    const cookiesBefore = await this.recorder.cookies(session.context);
    const storageBefore = await this.recorder.storage(page);
    const domBefore = await this.recorder.domCounters(page);
    const tabsBefore = new Set(session.allTabs().map((t) => t.id));

    const action: ActionRecord = {
      id,
      source: input.source,
      kind: input.kind,
      tabId,
      secret: input.secret ?? false,
      t0,
      urlBefore,
      snapshotBefore,
    };
    if (input.ref !== undefined) action.ref = input.ref;
    if (input.targetName !== undefined) action.targetName = input.targetName;
    if (input.value !== undefined) action.value = input.secret ? MASK : input.value;
    this.store.addAction(action);
    this.emitLifecycle('action_start', id, tabId, input.kind, input.source);

    const ctx: RunActionCtx = { beforeTree, secret: input.secret ?? false };
    if (input.value !== undefined) ctx.value = input.value;
    if (input.targetName !== undefined) ctx.targetName = input.targetName;
    if (input.target !== undefined) ctx.target = input.target;

    // Marks the action itself as activity, so the quiet check on the very
    // first loop iteration (before any poll) never fires on a stale
    // `lastActivity` from long before this action started.
    this.recorder.markActivity();

    let error: string | undefined;
    let hint: string | undefined;
    try {
      await input.perform(page, ctx);
    } catch (err) {
      if (err instanceof RastroError) {
        error = err.message;
        hint = err.hint;
      } else {
        error = err instanceof Error ? err.message : String(err);
      }
    }

    // S3: register the typed secret as soon as `perform` has run (not at the
    // end of the pipeline) so the "after" snapshot below, taken while it is
    // still on the page, is masked before it is ever written to disk.
    if (ctx.secret && ctx.value) this.secrets.add(ctx.value);

    let t1 = this.now();
    let afterTree = beforeTree;
    let urlAfter = urlBefore;
    let blocked: string | undefined;
    let timedOut = false;

    if (error === undefined) {
      const currentPage = session.tab(tabId)?.page ?? page;
      ({ timedOut } = await waitForQuiet({
        pending: () => this.recorder.pending(),
        lastActivity: () => this.recorder.lastActivity(),
        now: () => this.now(),
        quietMs: this.config.quietMs,
        maxWindowMs: this.config.maxWindowMs,
        poll: async () => {
          await this.recorder.pollDomActivity(currentPage).catch(() => {});
          await new Promise((resolve) => setTimeout(resolve, 30));
        },
      }));

      t1 = this.now();
      urlAfter = session.tab(tabId)?.page.url() ?? urlBefore;
      try {
        afterTree = (await currentPage.ariaSnapshotJSON({ mode: 'ai' })) as unknown as AriaNode[];
      } catch {
        afterTree = beforeTree;
      }
      blocked = await detectBlocked(currentPage).catch(() => undefined);
    }

    const snapshotAfter = this.store.addSnapshot({ t: t1, tabId, url: urlAfter, title: await this.safeTitle(page).catch(() => ''), tree: this.maskData(afterTree) });

    if (error === undefined) {
      const cookiesAfter = await this.recorder.cookies(session.context);
      const cookieDiff = this.recorder.diffCookies(cookiesBefore, cookiesAfter);
      if (cookieDiff.added.length || cookieDiff.changed.length || cookieDiff.removed.length) {
        this.store.addEvent({ t: t1, type: 'cookie_diff', actionId: null, bucket: null, tabId, requestId: null, data: cookieDiff });
      }

      const storageAfter = await this.recorder.storage(page).catch(() => ({ local: {}, session: {} }));
      const localDiff = this.recorder.diffStorage(storageBefore.local, storageAfter.local);
      if (localDiff.added.length || localDiff.changed.length || localDiff.removed.length) {
        this.store.addEvent({ t: t1, type: 'storage_diff', actionId: null, bucket: null, tabId, requestId: null, data: { area: 'local', ...localDiff } });
      }
      const sessionDiff = this.recorder.diffStorage(storageBefore.session, storageAfter.session);
      if (sessionDiff.added.length || sessionDiff.changed.length || sessionDiff.removed.length) {
        this.store.addEvent({ t: t1, type: 'storage_diff', actionId: null, bucket: null, tabId, requestId: null, data: { area: 'session', ...sessionDiff } });
      }

      const domAfter = await this.recorder.domCounters(page).catch(() => domBefore);
      const domDelta = { added: domAfter.added - domBefore.added, removed: domAfter.removed - domBefore.removed, attributes: domAfter.attributes - domBefore.attributes };
      if (domDelta.added || domDelta.removed || domDelta.attributes) {
        this.store.addEvent({ t: t1, type: 'dom_delta', actionId: null, bucket: null, tabId, requestId: null, data: domDelta });
      }
    }

    const openedTabIds = session.allTabs().map((t) => t.id).filter((tid) => !tabsBefore.has(tid));
    const window: ActionWindow = { id, t0, t1, tabId, navigated: urlAfter !== urlBefore, openedTabIds };

    const inWindowRequests = this.store.requests({ since: t0, until: t1 });
    // R16: recurrence detection only needs recent history, not the whole
    // session's request table; bound the lookback instead of loading
    // everything on every action.
    // ponytail: fixed multiple of the window, not an index — revisit if a
    // session runs long enough for this to show up in profiling.
    const historyWindowMs = Math.max(this.config.maxWindowMs * 10, 30_000);
    const history = this.store.requests({ since: Math.max(0, t0 - historyWindowMs), until: t0 });
    const reqBuckets = attributeRequests(window, inWindowRequests, history);
    for (const [reqId, bucket] of reqBuckets) {
      this.store.setRequestAttribution(reqId, bucket === 'attributed' ? id : null, bucket);
    }

    const inWindowEvents = this.store.events({ since: t0, until: t1 });
    const eventBuckets = new Map<number, EventBucket>();
    for (const ev of inWindowEvents) {
      // R7: a request/response/redirect/... event takes its request's own
      // bucket rather than being classified independently — attribute.ts has
      // no notion of "this event's request", only the engine can join them.
      const bucket =
        NETWORK_EVENT_TYPES.includes(ev.type) && ev.requestId && reqBuckets.has(ev.requestId)
          ? reqBuckets.get(ev.requestId)!
          : attributeEvent(window, ev.type, ev.tabId, ev.data);
      eventBuckets.set(ev.id, bucket);
    }
    for (const [evId, bucket] of eventBuckets) {
      this.store.setEventAttribution([evId], bucket === 'attributed' ? id : null, bucket);
    }

    let hiddenBackground = 0;
    let hiddenUnattributed = 0;
    for (const bucket of reqBuckets.values()) {
      if (bucket === 'background') hiddenBackground++;
      else if (bucket === 'unattributed') hiddenUnattributed++;
    }
    for (const bucket of eventBuckets.values()) {
      if (bucket === 'background') hiddenBackground++;
      else if (bucket === 'unattributed') hiddenUnattributed++;
    }

    const attributedRequests = inWindowRequests
      .filter((r) => reqBuckets.get(r.id) === 'attributed')
      .map((r) => ({ ...r, actionId: id, bucket: 'attributed' as const }));
    const attributedEvents = inWindowEvents
      .filter((e) => eventBuckets.get(e.id) === 'attributed')
      .map((e) => ({ ...e, actionId: id, bucket: 'attributed' as const }));

    const newElements = newInteractiveCount(beforeTree, afterTree);

    if (blocked) {
      this.store.addEvent({ t: t1, type: 'blocked_state', actionId: id, bucket: 'attributed', tabId, requestId: null, data: { reason: blocked } });
      attributedEvents.push({ id: -1, t: t1, type: 'blocked_state', actionId: id, bucket: 'attributed', tabId, requestId: null, data: { reason: blocked } });
    }

    const summary = buildSummary({
      action: { ...action, urlAfter, t1 },
      attributedRequests,
      attributedEvents,
      hiddenBackground,
      hiddenUnattributed,
      newElements,
      blocked,
    });

    const finalSecret = ctx.secret;
    const finalValue = ctx.value;
    // (registered earlier, right after `perform`, so the "after" snapshot
    // above is already masked — see the S3 comment there.)

    const patch: Partial<Omit<ActionRecord, 'id'>> = {
      t1,
      urlAfter,
      summary,
      snapshotAfter,
      secret: finalSecret,
    };
    if (ctx.target !== undefined) patch.target = ctx.target;
    if (ctx.targetName !== undefined) patch.targetName = ctx.targetName;
    if (finalValue !== undefined) patch.value = finalSecret ? MASK : finalValue;
    if (error !== undefined) patch.error = error;
    this.store.updateAction(id, patch);
    this.emitLifecycle('action_end', id, tabId, input.kind, input.source);

    const recoveredFromCrash = session.consumeRecovered();
    const recoveredFromRelaunch = this.consumeRelaunched();
    const recoveredPrefix = recoveredFromRelaunch
      ? 'recovered: browser relaunched · '
      : recoveredFromCrash
        ? 'recovered: page crashed · '
        : '';

    if (error !== undefined) {
      throw new RastroError(`${recoveredPrefix}${error}`, hint);
    }

    // R6: `waitForQuiet` already tells us when it hit the ceiling instead of
    // settling; say so instead of silently reporting a summary as if the
    // window had closed naturally.
    const text = withWindowCutNote(formatSummary(id, summary, { base: urlBefore }), timedOut, this.config.maxWindowMs);
    return { text: `${recoveredPrefix}${text}`, data: this.maskData({ action: id, summary }) };
  }

  private emitLifecycle(type: 'action_start' | 'action_end', actionId: number, tabId: string, kind: ActionKind, source: ActionRecord['source']): void {
    this.store.addEvent({ t: this.now(), type, actionId, bucket: 'attributed', tabId, requestId: null, data: { kind, source } });
  }

  async act(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(ActParamsSchema, rawParams);
    return this.runAction({
      kind: params.kind,
      source: 'agent',
      ref: params.ref,
      value: params.value,
      secret: params.secret,
      perform: async (page, ctx) => {
        const locator = await this.resolveRef(page, params.ref);
        const node = findRef(ctx.beforeTree, params.ref);
        ctx.targetName = node?.name ?? '';
        try {
          ctx.target = await captureBundle(locator, node ?? undefined);
        } catch {
          // best effort: an unresolvable bundle just means detail()/flows lose a fallback locator.
        }
        if (ctx.target?.inputType === 'password') ctx.secret = true;

        const timeout = this.config.timeoutMs;
        switch (params.kind) {
          case 'click':
            await locator.click({ timeout });
            break;
          case 'dblclick':
            await locator.dblclick({ timeout });
            break;
          case 'fill':
            await locator.fill(params.value ?? '', { timeout });
            break;
          case 'type':
            await locator.pressSequentially(params.value ?? '', { timeout });
            break;
          case 'press':
            await locator.press(params.value ?? '', { timeout });
            break;
          case 'select':
            // Playwright waits the full timeout for an option that will never
            // appear, then reports only that it timed out. For an agent that is
            // 30 seconds and no idea what to try next, so check the options
            // first and say what they are.
            await selectOption(locator, params.value ?? '', timeout);
            break;
          case 'check':
            await locator.check({ timeout });
            break;
          case 'uncheck':
            await locator.uncheck({ timeout });
            break;
          case 'hover':
            await locator.hover({ timeout });
            break;
          case 'scroll':
            await locator.scrollIntoViewIfNeeded({ timeout });
            break;
          case 'upload': {
            const filePath = params.value ?? '';
            this.assertUploadAllowed(filePath);
            await locator.setInputFiles(filePath, { timeout });
            break;
          }
        }
      },
    });
  }

  /** S7: a page (hostile or not) can point `upload` anywhere on disk it can
   * name; only the session's own uploads dir and whatever `open
   * --allow-upload` added are fair game. Symlinks are resolved first so a
   * link inside an allowed dir cannot point back out. */
  assertUploadAllowed(filePath: string): void {
    const session = this.requireSession();
    let real: string;
    try {
      real = realpathSync(filePath);
    } catch {
      throw new RastroError('upload outside allowed dirs', 'open --allow-upload <dir>');
    }
    const allowed = session.uploadDirs.some((dir) => {
      try {
        const realDir = realpathSync(dir);
        return real === realDir || real.startsWith(`${realDir}/`);
      } catch {
        return false;
      }
    });
    if (!allowed) throw new RastroError('upload outside allowed dirs', 'open --allow-upload <dir>');
  }

  // --- investigation -----------------------------------------------------

  async history(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(
      z.object({ limit: z.number().optional(), from: z.number().optional(), to: z.number().optional() }),
      rawParams,
    );
    const query: { limit?: number; from?: number; to?: number } = {};
    if (params.from !== undefined) query.from = params.from;
    if (params.to !== undefined) query.to = params.to;
    query.limit = params.limit ?? (params.from === undefined && params.to === undefined ? 20 : undefined);
    if (query.limit === undefined) delete query.limit;
    const actions = this.store.actions(query);
    return { text: formatHistory(actions, this.secrets), data: this.maskData(actions) };
  }

  private windowFor(action: ActionRecord): { since: number; until: number } {
    return { since: action.t0, until: action.t1 ?? this.now() };
  }

  async effects(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(ActionIdSchema.extend({ all: z.boolean().optional() }), rawParams);
    const action = this.store.getAction(params.action);
    if (!action) throw new RastroError(`no action #${params.action}`, 'run rastro history');
    this.reattributeLateNetworkEvents();
    const { since, until } = this.windowFor(action);
    // R9: everything in the time window regardless of tab used to leak a
    // second tab's activity into this action's effects; keep only what was
    // actually attributed to this action, plus its own tab's unclassified
    // (background/unattributed) events.
    const belongsToAction = <T extends { actionId: number | null; tabId: string }>(rec: T): boolean =>
      rec.actionId === action.id || (rec.actionId === null && rec.tabId === action.tabId);
    const requests = this.store.requests({ since, until }).filter(belongsToAction);
    const events = this.store.events({ since, until }).filter(belongsToAction);
    const text = formatEffects(
      {
        action,
        requests,
        events,
        hiddenBackground: action.summary?.hiddenBackground ?? 0,
        hiddenUnattributed: action.summary?.hiddenUnattributed ?? 0,
        all: params.all ?? false,
      },
      this.secrets,
    );
    return { text, data: this.maskData({ action, requests, events }) };
  }

  async trace(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = z
      .object({
        action: z.number().optional(),
        since: z.number().optional(),
        type: z.array(z.string()).optional(),
        bg: z.boolean().optional(),
        limit: z.number().optional(),
      })
      .parse(rawParams);

    this.reattributeLateNetworkEvents();

    const query: Parameters<TraceStore['events']>[0] = {};
    if (params.action !== undefined) query.actionId = params.action;
    if (params.since !== undefined) query.since = params.since;
    if (params.type?.length) query.types = params.type as EventType[];
    if (params.limit !== undefined) query.limit = params.limit;

    // R8: filtering with `buckets: ['attributed', 'unattributed']` drops a
    // row whose bucket is still SQL NULL (never fell inside any action's
    // window) along with the background ones we actually mean to hide;
    // post-filter instead so null/unattributed both show by default.
    let events = this.store.events(query);
    if (!params.bg) events = events.filter((e) => e.bucket !== 'background');

    const actions = this.store.actions();
    const requests = new Map(this.store.requests().map((r) => [r.id, r]));
    return { text: formatTrace({ actions, events, requests }, this.secrets), data: this.maskData(events) };
  }

  async request(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(RequestParamsSchema, rawParams);
    const rec = this.store.getRequest(params.id);
    if (!rec) throw new RastroError(`no request ${params.id}`);
    const reveal = params.reveal ?? false;

    if (params.curl) {
      return { text: toCurl(rec, reveal, this.secrets), data: this.maskData(rec, reveal) };
    }

    let body: { text: string; truncated: boolean } | null = null;
    const files: string[] = [];
    if ((params.body || params.full) && rec.bodyHash) {
      if (params.full) {
        const buf = this.bodies.read(rec.bodyHash);
        if (buf) {
          const filePath = join(this.paths.out, `${rec.id}-body`);
          writeFileSync(filePath, buf);
          files.push(filePath);
        }
      } else {
        const buf = this.bodies.read(rec.bodyHash, 1024);
        if (buf) body = { text: buf.toString('utf8'), truncated: (rec.bodySize ?? 0) > 1024 };
      }
    }

    const text = formatRequest(rec, { body, reveal }, this.secrets) + (files.length ? `\nbody written to ${files[0]}` : '');
    // --json used to drop the body entirely, so a caller asking for both got
    // headers and nothing else. Carry whatever the text form carries.
    const data = { ...this.maskData(rec, reveal), ...(body ? { body: body.text, bodyTruncated: body.truncated } : {}) };
    return { text, data, ...(files.length ? { files } : {}) };
  }

  async snapshot(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(ActionIdSchema.extend({ phase: z.enum(['before', 'after']).optional() }), rawParams);
    const action = this.store.getAction(params.action);
    if (!action) throw new RastroError(`no action #${params.action}`, 'run rastro history');
    const snapshotId =
      params.phase === 'before' ? action.snapshotBefore : (action.snapshotAfter ?? action.snapshotBefore);
    if (snapshotId === undefined) throw new RastroError(`no snapshot for action #${params.action}`);
    const snap = this.store.getSnapshot(snapshotId);
    if (!snap) throw new RastroError(`no snapshot for action #${params.action}`);
    const view = buildView(snap, {});
    return { text: formatView(view), data: this.maskData(snap) };
  }

  async screenshot(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(z.object({ path: z.string().optional(), full: z.boolean().optional() }), rawParams);
    const page = await this.ensureAlive();
    const filePath = params.path ?? join(this.paths.out, `screenshot-${Date.now()}.png`);
    await page.screenshot({ path: filePath, fullPage: params.full ?? false });
    return { text: filePath, data: { file: filePath }, files: [filePath] };
  }

  async console(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(z.object({ errors: z.boolean().optional(), limit: z.number().optional() }), rawParams);
    let events = this.store.events({ types: ['console', 'exception'] });
    if (params.errors) events = events.filter((e) => e.type === 'exception' || e.data.level === 'error');
    if (params.limit !== undefined) events = events.slice(-params.limit);
    return { text: formatConsole(events, this.secrets), data: events };
  }

  async cookies(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(RevealParamsSchema, rawParams);
    const reveal = params.reveal ?? false;
    const session = this.requireSession();
    const cookies = await this.recorder.cookies(session.context);
    return { text: formatCookies(cookies, reveal), data: this.maskData(cookies, reveal) };
  }

  async storage(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(RevealParamsSchema, rawParams);
    const reveal = params.reveal ?? false;
    const page = await this.ensureAlive();
    const raw = await this.recorder.storage(page);
    const entries = [
      ...Object.entries(raw.local).map(([key, value]) => ({ area: 'local' as const, key, value })),
      ...Object.entries(raw.session).map(([key, value]) => ({ area: 'session' as const, key, value })),
    ];
    // Same rule the formatted text already applies: a field named like a
    // credential is masked even if its value was never typed through `act`
    // (so never registered in `secrets`) — e.g. a token the page set itself.
    const masked = entries.map((e) => (!reveal && isSensitiveFieldName(e.key) ? { ...e, value: MASK } : e));
    return { text: formatStorage(entries, reveal, this.secrets), data: this.maskData(masked, reveal) };
  }

  async tabs(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(z.object({ select: z.string().optional(), close: z.string().optional() }), rawParams);
    const session = this.requireSession();
    if (params.select) {
      const tab = session.tab(params.select);
      if (!tab) throw new RastroError(`no tab ${params.select}`, 'run rastro tabs');
      session.activeTabId = tab.id;
      await tab.page.bringToFront().catch(() => undefined);
    }
    if (params.close) {
      const tab = session.tab(params.close);
      if (!tab) throw new RastroError(`no tab ${params.close}`, 'run rastro tabs');
      if (session.allTabs().length === 1) throw new RastroError('cannot close the last tab', 'use rastro close');
      await tab.page.close();
      if (session.activeTabId === tab.id) {
        const next = session.allTabs().find((t) => t.id !== tab.id);
        if (next) session.activeTabId = next.id;
      }
    }
    const tabs = await Promise.all(
      session.allTabs().map(async (t) => ({
        id: t.id,
        url: t.page.url(),
        title: await this.safeTitle(t.page),
        active: t.id === session.activeTabId,
      })),
    );
    return { text: formatTabs(tabs), data: tabs };
  }

  async eval(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = z.object({ ref: z.string().optional(), expr: z.string() }).parse(rawParams);
    const page = await this.ensureAlive();
    let result: unknown;
    if (params.ref) {
      const locator = await this.resolveRef(page, params.ref);
      result = await locator.evaluate(new Function('el', `return (${params.expr});`) as (el: Element) => unknown);
    } else {
      result = await page.evaluate(params.expr);
    }
    // No truncation here: the CLI already spills anything over 4 KB to a 0600
    // file. Cutting at 1 KB in the engine silently ate the tail of any real
    // extraction and left no marker saying so.
    return { text: JSON.stringify(result ?? null), data: result };
  }

  async replay(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(ReplayParamsSchema, rawParams);
    if (!params.yes) {
      // An error, not a note: this exits non-zero, so a script that replays
      // without the flag cannot mistake the refusal for a completed replay.
      throw new RastroError(
        `replay of ${params.id} requires --yes: it may have real effects`,
        `rastro replay ${params.id} --yes`,
      );
    }
    const rec = this.store.getRequest(params.id);
    if (!rec) throw new RastroError(`no request ${params.id}`);
    const session = this.requireSession();

    return this.runAction({
      kind: 'replay',
      source: 'agent',
      targetName: rec.url,
      perform: async (_page, ctx) => {
        void ctx;
        let host = '';
        try {
          host = new URL(rec.url).hostname;
        } catch {
          // malformed URL: falls through to blocked below, same as the live write guard.
        }
        const allowed = session.allowWrite.includes('*') || session.allowWrite.some((h) => host === h || host.endsWith(`.${h}`));
        if (!allowed) {
          this.store.addEvent({
            t: this.now(),
            type: 'blocked_write',
            actionId: null,
            bucket: null,
            tabId: session.activeTabId,
            requestId: null,
            data: { method: rec.method, url: rec.url, host },
          });
          return;
        }
        // `context.request` bypasses page routing (it is not a page navigation
        // or fetch), so the write guard above is applied by hand instead.
        const options: { method: string; headers: Record<string, string>; data?: string } = {
          method: rec.method,
          headers: rec.requestHeaders,
        };
        if (rec.postData !== undefined) options.data = rec.postData;
        await session.context.request.fetch(rec.url, options);
      },
    });
  }

  async export(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(ExportParamsSchema, rawParams);
    const session = this.requireSession();
    const sessionRec = this.store.getSession();
    const startedAt = sessionRec?.startedAt ?? new Date().toISOString();

    if (params.format === 'har') {
      const har = toHar({
        startedAt,
        creatorVersion: VERSION,
        requests: this.store.requests(),
        actions: this.store.actions(),
        // S5: explicit, rather than relying on toHar's own no-mask-given
        // default, so this stays safe even if that default ever changes;
        // request bodies are opt-in via `--bodies` (R11) — omitted, response
        // content is omitted too, matching how `request --body` behaves.
        mask: (h) => maskHeaders(h, false),
        ...(params.bodies
          ? {
              body: (hash: string) => {
                const buf = this.bodies.read(hash);
                return buf ? { text: buf.toString('utf8') } : undefined;
              },
            }
          : {}),
      });
      const filePath = params.path ?? join(this.paths.exports, `export-${Date.now()}.har`);
      // Belt-and-suspenders: also scrub any typed secret that slipped past
      // the structural header/body masking above (e.g. echoed into a URL).
      writeFileSync(filePath, this.secrets.mask(JSON.stringify(har)), { mode: 0o600 });
      return { text: filePath, data: { file: filePath }, files: [filePath] };
    }

    if (params.format === 'perfetto') {
      const perfetto = toPerfetto({
        requests: this.store.requests(),
        actions: this.store.actions(),
        events: this.store.events(),
        sessionName: sessionRec?.name ?? 'default',
      });
      const filePath = params.path ?? join(this.paths.exports, `export-${Date.now()}.json`);
      writeFileSync(filePath, this.secrets.mask(JSON.stringify(perfetto)), { mode: 0o600 });
      return { text: filePath, data: { file: filePath }, files: [filePath] };
    }

    if (!this.config.pwTrace) {
      throw new RastroError('pw-trace export requires the session to be opened with --pw-trace');
    }
    // S4: a Playwright trace zip embeds screenshots/DOM snapshots with
    // whatever was typed and the live cookie jar — it cannot be redacted
    // after the fact the way HAR/perfetto can. Refuse once a secret has been
    // typed this session unless the caller explicitly accepts that.
    if (this.secrets.size > 0 && !params.reveal) {
      throw new RastroError(
        'export pw-trace refused: a secret was typed this session and the trace cannot be redacted',
        'pass --reveal to export anyway',
      );
    }
    const filePath = params.path ?? join(this.paths.exports, `export-${Date.now()}.zip`);
    await session.context.tracing.stop({ path: filePath });
    chmodSync(filePath, 0o600);
    // tracing.stop ends the recording; restart it so later actions keep being traced.
    await session.context.tracing.start({ screenshots: true, snapshots: true });
    const warning = 'warning: pw-trace is NOT redacted; it contains typed text and cookies';
    return { text: `${filePath}\n${warning}`, data: { file: filePath }, files: [filePath] };
  }

  async status(): Promise<RpcResult> {
    const open = this.session !== undefined;
    const data = {
      open,
      url: open ? this.session!.activePage().url() : undefined,
      activeTab: open ? this.session!.activeTabId : undefined,
      actions: this.store.actions().length,
    };
    return { text: `session ${open ? 'open' : 'closed'}${open ? ` · ${data.url}` : ''}`, data };
  }

  async close(): Promise<RpcResult> {
    await this.shutdown();
    return { text: 'closed', data: null };
  }

  async recordStart(rawParams: Record<string, unknown>): Promise<RpcResult> {
    return this.flows.recordStart(rawParams);
  }
  async recordStop(rawParams: Record<string, unknown>): Promise<RpcResult> {
    return this.flows.recordStop(rawParams);
  }
  async flowSave(rawParams: Record<string, unknown>): Promise<RpcResult> {
    return this.flows.flowSave(rawParams);
  }
  async flowRun(rawParams: Record<string, unknown>): Promise<RpcResult> {
    return this.flows.flowRun(rawParams);
  }
  async flowExport(rawParams: Record<string, unknown>): Promise<RpcResult> {
    return this.flows.flowExport(rawParams);
  }
  async flowImport(rawParams: Record<string, unknown>): Promise<RpcResult> {
    return this.flows.flowImport(rawParams);
  }
}

export async function createEngine(session: string): Promise<Engine & { shutdown(): Promise<void> }> {
  return EngineCore.create(session);
}
