// Browser/context/page lifecycle: tabs registry, dialog policy, downloads,
// popups, crash detection with lazy relaunch, and the write guard.

import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import type { SessionPaths } from '../core/paths.ts';

export interface TabRecord {
  id: string;
  page: Page;
}

export interface SessionOptions {
  headed?: boolean;
  allowWrite?: string[];
  /** Absolute directories `upload` may read from, besides the session uploads dir. */
  allowUpload?: string[];
  dialogs?: 'accept' | 'dismiss';
}

/** Callbacks the engine wires up to turn session lifecycle moments into trace
 * events; session.ts has no store dependency of its own. */
export interface SessionHooks {
  onPageCreated(tab: TabRecord): void;
  onTabOpen(tabId: string, url: string): void;
  onTabClose(tabId: string): void;
  onDialog(tabId: string, kind: string, message: string, handled: 'accepted' | 'dismissed'): void;
  onDownload(tabId: string, filename: string, path: string, size: number | undefined): void;
  onBlockedWrite(tabId: string, method: string, url: string, host: string): void;
  onCrash(tabId: string): void;
  /**
   * Best-effort sighting of every context-wide request as Playwright's own
   * router sees it: synchronous and active from the moment the context
   * exists, so (unlike a per-page CDP session, which attaches lazily and can
   * miss a popup's opening requests, R5) it never misses a popup's earliest
   * traffic. Optional: callers that don't need it aren't forced to wire it.
   */
  onRequestSeen?(tabId: string, method: string, url: string, resourceType: string): void;
}

function resolveExecutablePath(): string | undefined {
  const fromEnv = process.env.RASTRO_CHROMIUM;
  if (fromEnv) return fromEnv;
  return existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined;
}

/** Strips a single trailing dot (a trailing-dot FQDN is the same host as its
 * bare form) and lowercases, so allowlist entries and hosts compare equal
 * regardless of case or a trailing-dot form. */
function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

/**
 * `host` matches the allowlist exactly or as a subdomain; `*` allows any
 * host. An empty host or an empty/blank allowlist entry never matches
 * anything (S10) — otherwise `host.endsWith('.' + '')` is true for every
 * host, silently turning `['']` into an allow-all.
 */
export function hostAllowed(host: string, allowlist: string[]): boolean {
  if (allowlist.includes('*')) return true;
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost) return false;
  return allowlist.some((raw) => {
    if (!raw) return false;
    const allowed = normalizeHost(raw);
    if (!allowed) return false;
    return normalizedHost === allowed || normalizedHost.endsWith(`.${allowed}`);
  });
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const EGL_VENDOR_DIR = '/usr/share/glvnd/egl_vendor.d';
const VULKAN_ICD_DIR = '/usr/share/vulkan/icd.d';

/**
 * Environment for the browser process. `--disable-gpu` alone still lets
 * Chromium's gpu-process load libEGL_nvidia and open /dev/nvidiactl (measured
 * on a muxless laptop), which keeps a discrete NVIDIA GPU awake. When NVIDIA's
 * vendor files are installed, point GLVND and the Vulkan loader at the
 * non-NVIDIA ones instead. Explicit user values win; RASTRO_KEEP_GPU_ENV=1
 * disables the override.
 */
export function browserEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = Object.fromEntries(Object.entries(base).filter((e): e is [string, string] => e[1] !== undefined));
  if (base.RASTRO_KEEP_GPU_ENV === '1') return env;
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
  };
  const egl = list(EGL_VENDOR_DIR);
  if (egl.some((f) => f.includes('nvidia')) && env.__EGL_VENDOR_LIBRARY_FILENAMES === undefined) {
    const others = egl.filter((f) => !f.includes('nvidia')).map((f) => join(EGL_VENDOR_DIR, f));
    if (others.length) env.__EGL_VENDOR_LIBRARY_FILENAMES = others.join(':');
    env.__GLX_VENDOR_LIBRARY_NAME ??= 'mesa';
  }
  const icds = list(VULKAN_ICD_DIR);
  if (icds.some((f) => f.includes('nvidia')) && env.VK_ICD_FILENAMES === undefined && env.VK_DRIVER_FILES === undefined) {
    const others = icds.filter((f) => !f.includes('nvidia')).map((f) => join(VULKAN_ICD_DIR, f));
    if (others.length) env.VK_ICD_FILENAMES = others.join(':');
  }
  env.CUDA_VISIBLE_DEVICES ??= '';
  return env;
}

export class Session {
  context: BrowserContext;
  readonly downloadsPath: string;
  allowWrite: string[];
  /** Session uploads dir plus any `allowUpload` dirs from the latest options. */
  uploadDirs: string[];
  dialogs: 'accept' | 'dismiss';
  activeTabId = '';

  private readonly tabs = new Map<string, TabRecord>();
  private readonly crashedTabs = new Set<string>();
  private readonly writeGuardReady = new Map<Page, Promise<void>>();
  private readonly hooks: SessionHooks;
  private readonly paths: SessionPaths;
  private readonly headed: boolean;
  private nextTabSeq = 0;
  private closedByUs = false;
  private recoveredFromCrash = false;
  private isDead = false;

  private constructor(context: BrowserContext, paths: SessionPaths, opts: SessionOptions, hooks: SessionHooks) {
    this.hooks = hooks;
    this.context = context;
    this.paths = paths;
    this.downloadsPath = paths.downloads;
    this.allowWrite = opts.allowWrite ?? [];
    this.uploadDirs = [paths.uploads, ...(opts.allowUpload ?? [])];
    this.dialogs = opts.dialogs ?? 'accept';
    this.headed = opts.headed ?? false;
  }

  /** True after an unexpected context or browser close (not our own
   * `close()`), or after a page crash. Call `relaunch()` to recover. */
  get dead(): boolean {
    return this.isDead;
  }

  static async launch(paths: SessionPaths, opts: SessionOptions, hooks: SessionHooks): Promise<Session> {
    const context = await Session.createContext(paths, opts);
    const session = new Session(context, paths, opts, hooks);
    session.wireContext();

    const initial = context.pages()[0] ?? (await context.newPage());
    session.registerPage(initial, false);
    await session.whenWriteGuardReady(initial);
    return session;
  }

  private static async createContext(paths: SessionPaths, opts: SessionOptions): Promise<BrowserContext> {
    const headed = opts.headed ?? false;
    const args = ['--disable-gpu', ...(headed && process.env.WAYLAND_DISPLAY ? ['--ozone-platform=wayland'] : [])];
    return chromium.launchPersistentContext(paths.profile, {
      executablePath: resolveExecutablePath(),
      headless: !headed,
      args,
      env: browserEnv(),
      acceptDownloads: true,
      downloadsPath: paths.downloads,
      viewport: { width: 1280, height: 900 },
    });
  }

  /** Wires the context-level listeners (write guard, popups, crash
   * detection) that must be re-installed on every fresh context, whether
   * from `launch()` or `relaunch()`. */
  private wireContext(): void {
    this.installWriteGuard();
    this.context.on('page', (page) => this.registerPage(page, true));
    this.context.on('close', () => {
      if (this.closedByUs) return;
      this.isDead = true;
      this.safeHook(() => this.hooks.onCrash(this.activeTabId));
    });
  }

  /**
   * Rebuilds the browser/tab state after `dead` becomes true: launches a
   * fresh persistent context and initial page with the same paths/options,
   * reinstalls the write guard, and re-registers tabs. The engine re-attaches
   * the recorder to the new active page afterwards by reading `activePage()`.
   */
  async relaunch(): Promise<void> {
    // The old context may still be alive (e.g. a caller proactively
    // relaunching after a single tab crash without a context close): close it
    // ourselves so its 'close' handler doesn't fire a second, stale crash.
    this.closedByUs = true;
    await this.context.close().catch(() => {});

    this.tabs.clear();
    this.crashedTabs.clear();
    this.activeTabId = '';
    this.closedByUs = false;
    this.isDead = false;

    const opts: SessionOptions = { headed: this.headed, allowWrite: this.allowWrite, dialogs: this.dialogs };
    this.context = await Session.createContext(this.paths, opts);
    this.wireContext();

    const initial = this.context.pages()[0] ?? (await this.context.newPage());
    this.registerPage(initial, false);
    await this.whenWriteGuardReady(initial);
  }

  /** Mutates the live session's allowlist/dialog policy in place. */
  applyOptions(opts: { allowWrite?: string[]; allowUpload?: string[]; dialogs?: 'accept' | 'dismiss' }): void {
    if (opts.allowWrite !== undefined) this.allowWrite = opts.allowWrite;
    if (opts.allowUpload !== undefined) this.uploadDirs = [this.paths.uploads, ...opts.allowUpload];
    if (opts.dialogs !== undefined) this.dialogs = opts.dialogs;
  }

  browser(): Browser | null {
    return this.context.browser();
  }

  tab(id: string): TabRecord | undefined {
    return this.tabs.get(id);
  }

  allTabs(): TabRecord[] {
    return [...this.tabs.values()];
  }

  activePage(): Page {
    const tab = this.tabs.get(this.activeTabId);
    if (!tab) throw new Error(`no active tab (id ${this.activeTabId})`);
    return tab.page;
  }

  /** True when the active page crashed or the whole context closed
   * unexpectedly since the last call. */
  needsRecovery(): boolean {
    return this.crashedTabs.has(this.activeTabId) || !this.tabs.has(this.activeTabId);
  }

  /** Replaces a crashed active page with a fresh one, recording that the
   * next action summary should mention the recovery. Only valid while the
   * context itself is still alive — once the whole session is `dead`, the
   * context is closed and `context.newPage()` would throw; call `relaunch()`
   * instead. */
  async recover(): Promise<Page> {
    if (this.isDead) throw new Error('session is dead; call relaunch() instead of recover()');
    this.crashedTabs.delete(this.activeTabId);
    const page = await this.context.newPage();
    const id = this.activeTabId || this.allocateTabId();
    this.activeTabId = id;
    this.tabs.set(id, { id, page });
    this.writeGuardReady.set(page, this.wirePage(page, id));
    this.safeHook(() => this.hooks.onPageCreated({ id, page }));
    await this.whenWriteGuardReady(page);
    this.recoveredFromCrash = true;
    return page;
  }

  /** Reads and clears the "recovered from a crash" flag. */
  consumeRecovered(): boolean {
    const value = this.recoveredFromCrash;
    this.recoveredFromCrash = false;
    return value;
  }

  tabIdForPage(page: Page): string | undefined {
    for (const tab of this.tabs.values()) {
      if (tab.page === page) return tab.id;
    }
    return undefined;
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    await this.context.close();
  }

  private allocateTabId(): string {
    this.nextTabSeq += 1;
    return `t${this.nextTabSeq}`;
  }

  /** Runs a hook callback without letting it escape into whatever
   * EventEmitter (Playwright's `page`/`dialog`/`download`/`close`) invoked
   * us — a throwing hook must not be able to crash the browser session or
   * leave a `page`/`context` listener half-run (R1). */
  private safeHook(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error('rastro: session hook threw', err);
    }
  }

  private registerPage(page: Page, isPopup: boolean): TabRecord {
    const id = this.allocateTabId();
    const tab: TabRecord = { id, page };
    this.tabs.set(id, tab);
    if (!isPopup) this.activeTabId = id;

    this.writeGuardReady.set(page, this.wirePage(page, id));
    this.safeHook(() => this.hooks.onPageCreated(tab));

    // Recorded immediately (not after the popup's own load settles) so it
    // lands inside the opening action's attribution window; the URL is
    // best-effort and may still be about:blank at this instant.
    if (isPopup) this.safeHook(() => this.hooks.onTabOpen(id, page.url()));

    return tab;
  }

  /**
   * Resolves once `page`'s per-page write guard (the redirect-blocking CDP
   * Fetch session, S6) has finished attaching. `launch()`/`relaunch()` await
   * this for the initial page so a caller that navigates immediately after
   * (every real caller does — `open()` is exactly that) can't race the CDP
   * handshake and slip a request past the guard. Best-effort for a page this
   * session never registered.
   */
  private async whenWriteGuardReady(page: Page): Promise<void> {
    await this.writeGuardReady.get(page);
  }

  private wirePage(page: Page, id: string): Promise<void> {
    page.on('crash', () => {
      this.crashedTabs.add(id);
      this.isDead = true;
      this.safeHook(() => this.hooks.onCrash(id));
    });

    page.on('close', () => {
      this.writeGuardReady.delete(page);
      if (this.tabs.get(id)?.page !== page) return;
      this.tabs.delete(id);
      if (!this.crashedTabs.has(id)) this.safeHook(() => this.hooks.onTabClose(id));
    });

    page.on('dialog', (dialog) => {
      const accept = this.dialogs !== 'dismiss';
      const handled = accept ? 'accepted' : 'dismissed';
      const kind = dialog.type();
      const message = dialog.message();
      void (accept ? dialog.accept() : dialog.dismiss())
        .then(() => {
          this.safeHook(() => this.hooks.onDialog(id, kind, message, handled));
        })
        .catch((err: unknown) => {
          // The page/context can close between the dialog firing and us
          // accepting/dismissing it; that leaves nothing to record, but must
          // never surface as an unhandled rejection (R1).
          console.error('rastro: dialog handling failed', err);
        });
    });

    page.on('download', (download) => {
      void (async () => {
        const filename = download.suggestedFilename();
        const dest = join(this.downloadsPath, filename);
        await download.saveAs(dest);
        try {
          chmodSync(dest, 0o600);
        } catch {
          // best effort only: saveAs already succeeded, permissions are cosmetic.
        }
        let size: number | undefined;
        try {
          size = statSync(dest).size;
        } catch {
          // best effort only; the download event still fires without a size.
        }
        this.safeHook(() => this.hooks.onDownload(id, filename, dest, size));
      })().catch((err: unknown) => {
        console.error('rastro: download handling failed', err);
      });
    });

    // No `page.on('popup', ...)` listener: the context-level `page` event
    // registered in `launch()`/`relaunch()` already fires for every new
    // page, including popups, and adding both would register each popup as
    // two tabs.

    return this.installRedirectGuard(page).catch((err: unknown) => {
      console.error('rastro: redirect guard failed to attach', err);
    });
  }

  private installWriteGuard(): void {
    void this.context.route('**/*', async (route) => {
      const request = route.request();
      const method = request.method();

      let tabId: string | undefined;
      try {
        tabId = this.tabIdForPage(request.frame().page());
      } catch {
        // requests without an owning frame (e.g. from a worker) fall back below.
      }
      const resolvedTabId = tabId ?? this.activeTabId;
      this.safeHook(() => this.hooks.onRequestSeen?.(resolvedTabId, method, request.url(), request.resourceType()));

      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        await route.continue();
        return;
      }

      let host = '';
      try {
        host = new URL(request.url()).hostname;
      } catch {
        // malformed URL: falls through to blocked below.
      }

      if (hostAllowed(host, this.allowWrite)) {
        await route.continue();
        return;
      }

      this.safeHook(() => this.hooks.onBlockedWrite(resolvedTabId, method, request.url(), host));
      await route.abort('blockedbyclient');
    });
  }

  /**
   * `context.route()` only sees the leg it was given: a POST to an allowed
   * host that 301/302/303/307/308-redirects to a disallowed host is
   * delivered with its method and body intact, because Chromium's network
   * stack follows the redirect itself without re-invoking Playwright's route
   * handler for the new leg (verified against this project's Chromium build
   * — a POST redirected cross-host reached the second host unblocked). The
   * CDP Fetch domain, unlike `route()`, does re-pause at the *response*
   * stage of a redirect, so it can inspect the `Location` header before the
   * browser follows it (S6).
   */
  private async installRedirectGuard(page: Page): Promise<void> {
    const client = await page.context().newCDPSession(page);
    await client.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Response' }] });
    client.on('Fetch.requestPaused', (event) => {
      void this.handleRedirectPaused(client, page, event as CdpFetchRequestPaused).catch((err: unknown) => {
        console.error('rastro: redirect guard failed to resolve a paused request', err);
      });
    });
  }

  private async handleRedirectPaused(client: CDPSession, page: Page, event: CdpFetchRequestPaused): Promise<void> {
    const { requestId, request, responseStatusCode, responseHeaders } = event;
    const isRedirect = responseStatusCode !== undefined && REDIRECT_STATUSES.has(responseStatusCode);
    const nonIdempotent = !IDEMPOTENT_METHODS.has(request.method);

    if (isRedirect && nonIdempotent) {
      const location = responseHeaders?.find((h) => h.name.toLowerCase() === 'location')?.value;
      if (location) {
        let host = '';
        try {
          host = new URL(location, request.url).hostname;
        } catch {
          // malformed Location: treat as blocked below, same as an unresolvable host anywhere else.
        }
        if (!hostAllowed(host, this.allowWrite)) {
          const tabId = this.tabIdForPage(page) ?? this.activeTabId;
          this.safeHook(() => this.hooks.onBlockedWrite(tabId, request.method, location, host));
          await client.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
          return;
        }
      }
    }

    await client.send('Fetch.continueResponse', { requestId });
  }
}

// --- Minimal shape of the CDP Fetch payload this module reads; see the note
// atop recorder.ts's own CDP interfaces for why these are hand-written rather
// than imported from playwright-core's unexported protocol module.

interface CdpFetchHeaderEntry {
  name: string;
  value: string;
}

interface CdpFetchRequestPaused {
  requestId: string;
  request: { url: string; method: string };
  responseStatusCode?: number;
  responseHeaders?: CdpFetchHeaderEntry[];
}
