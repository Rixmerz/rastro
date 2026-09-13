// Pure classification of requests and other trace events into an EventBucket.
// No I/O: everything needed is passed in by the caller (the engine).

import type { EventBucket, EventType, RequestRecord } from '../core/types.ts';

export interface ActionWindow {
  id: number;
  t0: number;
  t1: number;
  tabId: string;
  navigated: boolean;
  openedTabIds: string[];
}

const BACKGROUND_RESOURCE_TYPES = new Set(['ping', 'cspviolationreport', 'beacon']);

const ANALYTICS_HOSTS = new Set([
  'google-analytics.com',
  'googletagmanager.com',
  'analytics.google.com',
  'doubleclick.net',
  'googlesyndication.com',
  'facebook.net',
  'connect.facebook.net',
  'hotjar.com',
  'hotjar.io',
  'segment.io',
  'segment.com',
  'cdn.segment.com',
  'mixpanel.com',
  'amplitude.com',
  'heap.io',
  'fullstory.com',
  'clarity.ms',
  'newrelic.com',
  'nr-data.net',
  'sentry.io',
  'datadoghq.com',
  'browser-intake-datadoghq.com',
  'plausible.io',
  'matomo.cloud',
  'analytics.tiktok.com',
  'bat.bing.com',
  'px.ads.linkedin.com',
  'stats.wp.com',
  'cloudflareinsights.com',
]);

/** True when `host` equals, or is a subdomain of, a known analytics host. */
export function isAnalyticsHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (ANALYTICS_HOSTS.has(lower)) return true;
  for (const known of ANALYTICS_HOSTS) {
    if (lower.endsWith(`.${known}`)) return true;
  }
  return false;
}

const HEX_8 = /^[0-9a-f]{8,}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS = /^\d+$/;
const BASE64ISH_16 = /^[A-Za-z0-9_-]{16,}$/;

function isIdSegment(segment: string): boolean {
  if (segment === '') return false;
  if (DIGITS.test(segment)) return true;
  if (UUID.test(segment)) return true;
  if (HEX_8.test(segment)) return true;
  if (BASE64ISH_16.test(segment) && /[A-Za-z]/.test(segment) && /\d/.test(segment)) return true;
  return false;
}

/**
 * Normalizes a URL to a template usable for recurrence detection: scheme,
 * host, path with id-shaped segments replaced by `:id`, and query keys kept
 * (sorted) with their values dropped. Fragment is dropped. The method is not
 * part of the template; callers compare it separately. Malformed URLs are
 * returned unchanged.
 */
export function urlTemplate(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const path = parsed.pathname
    .split('/')
    .map((segment) => (isIdSegment(segment) ? ':id' : segment))
    .join('/');
  const keys = [...parsed.searchParams.keys()].sort();
  const query = keys.length > 0 ? `?${keys.join('&')}` : '';
  return `${parsed.protocol}//${parsed.host}${path}${query}`;
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stddev(values: number[], avg: number): number {
  const variance = mean(values.map((v) => (v - avg) ** 2));
  return Math.sqrt(variance);
}

/**
 * True when `req`'s (method, urlTemplate) recurred at least 3 times in
 * `history` before t0 with regular spacing: coefficient of variation of the
 * consecutive-occurrence intervals < 0.35, and the last occurrence within 3x
 * the mean interval before t0.
 */
function isPollingRecurrence(req: RequestRecord, history: RequestRecord[], t0: number): boolean {
  const template = urlTemplate(req.url);
  const occurrences = history
    .filter((h) => h.method === req.method && urlTemplate(h.url) === template)
    .map((h) => h.t)
    .sort((a, b) => a - b);
  if (occurrences.length < 3) return false;

  const intervals: number[] = [];
  for (let i = 1; i < occurrences.length; i++) {
    intervals.push(occurrences[i]! - occurrences[i - 1]!);
  }
  const avgInterval = mean(intervals);
  if (avgInterval <= 0) return false;
  const cv = stddev(intervals, avgInterval) / avgInterval;
  if (cv >= 0.35) return false;

  const last = occurrences[occurrences.length - 1]!;
  return t0 - last <= 3 * avgInterval;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function isBackgroundRequest(req: RequestRecord, history: RequestRecord[], t0: number): boolean {
  if (BACKGROUND_RESOURCE_TYPES.has(req.resourceType)) return true;
  if (req.initiator.stackHasInterval) return true;
  const host = hostOf(req.url);
  if (host && isAnalyticsHost(host)) return true;
  return isPollingRecurrence(req, history, t0);
}

const ATTRIBUTED_INITIATOR_TYPES = new Set(['parser', 'script', 'preload', 'redirect', 'preflight', 'signedExchange']);

/**
 * Classifies every request in `inWindow` (each already known to have
 * t in [action.t0, action.t1]) as attributed, background, or unattributed,
 * per the Attribution requirement. `history` holds every request recorded
 * before action.t0 in the session, used for recurrence detection.
 */
export function attributeRequests(
  action: ActionWindow,
  inWindow: RequestRecord[],
  history: RequestRecord[],
): Map<string, EventBucket> {
  const buckets = new Map<string, EventBucket>();
  // The action-tab navigation document is the one case background/inheritance
  // must never override (spec: "always attributed"); everything else in the
  // second pass is free to be revised.
  const lockedAttributed = new Set<string>();

  // First pass: everything decidable without looking at sibling requests in
  // this window (background, and the two "always attributed" navigation/
  // redirect-chain cases handled afterwards).
  for (const req of inWindow) {
    const isActionNavigationDoc = req.isNavigation && req.origin === 'page' && req.tabId === action.tabId;

    if (isActionNavigationDoc) {
      buckets.set(req.id, 'attributed');
      lockedAttributed.add(req.id);
      continue;
    }

    if (isBackgroundRequest(req, history, action.t0)) {
      buckets.set(req.id, 'background');
      continue;
    }

    const inActionScope = req.tabId === action.tabId || action.openedTabIds.includes(req.tabId);
    if (req.origin !== 'page' || !inActionScope) {
      buckets.set(req.id, 'unattributed');
      continue;
    }

    if (req.initiator.type === 'other' && !req.isNavigation && !req.redirectedFrom) {
      buckets.set(req.id, 'unattributed');
      continue;
    }

    if (ATTRIBUTED_INITIATOR_TYPES.has(req.initiator.type) || req.isNavigation) {
      buckets.set(req.id, 'attributed');
      continue;
    }

    // Redirects and requests initiated by an already-background request
    // resolve in the second pass, once every direct case has a verdict.
    buckets.set(req.id, 'unattributed');
  }

  // Second pass: propagate along redirect chains and background parentage,
  // iterating to a fixed point since a chain can be longer than one hop.
  let changed = true;
  while (changed) {
    changed = false;
    for (const req of inWindow) {
      const current = buckets.get(req.id);

      if (req.redirectedFrom) {
        const parentBucket = buckets.get(req.redirectedFrom);
        if (parentBucket === 'attributed' && current !== 'attributed') {
          buckets.set(req.id, 'attributed');
          changed = true;
          continue;
        }
      }

      const parentId = req.initiator.parentRequestId;
      if (parentId) {
        const parentBucket = buckets.get(parentId);
        if (parentBucket === 'background' && current !== 'background' && !lockedAttributed.has(req.id)) {
          buckets.set(req.id, 'background');
          changed = true;
        }
      }
    }
  }

  return buckets;
}

const ATTRIBUTED_IF_IN_SCOPE: ReadonlySet<EventType> = new Set([
  'console',
  'exception',
  'dialog',
  'download',
  'navigation',
  'dom_delta',
  'cookie_diff',
  'storage_diff',
  'blocked_write',
  'blocked_state',
  'tab_open',
]);

const ATTRIBUTED_IF_ACTION_TAB: ReadonlySet<EventType> = new Set(['tab_close', 'crash']);

/** Classifies a non-request event that falls inside the action's window. */
export function attributeEvent(
  action: ActionWindow,
  type: EventType,
  tabId: string,
  _data: Record<string, unknown>,
): EventBucket {
  if (type === 'ws_frames') return 'background';
  if (type === 'action_start' || type === 'action_end') return 'attributed';

  if (ATTRIBUTED_IF_ACTION_TAB.has(type)) {
    return tabId === action.tabId ? 'attributed' : 'unattributed';
  }

  if (ATTRIBUTED_IF_IN_SCOPE.has(type)) {
    return tabId === action.tabId || action.openedTabIds.includes(tabId) ? 'attributed' : 'unattributed';
  }

  return 'unattributed';
}
