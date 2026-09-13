// Browser/context/page lifecycle: tabs registry, dialog policy, downloads,
// popups, crash detection with lazy relaunch, and the write guard.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { SessionPaths } from '../core/paths.ts';

export interface TabRecord {
  id: string;
  page: Page;
}

export interface SessionOptions {
  headed?: boolean;
  allowWrite?: string[];
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
}

function resolveExecutablePath(): string | undefined {
  const fromEnv = process.env.RASTRO_CHROMIUM;
  if (fromEnv) return fromEnv;
  return existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined;
}

/** `host` matches the allowlist exactly or as a subdomain; `*` allows any host. */
function hostAllowed(host: string, allowlist: string[]): boolean {
  if (allowlist.includes('*')) return true;
  return allowlist.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

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
  readonly context: BrowserContext;
  readonly downloadsPath: string;
  allowWrite: string[];
  dialogs: 'accept' | 'dismiss';
  activeTabId = '';

  private readonly tabs = new Map<string, TabRecord>();
  private readonly crashedTabs = new Set<string>();
  private readonly hooks: SessionHooks;
  private nextTabSeq = 0;
  private closedByUs = false;
  private recoveredFromCrash = false;

  private constructor(context: BrowserContext, downloadsPath: string, opts: SessionOptions, hooks: SessionHooks) {
    this.hooks = hooks;
    this.context = context;
    this.downloadsPath = downloadsPath;
    this.allowWrite = opts.allowWrite ?? [];
    this.dialogs = opts.dialogs ?? 'accept';
  }

  static async launch(paths: SessionPaths, opts: SessionOptions, hooks: SessionHooks): Promise<Session> {
    const headed = opts.headed ?? false;
    const args = ['--disable-gpu', ...(headed && process.env.WAYLAND_DISPLAY ? ['--ozone-platform=wayland'] : [])];
    const context = await chromium.launchPersistentContext(paths.profile, {
      executablePath: resolveExecutablePath(),
      headless: !headed,
      args,
      env: browserEnv(),
      acceptDownloads: true,
      downloadsPath: paths.downloads,
      viewport: { width: 1280, height: 900 },
    });

    const session = new Session(context, paths.downloads, opts, hooks);
    session.installWriteGuard();
    context.on('page', (page) => session.registerPage(page, true));
    context.on('close', () => {
      if (!session.closedByUs) hooks.onCrash(session.activeTabId);
    });

    const initial = context.pages()[0] ?? (await context.newPage());
    session.registerPage(initial, false);
    return session;
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
   * next action summary should mention the recovery. */
  async recover(): Promise<Page> {
    this.crashedTabs.delete(this.activeTabId);
    const page = await this.context.newPage();
    const id = this.activeTabId || this.allocateTabId();
    this.activeTabId = id;
    this.tabs.set(id, { id, page });
    this.wirePage(page, id);
    this.hooks.onPageCreated({ id, page });
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

  private registerPage(page: Page, isPopup: boolean): TabRecord {
    const id = this.allocateTabId();
    const tab: TabRecord = { id, page };
    this.tabs.set(id, tab);
    if (!isPopup) this.activeTabId = id;

    this.wirePage(page, id);
    this.hooks.onPageCreated(tab);

    // Recorded immediately (not after the popup's own load settles) so it
    // lands inside the opening action's attribution window; the URL is
    // best-effort and may still be about:blank at this instant.
    if (isPopup) this.hooks.onTabOpen(id, page.url());

    return tab;
  }

  private wirePage(page: Page, id: string): void {
    page.on('crash', () => {
      this.crashedTabs.add(id);
      this.hooks.onCrash(id);
    });

    page.on('close', () => {
      if (this.tabs.get(id)?.page !== page) return;
      this.tabs.delete(id);
      if (!this.crashedTabs.has(id)) this.hooks.onTabClose(id);
    });

    page.on('dialog', (dialog) => {
      const accept = this.dialogs !== 'dismiss';
      const handled = accept ? 'accepted' : 'dismissed';
      const kind = dialog.type();
      const message = dialog.message();
      void (accept ? dialog.accept() : dialog.dismiss()).then(() => {
        this.hooks.onDialog(id, kind, message, handled);
      });
    });

    page.on('download', (download) => {
      void (async () => {
        const filename = download.suggestedFilename();
        const dest = join(this.downloadsPath, filename);
        await download.saveAs(dest);
        let size: number | undefined;
        try {
          size = statSync(dest).size;
        } catch {
          // best effort only; the download event still fires without a size.
        }
        this.hooks.onDownload(id, filename, dest, size);
      })();
    });

    // No `page.on('popup', ...)` listener: the context-level `page` event
    // registered in `launch()` already fires for every new page, including
    // popups, and adding both would register each popup as two tabs.
  }

  private installWriteGuard(): void {
    void this.context.route('**/*', async (route) => {
      const request = route.request();
      const method = request.method();
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

      let tabId: string | undefined;
      try {
        tabId = this.tabIdForPage(request.frame().page());
      } catch {
        // requests without an owning frame (e.g. from a worker) fall back below.
      }
      tabId ??= this.activeTabId;
      this.hooks.onBlockedWrite(tabId, method, request.url(), host);
      await route.abort('blockedbyclient');
    });
  }
}
