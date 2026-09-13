// CDP-driven trace recorder: one CDP session per page, feeding the raw event
// and request tables that attribution later classifies. No knowledge of
// actions or attribution here — this module only records what happened.

import type { BrowserContext, CDPSession, Page } from 'playwright-core';
import type { CookieRecord, EventType, Initiator, InitiatorType, RequestRecord } from '../core/types.ts';
import type { TraceStore } from '../store/db.ts';
import type { BodyStore } from '../store/bodies.ts';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const BODY_RESOURCE_TYPES = new Set(['document', 'xhr', 'fetch']);
const NON_BLOCKING_RESOURCE_TYPES = new Set(['websocket', 'eventsource', 'ping']);

// --- Minimal shapes of the CDP payloads this module reads. Structurally
// compatible with the real (richer) `Protocol.Events[...]` types inferred at
// each `client.on(...)` call site, so no dependency on playwright-core's
// unexported protocol module is needed.

interface CdpCallFrame {
  url: string;
  lineNumber: number;
}

interface CdpStackTrace {
  description?: string;
  callFrames: CdpCallFrame[];
  parent?: CdpStackTrace;
}

interface CdpInitiator {
  type: string;
  stack?: CdpStackTrace;
  url?: string;
  requestId?: string;
}

interface CdpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  mimeType: string;
}

interface CdpRequestWillBeSent {
  requestId: string;
  request: { url: string; method: string; headers: Record<string, string>; postData?: string };
  initiator: CdpInitiator;
  redirectResponse?: CdpResponse;
  type?: string;
  frameId?: string;
}

interface CdpResponseReceived {
  requestId: string;
  response: CdpResponse;
}

interface CdpLoadingFinished {
  requestId: string;
  encodedDataLength: number;
}

interface CdpLoadingFailed {
  requestId: string;
  errorText: string;
  canceled?: boolean;
}

interface CdpWebSocketCreated {
  requestId: string;
  url: string;
}

interface CdpWebSocketClosed {
  requestId: string;
}

interface CdpExtraInfoHeaders {
  requestId: string;
  headers: Record<string, string>;
}

interface CdpConsoleArg {
  value?: unknown;
  description?: string;
}

interface CdpConsoleApiCalled {
  type: string;
  args: CdpConsoleArg[];
  stackTrace?: CdpStackTrace;
}

interface CdpExceptionDetails {
  text: string;
  lineNumber: number;
  url?: string;
  exception?: { description?: string };
}

interface CdpExceptionThrown {
  exceptionDetails: CdpExceptionDetails;
}

interface CdpFrame {
  id: string;
  parentId?: string;
  url: string;
}

interface CdpFrameNavigated {
  frame: CdpFrame;
}

interface CdpFrameTree {
  frameTree: { frame: CdpFrame };
}

/** Collapses a URL's numeric-looking path segments and drops the query
 * string, so `/api/poll?t=171...` and `/api/poll?t=172...` (a cache-busting
 * timestamp) collapse to the same template a recurring-request check can key
 * on. */
function urlTemplate(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\d+/g, '#')}`;
  } catch {
    return url;
  }
}

/**
 * Detects a key (a request template, or a DOM-mutation delta shape) that
 * recurs at roughly fixed intervals — a `setTimeout` polling chain, a
 * ping/beacon, a clock widget's tick — as opposed to one-off or user-driven
 * repeats. Used to keep such recurrences from extending the quiet window
 * (R6); a single `setInterval`-initiated request is already caught by
 * `stackHasInterval` below and never reaches this tracker.
 */
class PeriodicTracker {
  private readonly history = new Map<string, number[]>();

  /** Records an occurrence at time `t` and reports whether this key has now
   * been seen often enough, at a consistent enough cadence, to call it
   * periodic background noise. */
  note(key: string, t: number): boolean {
    const times = this.history.get(key) ?? [];
    times.push(t);
    while (times.length > 5) times.shift();
    this.history.set(key, times);

    if (times.length < 3) return false;
    const first = times[0];
    if (first === undefined) return false;
    const gaps: number[] = [];
    let prev = first;
    for (let i = 1; i < times.length; i++) {
      const cur = times[i];
      if (cur === undefined) break;
      gaps.push(cur - prev);
      prev = cur;
    }
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    // Zero/negative (clock went backwards, or duplicate timestamps) or wider
    // than 10s apart reads as "not a tight poll loop", not periodic.
    if (avg <= 0 || avg > 10_000) return false;
    return gaps.every((g) => Math.abs(g - avg) <= avg * 0.5 + 50);
  }
}

function stackHasInterval(stack: CdpStackTrace | undefined): boolean {
  let node = stack;
  while (node) {
    if (node.description === 'setInterval') return true;
    node = node.parent;
  }
  return false;
}

function firstFrame(stack: CdpStackTrace | undefined): CdpCallFrame | undefined {
  return stack?.callFrames[0];
}

function mapInitiatorType(type: string): InitiatorType {
  switch (type) {
    case 'parser':
    case 'script':
    case 'preload':
    case 'preflight':
      return type;
    case 'SignedExchange':
      return 'signedExchange';
    default:
      return 'other';
  }
}

function consoleText(args: CdpConsoleArg[]): string {
  return args
    .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? '')))
    .join(' ');
}

const MUTATION_OBSERVER_SCRIPT = `(() => {
  window.__rastroDom = { added: 0, removed: 0, attributes: 0, last: performance.now() };
  const start = () => {
    const observer = new MutationObserver((mutations) => {
      const state = window.__rastroDom;
      for (const m of mutations) {
        state.added += m.addedNodes.length;
        state.removed += m.removedNodes.length;
        if (m.type === 'attributes') state.attributes += 1;
      }
      state.last = performance.now();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();`;

interface DomState {
  added: number;
  removed: number;
  attributes: number;
}

const ZERO_DOM_STATE: DomState = { added: 0, removed: 0, attributes: 0 };

export class Recorder {
  private readonly cdpByPage = new Map<Page, CDPSession>();
  private readonly mainFrameIds = new Map<string, string>();
  private readonly cdpToPublic = new Map<string, string>();
  private readonly inFlight = new Set<string>();
  /** cdp requestId -> owning tabId, so `detachTab` can clear only that tab's
   * pending entries (R3). */
  private readonly inFlightTab = new Map<string, string>();
  private readonly domLastSeen = new Map<Page, DomState>();
  private readonly domRhythm = new Map<Page, PeriodicTracker>();
  private readonly requestRhythm = new PeriodicTracker();
  /** requestId -> extra-info headers seen before `requestWillBeSent`/
   * `responseReceived` created the record they belong to (R19). */
  private readonly pendingRequestExtraHeaders = new Map<string, Record<string, string>>();
  private readonly pendingResponseExtraHeaders = new Map<string, Record<string, string>>();
  /** Dedupes `noteEarlySight` so a request already recorded doesn't get a
   * second, redundant early-sight event once the real CDP capture also
   * reaches it (R5). */
  private readonly earlySighted = new Set<string>();
  private readonly wsFrameCounts = new Map<string, number>();
  private lastActivityMs = 0;
  private readonly store: TraceStore;
  private readonly bodies: BodyStore;
  private readonly now: () => number;

  constructor(store: TraceStore, bodies: BodyStore, now: () => number) {
    this.store = store;
    this.bodies = bodies;
    this.now = now;
  }

  pending(): number {
    return this.inFlight.size;
  }

  lastActivity(): number {
    return this.lastActivityMs;
  }

  markActivity(): void {
    this.lastActivityMs = this.now();
  }

  async attach(page: Page, tabId: string): Promise<void> {
    const client = await page.context().newCDPSession(page);
    this.cdpByPage.set(page, client);

    await client.send('Network.enable');
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Runtime.setAsyncCallStackDepth', { maxDepth: 16 });

    try {
      const { frameTree } = (await client.send('Page.getFrameTree')) as CdpFrameTree;
      this.mainFrameIds.set(tabId, frameTree.frame.id);
    } catch {
      // best effort; isNavigation falls back to false without it.
    }

    client.on('Network.requestWillBeSent', (e) => this.onRequestWillBeSent(e as CdpRequestWillBeSent, tabId));
    client.on('Network.requestWillBeSentExtraInfo', (e) => this.onRequestExtraInfo(e as CdpExtraInfoHeaders));
    client.on('Network.responseReceived', (e) => this.onResponseReceived(e as CdpResponseReceived, tabId));
    client.on('Network.responseReceivedExtraInfo', (e) => this.onResponseExtraInfo(e as CdpExtraInfoHeaders));
    client.on('Network.loadingFinished', (e) => {
      void this.onLoadingFinished(e as CdpLoadingFinished, client);
    });
    client.on('Network.loadingFailed', (e) => this.onLoadingFailed(e as CdpLoadingFailed, tabId));
    client.on('Network.webSocketCreated', (e) => this.onWebSocketCreated(e as CdpWebSocketCreated, tabId));
    client.on('Network.webSocketClosed', (e) => this.onWebSocketClosed(e as CdpWebSocketClosed, tabId));
    client.on('Network.webSocketFrameSent', (e) => this.onWebSocketFrame(e as CdpWebSocketClosed));
    client.on('Network.webSocketFrameReceived', (e) => this.onWebSocketFrame(e as CdpWebSocketClosed));
    client.on('Runtime.consoleAPICalled', (e) => this.onConsole(e as CdpConsoleApiCalled, tabId));
    client.on('Runtime.exceptionThrown', (e) => this.onException(e as CdpExceptionThrown, tabId));
    client.on('Page.frameNavigated', (e) => this.onFrameNavigated(e as CdpFrameNavigated, tabId));

    await page.addInitScript(MUTATION_OBSERVER_SCRIPT);
  }

  detach(page: Page): void {
    this.cdpByPage.delete(page);
    this.domLastSeen.delete(page);
    this.domRhythm.delete(page);
  }

  /** Clears every request still pending for a tab that just closed or
   * crashed. Without this, a request whose tab disappeared mid-flight (its
   * `Network.loadingFinished`/`loadingFailed` will now never arrive) stays
   * "pending" forever, wedging every later action's quiet-wait at
   * `maxWindowMs` (R3). */
  detachTab(tabId: string): void {
    let cleared = false;
    for (const [cdpId, owner] of this.inFlightTab) {
      if (owner !== tabId) continue;
      this.inFlight.delete(cdpId);
      this.inFlightTab.delete(cdpId);
      cleared = true;
    }
    if (cleared) this.markActivity();
  }

  /**
   * Best-effort record of a request Playwright's context-wide router saw,
   * for the window before this tab's own CDP session has attached (or for a
   * popup tab that closes before it ever does) — the only reliable way to
   * see a popup's earliest traffic (R5). Deliberately lightweight (an event,
   * not a full `RequestRecord`): headers/timing/body detail still comes from
   * the CDP path above when it attaches in time.
   */
  noteEarlySight(tabId: string, method: string, url: string, resourceType: string): void {
    const key = `${tabId}|${method}|${url}`;
    if (this.earlySighted.has(key)) return;
    this.earlySighted.add(key);
    this.markActivity();
    this.emit('request', tabId, null, { method, url, resourceType, source: 'early' });
  }

  /** Reads the page's DOM mutation counters, bumping `lastActivity` if they
   * moved since the previous read. A navigation error is itself activity
   * (the page is mid-transition), so it never reads as spuriously quiet.
   * A *tiny* delta (at most one node touched) that recurs on a steady tick —
   * a clock widget's text update, a "typing…" spinner — reads as background
   * noise instead, same rationale as a recurring request (R6). */
  async pollDomActivity(page: Page): Promise<void> {
    let state: DomState;
    try {
      state = await page.evaluate(() => {
        const w = window as unknown as { __rastroDom?: DomState };
        return w.__rastroDom ?? { added: 0, removed: 0, attributes: 0 };
      });
    } catch {
      this.markActivity();
      return;
    }
    const previous = this.domLastSeen.get(page) ?? ZERO_DOM_STATE;
    const delta = {
      added: state.added - previous.added,
      removed: state.removed - previous.removed,
      attributes: state.attributes - previous.attributes,
    };
    if (delta.added || delta.removed || delta.attributes) {
      const tiny = delta.added <= 1 && delta.removed <= 1 && delta.attributes <= 1;
      const rhythm = this.domRhythm.get(page) ?? new PeriodicTracker();
      this.domRhythm.set(page, rhythm);
      const key = `${delta.added}|${delta.removed}|${delta.attributes}`;
      const recurring = tiny && rhythm.note(key, this.now());
      if (!recurring) this.markActivity();
    }
    this.domLastSeen.set(page, state);
  }

  /** Snapshot of the DOM mutation counters relative to a prior snapshot, for
   * the per-action `dom_delta` event. */
  async domDeltaSince(page: Page, before: DomState | undefined): Promise<DomState> {
    const state = await this.domCounters(page);
    const base = before ?? ZERO_DOM_STATE;
    return {
      added: state.added - base.added,
      removed: state.removed - base.removed,
      attributes: state.attributes - base.attributes,
    };
  }

  async domCounters(page: Page): Promise<DomState> {
    try {
      return await page.evaluate(() => {
        const w = window as unknown as { __rastroDom?: DomState };
        return w.__rastroDom ?? { added: 0, removed: 0, attributes: 0 };
      });
    } catch {
      return ZERO_DOM_STATE;
    }
  }

  async cookies(context: BrowserContext): Promise<CookieRecord[]> {
    const cookies = await context.cookies();
    return cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      httpOnly: c.httpOnly,
      secure: c.secure,
      expires: c.expires,
    }));
  }

  diffCookies(before: CookieRecord[], after: CookieRecord[]): { added: string[]; changed: string[]; removed: string[] } {
    const key = (c: CookieRecord): string => `${c.domain}|${c.path}|${c.name}`;
    const beforeMap = new Map(before.map((c) => [key(c), c]));
    const afterMap = new Map(after.map((c) => [key(c), c]));
    const added: string[] = [];
    const changed: string[] = [];
    for (const [k, c] of afterMap) {
      const prior = beforeMap.get(k);
      if (!prior) added.push(c.name);
      else if (prior.value !== c.value) changed.push(c.name);
    }
    const removed: string[] = [];
    for (const [k, c] of beforeMap) {
      if (!afterMap.has(k)) removed.push(c.name);
    }
    return { added, changed, removed };
  }

  async storage(page: Page): Promise<{ local: Record<string, string>; session: Record<string, string> }> {
    try {
      return await page.evaluate(() => ({
        local: { ...window.localStorage },
        session: { ...window.sessionStorage },
      }));
    } catch {
      return { local: {}, session: {} };
    }
  }

  diffStorage(
    before: Record<string, string>,
    after: Record<string, string>,
  ): { added: string[]; changed: string[]; removed: string[] } {
    const added: string[] = [];
    const changed: string[] = [];
    for (const [key, value] of Object.entries(after)) {
      if (!(key in before)) added.push(key);
      else if (before[key] !== value) changed.push(key);
    }
    const removed = Object.keys(before).filter((key) => !(key in after));
    return { added, changed, removed };
  }

  private emit(
    type: EventType,
    tabId: string,
    requestId: string | null,
    data: Record<string, unknown>,
  ): number {
    return this.store.addEvent({ t: this.now(), type, actionId: null, bucket: null, tabId, requestId, data });
  }

  private isPendingCandidate(resourceType: string, hasInterval: boolean, recurring: boolean): boolean {
    return !NON_BLOCKING_RESOURCE_TYPES.has(resourceType) && !hasInterval && !recurring;
  }

  /** Clears one cdp request id from both pending-tracking maps; returns
   * whether it was actually pending. */
  private clearPending(cdpId: string): boolean {
    this.inFlightTab.delete(cdpId);
    return this.inFlight.delete(cdpId);
  }

  private onRequestWillBeSent(e: CdpRequestWillBeSent, tabId: string): void {
    const resourceType = (e.type ?? 'other').toLowerCase();
    const hasInterval = stackHasInterval(e.initiator.stack);
    // A setInterval-driven request is already excluded above; only check the
    // (cheaper to skip) rhythm tracker for everything else, so a genuine
    // one-off request never pays for the bookkeeping.
    const recurring = !hasInterval && this.requestRhythm.note(`${tabId}|${urlTemplate(e.request.url)}`, this.now());
    const t = this.now();

    let redirectedFrom: string | undefined;
    if (e.redirectResponse) {
      const prev = this.store.getRequestByCdpId(e.requestId);
      if (prev) {
        prev.status = e.redirectResponse.status;
        prev.statusText = e.redirectResponse.statusText;
        prev.responseHeaders = e.redirectResponse.headers;
        prev.timing.responseMs = t;
        prev.timing.endMs = t;
        this.store.upsertRequest(prev);
        this.emit('redirect', tabId, prev.id, { method: prev.method, url: prev.url, status: prev.status });
        redirectedFrom = prev.id;
        this.clearPending(e.requestId);
      }
    }

    const publicId = this.store.nextRequestId();
    const initiator: Initiator = {
      type: e.redirectResponse ? 'redirect' : mapInitiatorType(e.initiator.type),
      stackHasInterval: hasInterval,
    };
    const frame = firstFrame(e.initiator.stack);
    const initiatorUrl = e.initiator.url ?? frame?.url;
    if (initiatorUrl) initiator.url = initiatorUrl;
    if (frame) initiator.line = frame.lineNumber;
    if (e.initiator.requestId) {
      const parentPublic = this.cdpToPublic.get(e.initiator.requestId);
      if (parentPublic) initiator.parentRequestId = parentPublic;
    }

    const isNavigation = resourceType === 'document' && e.frameId === this.mainFrameIds.get(tabId);

    const rec: RequestRecord = {
      id: publicId,
      cdpId: e.requestId,
      tabId,
      t,
      method: e.request.method,
      url: e.request.url,
      resourceType,
      initiator,
      requestHeaders: e.request.headers,
      timing: { startMs: t },
      origin: 'page',
      isNavigation,
      actionId: null,
      bucket: null,
    };
    if (e.request.postData !== undefined) rec.postData = e.request.postData;
    if (redirectedFrom !== undefined) rec.redirectedFrom = redirectedFrom;

    const pendingReqHeaders = this.pendingRequestExtraHeaders.get(e.requestId);
    if (pendingReqHeaders) {
      rec.requestHeaders = { ...rec.requestHeaders, ...pendingReqHeaders };
      this.pendingRequestExtraHeaders.delete(e.requestId);
    }

    this.store.upsertRequest(rec);
    this.cdpToPublic.set(e.requestId, publicId);
    this.emit('request', tabId, publicId, { method: rec.method, url: rec.url });

    if (this.isPendingCandidate(resourceType, hasInterval, recurring)) {
      this.inFlight.add(e.requestId);
      this.inFlightTab.set(e.requestId, tabId);
      this.markActivity();
    }
  }

  /** `Network.requestWillBeSentExtraInfo` carries headers Chrome never puts
   * on the regular `requestWillBeSent` event — `Cookie` chief among them
   * (R19) — and can arrive before the record it belongs to exists yet. */
  private onRequestExtraInfo(e: CdpExtraInfoHeaders): void {
    const rec = this.store.getRequestByCdpId(e.requestId);
    if (rec) {
      rec.requestHeaders = { ...rec.requestHeaders, ...e.headers };
      this.store.upsertRequest(rec);
    } else {
      this.pendingRequestExtraHeaders.set(e.requestId, e.headers);
    }
  }

  /** Same as `onRequestExtraInfo`, for `Set-Cookie` on the response side. */
  private onResponseExtraInfo(e: CdpExtraInfoHeaders): void {
    const rec = this.store.getRequestByCdpId(e.requestId);
    if (rec) {
      rec.responseHeaders = { ...(rec.responseHeaders ?? {}), ...e.headers };
      this.store.upsertRequest(rec);
    } else {
      this.pendingResponseExtraHeaders.set(e.requestId, e.headers);
    }
  }

  private onResponseReceived(e: CdpResponseReceived, tabId: string): void {
    const rec = this.store.getRequestByCdpId(e.requestId);
    if (!rec) return;
    rec.status = e.response.status;
    rec.statusText = e.response.statusText;
    // `responseReceivedExtraInfo` (R19's Set-Cookie source) typically arrives
    // *before* this event and, since the record already exists by then, is
    // merged straight into `rec.responseHeaders` by `onResponseExtraInfo` —
    // preserve it here instead of overwriting wholesale from `e.response`.
    rec.responseHeaders = {
      ...e.response.headers,
      ...rec.responseHeaders,
      ...this.pendingResponseExtraHeaders.get(e.requestId),
    };
    this.pendingResponseExtraHeaders.delete(e.requestId);
    rec.mimeType = e.response.mimeType;
    rec.timing.responseMs = this.now();
    this.store.upsertRequest(rec);
    this.emit('response', tabId, rec.id, { status: rec.status, url: rec.url });

    // Response headers are a good enough "this request is no longer blocking
    // quiet" signal on their own: `Network.loadingFinished` is what actually
    // triggers the body fetch below, but this Chromium build sometimes never
    // emits it for a small chunked response, which would otherwise wedge
    // `pending()` above 0 until maxWindowMs on every single action.
    if (this.clearPending(e.requestId)) this.markActivity();
  }

  private async onLoadingFinished(e: CdpLoadingFinished, client: CDPSession): Promise<void> {
    const rec = this.store.getRequestByCdpId(e.requestId);
    if (rec) {
      rec.timing.endMs = this.now();
      rec.bodySize = e.encodedDataLength;
      if (BODY_RESOURCE_TYPES.has(rec.resourceType) && e.encodedDataLength <= MAX_BODY_BYTES) {
        try {
          const { body, base64Encoded } = await client.send('Network.getResponseBody', {
            requestId: e.requestId,
          });
          const buf = Buffer.from(body, base64Encoded ? 'base64' : 'utf8');
          if (buf.length <= MAX_BODY_BYTES) {
            const { hash, size } = this.bodies.put(buf);
            rec.bodyHash = hash;
            rec.bodySize = size;
          }
        } catch {
          // body unavailable (e.g. no-content responses, or the page navigated away); not fatal.
        }
      }
      this.store.upsertRequest(rec);
    }
    this.pendingRequestExtraHeaders.delete(e.requestId);
    this.pendingResponseExtraHeaders.delete(e.requestId);
    if (this.clearPending(e.requestId)) this.markActivity();
  }

  private onLoadingFailed(e: CdpLoadingFailed, tabId: string): void {
    const rec = this.store.getRequestByCdpId(e.requestId);
    if (rec) {
      rec.failed = e.errorText;
      rec.timing.endMs = this.now();
      this.store.upsertRequest(rec);
      this.emit('request_failed', tabId, rec.id, { url: rec.url, reason: e.errorText });
    }
    this.pendingRequestExtraHeaders.delete(e.requestId);
    this.pendingResponseExtraHeaders.delete(e.requestId);
    if (this.clearPending(e.requestId)) this.markActivity();
  }

  private onWebSocketCreated(e: CdpWebSocketCreated, tabId: string): void {
    this.wsFrameCounts.set(e.requestId, 0);
    const publicId = this.store.nextRequestId();
    this.cdpToPublic.set(e.requestId, publicId);
    this.emit('ws_open', tabId, publicId, { url: e.url });
  }

  private onWebSocketClosed(e: CdpWebSocketClosed, tabId: string): void {
    const publicId = this.cdpToPublic.get(e.requestId);
    const frames = this.wsFrameCounts.get(e.requestId) ?? 0;
    this.wsFrameCounts.delete(e.requestId);
    this.emit('ws_close', tabId, publicId ?? null, {});
    this.emit('ws_frames', tabId, publicId ?? null, { frames });
  }

  private onWebSocketFrame(e: CdpWebSocketClosed): void {
    this.wsFrameCounts.set(e.requestId, (this.wsFrameCounts.get(e.requestId) ?? 0) + 1);
  }

  private onConsole(e: CdpConsoleApiCalled, tabId: string): void {
    const level = e.type === 'error' ? 'error' : e.type === 'warning' ? 'warning' : 'log';
    const text = consoleText(e.args);
    const frame = firstFrame(e.stackTrace);
    const data: Record<string, unknown> = { level, text };
    if (frame?.url) {
      data.url = frame.url;
      data.line = frame.lineNumber;
    }
    this.emit('console', tabId, null, data);
  }

  private onException(e: CdpExceptionThrown, tabId: string): void {
    const d = e.exceptionDetails;
    const data: Record<string, unknown> = { text: d.exception?.description ?? d.text, line: d.lineNumber };
    if (d.url) data.url = d.url;
    this.emit('exception', tabId, null, data);
  }

  private onFrameNavigated(e: CdpFrameNavigated, tabId: string): void {
    const isMain = !e.frame.parentId;
    if (isMain) this.mainFrameIds.set(tabId, e.frame.id);
    this.markActivity();
    this.emit('navigation', tabId, null, { url: e.frame.url, frame: isMain ? 'main' : 'child' });
  }
}
