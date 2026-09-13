// Implements the `Engine` RPC surface: every command an agent or the CLI can
// issue against a session. Orchestrates session.ts (browser lifecycle),
// recorder.ts (trace capture) and the pure attribution/format modules.

import { writeFileSync } from 'node:fs';
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
import { SecretRegistry, MASK } from '../security/redact.ts';
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

const OpenParamsSchema = z.object({
  url: z.string().optional(),
  headed: z.boolean().optional(),
  allowWrite: z.array(z.string()).optional(),
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
});
const ActionIdSchema = z.object({ action: z.union([z.number(), z.string()]).transform((v) => Number(v)) });
const ReplayParamsSchema = z.object({ id: z.string(), yes: z.boolean().optional() });

function parse<T>(schema: z.ZodType<T>, params: Record<string, unknown>): T {
  const result = schema.safeParse(params);
  if (!result.success) throw new RastroError(`invalid params: ${result.error.message}`);
  return result.data;
}

interface SessionConfig {
  quietMs: number;
  maxWindowMs: number;
  timeoutMs: number;
  pwTrace: boolean;
}

interface RunActionCtx {
  beforeTree: AriaNode[];
  target?: LocatorBundle;
  targetName?: string;
  value?: string;
  secret: boolean;
}

interface RunActionInput {
  kind: ActionKind;
  source: ActionRecord['source'];
  ref?: string;
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
    if (this.session) await this.session.close().catch(() => {});
    this.store.close();
  }

  // --- session lifecycle -------------------------------------------------

  private requireSession(): Session {
    if (!this.session) throw new RastroError('no browser open', 'run rastro open <url>');
    return this.session;
  }

  private async ensureAlive(): Promise<Page> {
    const session = this.requireSession();
    if (session.needsRecovery()) {
      const page = await session.recover();
      this.attachPromises.set(page, this.recorder.attach(page, session.activeTabId));
    }
    const page = session.activePage();
    const attaching = this.attachPromises.get(page);
    if (attaching) await attaching;
    return page;
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

      const session = await Session.launch(
        this.paths,
        { headed: params.headed, allowWrite: params.allowWrite, dialogs: params.dialogs },
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
    }

    if (!params.url) {
      return { text: `session open · ${this.session.activePage().url()}`, data: { url: this.session.activePage().url() } };
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
    this.store.addSnapshot({ t: this.now(), tabId: session.activeTabId, url, title, tree });

    if (params.all) {
      const yamlText = await page.ariaSnapshot({ mode: 'ai' });
      const filePath = join(this.paths.out, `view-${Date.now()}.yaml`);
      writeFileSync(filePath, yamlText, 'utf8');
      return { text: filePath, data: { file: filePath }, files: [filePath] };
    }

    const view = buildView({ url, title, tree }, params);
    return { text: formatView(view, { urls: params.urls }), data: view };
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

  // --- the action pipeline ---------------------------------------------

  private async runAction(input: RunActionInput): Promise<RpcResult> {
    const page = await this.ensureAlive();
    const session = this.requireSession();
    const tabId = session.activeTabId;

    const id = this.store.nextActionId();
    const t0 = this.now();
    const urlBefore = page.url();

    const beforeTree = (await page.ariaSnapshotJSON({ mode: 'ai' })) as unknown as AriaNode[];
    const snapshotBefore = this.store.addSnapshot({ t: t0, tabId, url: urlBefore, title: await this.safeTitle(page), tree: beforeTree });
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

    let t1 = this.now();
    let afterTree = beforeTree;
    let urlAfter = urlBefore;
    let blocked: string | undefined;

    if (error === undefined) {
      const currentPage = session.tab(tabId)?.page ?? page;
      await waitForQuiet({
        pending: () => this.recorder.pending(),
        lastActivity: () => this.recorder.lastActivity(),
        now: () => this.now(),
        quietMs: this.config.quietMs,
        maxWindowMs: this.config.maxWindowMs,
        poll: async () => {
          await this.recorder.pollDomActivity(currentPage).catch(() => {});
          await new Promise((resolve) => setTimeout(resolve, 30));
        },
      });

      t1 = this.now();
      urlAfter = session.tab(tabId)?.page.url() ?? urlBefore;
      try {
        afterTree = (await currentPage.ariaSnapshotJSON({ mode: 'ai' })) as unknown as AriaNode[];
      } catch {
        afterTree = beforeTree;
      }
      blocked = await detectBlocked(currentPage).catch(() => undefined);
    }

    const snapshotAfter = this.store.addSnapshot({ t: t1, tabId, url: urlAfter, title: await this.safeTitle(page).catch(() => ''), tree: afterTree });

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
    const history = this.store.requests({ until: t0 });
    const reqBuckets = attributeRequests(window, inWindowRequests, history);
    for (const [reqId, bucket] of reqBuckets) {
      this.store.setRequestAttribution(reqId, bucket === 'attributed' ? id : null, bucket);
    }

    const inWindowEvents = this.store.events({ since: t0, until: t1 });
    const eventBuckets = new Map<number, EventBucket>();
    for (const ev of inWindowEvents) {
      eventBuckets.set(ev.id, attributeEvent(window, ev.type, ev.tabId, ev.data));
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
    if (finalSecret && finalValue) this.secrets.add(finalValue);

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

    const recovered = session.consumeRecovered();

    if (error !== undefined) {
      throw new RastroError(recovered ? `recovered: page crashed · ${error}` : error, hint);
    }

    const text = formatSummary(id, summary, { base: urlBefore });
    return { text: recovered ? `recovered: page crashed · ${text}` : text, data: { action: id, summary } };
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
            await locator.selectOption(params.value ?? '', { timeout });
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
          case 'upload':
            await locator.setInputFiles(params.value ?? '', { timeout });
            break;
        }
      },
    });
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
    return { text: formatHistory(actions, this.secrets), data: actions };
  }

  private windowFor(action: ActionRecord): { since: number; until: number } {
    return { since: action.t0, until: action.t1 ?? this.now() };
  }

  async effects(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(ActionIdSchema.extend({ all: z.boolean().optional() }), rawParams);
    const action = this.store.getAction(params.action);
    if (!action) throw new RastroError(`no action #${params.action}`, 'run rastro history');
    const { since, until } = this.windowFor(action);
    const requests = this.store.requests({ since, until });
    const events = this.store.events({ since, until });
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
    return { text, data: { action, requests, events } };
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

    const query: Parameters<TraceStore['events']>[0] = {};
    if (params.action !== undefined) query.actionId = params.action;
    if (params.since !== undefined) query.since = params.since;
    if (params.type?.length) query.types = params.type as EventType[];
    if (params.limit !== undefined) query.limit = params.limit;
    if (!params.bg) query.buckets = ['attributed', 'unattributed'];

    const events = this.store.events(query);
    const actions = this.store.actions();
    const requests = new Map(this.store.requests().map((r) => [r.id, r]));
    return { text: formatTrace({ actions, events, requests }, this.secrets), data: events };
  }

  async request(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(RequestParamsSchema, rawParams);
    const rec = this.store.getRequest(params.id);
    if (!rec) throw new RastroError(`no request ${params.id}`);
    const reveal = params.reveal ?? false;

    if (params.curl) {
      return { text: toCurl(rec, reveal, this.secrets), data: rec };
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
    return { text, data: rec, ...(files.length ? { files } : {}) };
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
    return { text: formatView(view), data: snap };
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
    const session = this.requireSession();
    const cookies = await this.recorder.cookies(session.context);
    return { text: formatCookies(cookies, params.reveal ?? false), data: cookies };
  }

  async storage(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(RevealParamsSchema, rawParams);
    const page = await this.ensureAlive();
    const raw = await this.recorder.storage(page);
    const entries = [
      ...Object.entries(raw.local).map(([key, value]) => ({ area: 'local' as const, key, value })),
      ...Object.entries(raw.session).map(([key, value]) => ({ area: 'session' as const, key, value })),
    ];
    return { text: formatStorage(entries, params.reveal ?? false, this.secrets), data: entries };
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
    const text = JSON.stringify(result ?? null).slice(0, 1024);
    return { text, data: result };
  }

  async replay(rawParams: Record<string, unknown>): Promise<RpcResult> {
    const params = parse(ReplayParamsSchema, rawParams);
    if (!params.yes) {
      return { text: `replay of ${params.id} requires --yes: it may have real effects`, data: null };
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
        body: (hash) => {
          const buf = this.bodies.read(hash);
          return buf ? { text: buf.toString('utf8') } : undefined;
        },
      });
      const filePath = params.path ?? join(this.paths.exports, `export-${Date.now()}.har`);
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
    const filePath = params.path ?? join(this.paths.exports, `export-${Date.now()}.zip`);
    await session.context.tracing.stop({ path: filePath });
    // tracing.stop ends the recording; restart it so later actions keep being traced.
    await session.context.tracing.start({ screenshots: true, snapshots: true });
    return { text: filePath, data: { file: filePath }, files: [filePath] };
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

  async recordStart(): Promise<RpcResult> {
    throw new RastroError('not implemented yet', 'coming in phase 2');
  }
  async recordStop(): Promise<RpcResult> {
    throw new RastroError('not implemented yet', 'coming in phase 2');
  }
  async flowSave(): Promise<RpcResult> {
    throw new RastroError('not implemented yet', 'coming in phase 2');
  }
  async flowRun(): Promise<RpcResult> {
    throw new RastroError('not implemented yet', 'coming in phase 2');
  }
  async flowExport(): Promise<RpcResult> {
    throw new RastroError('not implemented yet', 'coming in phase 2');
  }
  async flowImport(): Promise<RpcResult> {
    throw new RastroError('not implemented yet', 'coming in phase 2');
  }
}

export async function createEngine(session: string): Promise<Engine & { shutdown(): Promise<void> }> {
  return EngineCore.create(session);
}
