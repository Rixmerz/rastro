// Builds the EffectSummary an action carries and renders it as the one-line
// outcome the "Actions with effect summary" requirement calls for.

import type { ActionRecord, EffectSummary, RequestRecord, TraceEvent } from '../core/types.ts';
import { plural, quote } from './text.ts';
import { shortUrl } from './output.ts';

export interface SummaryInput {
  action: ActionRecord;
  attributedRequests: RequestRecord[];
  attributedEvents: TraceEvent[];
  hiddenBackground: number;
  hiddenUnattributed: number;
  newElements: number;
  blocked?: string;
}

/** True when `a` and `b` differ by origin, pathname or search (hash ignored). */
function differsBySignificantPart(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return `${ua.origin}${ua.pathname}${ua.search}` !== `${ub.origin}${ub.pathname}${ub.search}`;
  } catch {
    return a !== b;
  }
}

function navigationTarget(action: ActionRecord): string | undefined {
  if (!action.urlAfter) return undefined;
  return differsBySignificantPart(action.urlAfter, action.urlBefore) ? action.urlAfter : undefined;
}

/** Sort key: numeric statuses descending, 'failed' always last. */
function failedSortKey(status: number | 'failed'): number {
  return status === 'failed' ? Number.POSITIVE_INFINITY : -status;
}

export function buildSummary(input: SummaryInput): EffectSummary {
  const { action, attributedRequests, attributedEvents, hiddenBackground, hiddenUnattributed, newElements, blocked } =
    input;

  const failedCounts = new Map<number | 'failed', number>();
  for (const req of attributedRequests) {
    const key: number | 'failed' | undefined = req.failed
      ? 'failed'
      : req.status !== undefined && req.status >= 400
        ? req.status
        : undefined;
    if (key !== undefined) failedCounts.set(key, (failedCounts.get(key) ?? 0) + 1);
  }
  const failed = [...failedCounts.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => failedSortKey(a.status) - failedSortKey(b.status));

  let cookiesAdded = 0;
  let cookiesChanged = 0;
  let cookiesRemoved = 0;
  let consoleErrors = 0;
  const dialogs: string[] = [];
  const tabsOpened: string[] = [];
  const downloads: string[] = [];
  const blockedWrites: string[] = [];
  let blockedState: string | undefined;

  for (const event of attributedEvents) {
    switch (event.type) {
      case 'cookie_diff': {
        const d = event.data as { added: string[]; changed: string[]; removed: string[] };
        cookiesAdded += d.added.length;
        cookiesChanged += d.changed.length;
        cookiesRemoved += d.removed.length;
        break;
      }
      case 'console': {
        const d = event.data as { level: string };
        if (d.level === 'error') consoleErrors++;
        break;
      }
      case 'exception':
        consoleErrors++;
        break;
      case 'dialog': {
        const d = event.data as { message: string; handled: 'accepted' | 'dismissed' };
        dialogs.push(`${quote(d.message)} ${d.handled}`);
        break;
      }
      case 'tab_open': {
        const d = event.data as { tabId: string };
        tabsOpened.push(d.tabId);
        break;
      }
      case 'download': {
        const d = event.data as { filename: string };
        downloads.push(d.filename);
        break;
      }
      case 'blocked_write': {
        const d = event.data as { host: string };
        blockedWrites.push(d.host);
        break;
      }
      case 'blocked_state': {
        const d = event.data as { reason: string };
        blockedState = d.reason;
        break;
      }
      default:
        break;
    }
  }

  return {
    navigatedTo: navigationTarget(action),
    requests: attributedRequests.length,
    failed,
    cookies: { added: cookiesAdded, changed: cookiesChanged, removed: cookiesRemoved },
    newElements,
    consoleErrors,
    dialogs,
    tabsOpened,
    downloads,
    blockedWrites,
    blocked: blocked ?? blockedState,
    hiddenBackground,
    hiddenUnattributed,
  };
}

function cookiePart(cookies: EffectSummary['cookies']): string | undefined {
  const all: [string, number][] = [
    ['+', cookies.added],
    ['~', cookies.changed],
    ['-', cookies.removed],
  ];
  const kinds = all.filter(([, n]) => n > 0);
  if (kinds.length === 0) return undefined;
  if (kinds.length === 1) {
    const [sign, n] = kinds[0]!;
    return `${sign}${n} ${n === 1 ? 'cookie' : 'cookies'}`;
  }
  const total = kinds.reduce((sum, [, n]) => sum + n, 0);
  const prefix = kinds.map(([sign, n]) => `${sign}${n}`).join(' ');
  return `${prefix} ${total === 1 ? 'cookie' : 'cookies'}`;
}

function summaryParts(summary: EffectSummary, base?: string): string[] {
  const parts: string[] = [];

  if (summary.navigatedTo) parts.push(`→ ${shortUrl(summary.navigatedTo, base)}`);

  if (summary.requests > 0) {
    const failedPart =
      summary.failed.length > 0 ? ` (${summary.failed.map((f) => `${f.count}× ${f.status}`).join(', ')})` : '';
    parts.push(`${summary.requests} req${failedPart}`);
  }

  const cookies = cookiePart(summary.cookies);
  if (cookies) parts.push(cookies);

  if (summary.newElements > 0) parts.push(plural(summary.newElements, 'new element'));

  if (summary.consoleErrors > 0) parts.push(`console: ${plural(summary.consoleErrors, 'error')}`);

  for (const dialog of summary.dialogs) parts.push(`dialog ${dialog}`);

  for (const tabId of summary.tabsOpened) parts.push(`opened tab ${tabId}`);

  for (const filename of summary.downloads) parts.push(`download ${quote(filename)}`);

  if (summary.blockedWrites.length > 0) {
    const hosts = [...new Set(summary.blockedWrites)];
    parts.push(`${plural(summary.blockedWrites.length, 'write')} blocked (${hosts.join(', ')})`);
  }

  if (summary.blocked) parts.push(`blocked: ${summary.blocked}`);

  return parts;
}

export function formatSummary(
  actionId: number,
  summary: EffectSummary | undefined,
  opts?: { error?: string; base?: string },
): string {
  if (opts?.error) {
    const parts = summary ? summaryParts(summary, opts.base) : [];
    const tail = parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
    return `#${actionId} ✗ ${opts.error}${tail}`;
  }

  const parts = summary ? summaryParts(summary, opts?.base) : [];
  if (parts.length === 0) return `#${actionId} · no effects`;

  const sep = parts[0]!.startsWith('→') ? ' ' : ' · ';
  return `#${actionId}${sep}${parts.join(' · ')}`;
}
