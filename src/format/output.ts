// Renders trace/state data (history, effects, trace, requests, console,
// cookies, storage, tabs, element detail) for CLI output. Pure functions:
// callers resolve the data, these only format it.

import type { ActionRecord, CookieRecord, RequestRecord, TraceEvent } from '../core/types.ts';
import { plural, quote, sanitize } from './text.ts';
import {
  MASK,
  isSensitiveFieldName,
  maskBody,
  maskHeaders,
  type SecretRegistry,
} from '../security/redact.ts';

/**
 * Shortens a URL relative to `base`: pathname+search(+hash) when the origin
 * matches `base`'s, host+pathname+search(+hash) otherwise. Falls back to the
 * raw input when either URL fails to parse.
 */
export function shortUrl(url: string, base?: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const tail = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  let out: string;
  if (base) {
    try {
      out = new URL(base).origin === parsed.origin ? tail : `${parsed.host}${tail}`;
    } catch {
      out = `${parsed.host}${tail}`;
    }
  } else {
    out = `${parsed.host}${tail}`;
  }
  const trimmed = out.endsWith('?') ? out.slice(0, -1) : out;
  return sanitize(trimmed);
}

/** Last path segment of a URL, used to identify a script in console/initiator output. */
function fileName(url: string): string {
  try {
    return new URL(url).pathname.split('/').pop() || url;
  } catch {
    return url.split('/').pop() || url;
  }
}

function fileRef(url: string | undefined, line: number | undefined, wrap = false): string {
  if (!url) return '';
  const name = line !== undefined ? `${fileName(url)}:${line}` : fileName(url);
  return wrap ? ` (${name})` : ` ${name}`;
}

const SOURCE_PREFIX: Record<ActionRecord['source'], string> = {
  agent: '',
  human: '[human] ',
  flow: '[flow] ',
};

function historyTarget(action: ActionRecord): string | undefined {
  if (action.kind === 'open' || action.kind === 'goto') return action.urlAfter ?? action.urlBefore;
  if (action.targetName) return quote(action.targetName);
  return action.ref;
}

const VALUE_KINDS = new Set(['fill', 'type', 'select']);

function historyValue(action: ActionRecord, secrets: SecretRegistry): string | undefined {
  if (!VALUE_KINDS.has(action.kind) || action.value === undefined) return undefined;
  const raw = action.secret ? MASK : action.value;
  return quote(secrets.mask(raw));
}

function historyLine(action: ActionRecord, secrets: SecretRegistry): string {
  const target = historyTarget(action);
  const value = historyValue(action, secrets);
  let head = `#${action.id} ${SOURCE_PREFIX[action.source]}${action.kind}`;
  if (target) head += ` ${target}`;
  if (value) head += ` ${value}`;

  const parts = [head];
  if (action.t1 !== undefined) parts.push(`${((action.t1 - action.t0) / 1000).toFixed(1)}s`);

  if (action.error) {
    parts.push(`✗ ${action.error}`);
    return parts.join(' · ');
  }

  const summary = action.summary;
  if (summary?.navigatedTo) parts.push(`→ ${shortUrl(summary.navigatedTo, action.urlBefore)}`);
  if (summary) for (const f of summary.failed) parts.push(`${f.count}× ${f.status}`);

  return parts.join(' · ');
}

export function formatHistory(actions: ActionRecord[], secrets: SecretRegistry): string {
  return actions.map((action) => historyLine(action, secrets)).join('\n');
}

function tagLine(tag: string, content: string): string {
  return `${tag.padEnd(5)}${content}`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Resource types listed individually; everything else is counted under `res`. */
const LISTED_RESOURCE_TYPES = new Set(['document', 'xhr', 'fetch', 'websocket', 'eventsource', 'other']);

const RESOURCE_LABELS: Record<string, string> = {
  script: 'script',
  stylesheet: 'style',
  image: 'image',
  font: 'font',
  media: 'media',
};

function requestEntry(r: RequestRecord, base: string): string {
  const status = r.failed ? 'failed' : r.status !== undefined ? String(r.status) : undefined;
  return `${r.id} ${r.method} ${shortUrl(r.url, base)}${status ? ` ${status}` : ''}`;
}

function requestLines(reqs: RequestRecord[], base: string, tag: string): string[] {
  if (reqs.length === 0) return [];
  return chunk(reqs.map((r) => requestEntry(r, base)), 6).map((group) => tagLine(tag, group.join(' · ')));
}

function resourceLine(reqs: RequestRecord[]): string | undefined {
  if (reqs.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const r of reqs) counts.set(r.resourceType, (counts.get(r.resourceType) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort(([typeA, a], [typeB, b]) => b - a || typeA.localeCompare(typeB))
    .map(([type, count]) => plural(count, RESOURCE_LABELS[type] ?? type));
  return tagLine('res', parts.join(' · '));
}

function cookieLine(events: TraceEvent[]): string | undefined {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const event of events) {
    if (event.type !== 'cookie_diff') continue;
    const d = event.data as { added: string[]; changed: string[]; removed: string[] };
    added.push(...d.added);
    changed.push(...d.changed);
    removed.push(...d.removed);
  }
  const parts = [
    ...added.map((n) => `+${sanitize(n)}`),
    ...changed.map((n) => `~${sanitize(n)}`),
    ...removed.map((n) => `-${sanitize(n)}`),
  ];
  return parts.length > 0 ? tagLine('cook', parts.join(' ')) : undefined;
}

function storageLines(events: TraceEvent[]): string[] {
  const lines: string[] = [];
  for (const event of events) {
    if (event.type !== 'storage_diff') continue;
    const d = event.data as { area: 'local' | 'session'; added: string[]; changed: string[]; removed: string[] };
    const parts = [
      ...d.added.map((k) => `+${sanitize(k)}`),
      ...d.changed.map((k) => `~${sanitize(k)}`),
      ...d.removed.map((k) => `-${sanitize(k)}`),
    ];
    if (parts.length > 0) lines.push(tagLine('stor', `${d.area} ${parts.join(' ')}`));
  }
  return lines;
}

function consoleLines(events: TraceEvent[], secrets: SecretRegistry): string[] {
  const lines: string[] = [];
  for (const event of events) {
    if (event.type === 'console') {
      const d = event.data as { level: string; text: string; url?: string; line?: number };
      if (d.level !== 'error') continue;
      lines.push(tagLine('cons', `error ${quote(secrets.mask(d.text))}${fileRef(d.url, d.line)}`));
    } else if (event.type === 'exception') {
      const d = event.data as { text: string; url?: string; line?: number };
      lines.push(tagLine('cons', `error ${quote(secrets.mask(d.text))}${fileRef(d.url, d.line)}`));
    }
  }
  return lines;
}

function dialogLines(events: TraceEvent[]): string[] {
  return events
    .filter((e) => e.type === 'dialog')
    .map((e) => {
      const d = e.data as { message: string; handled: string };
      return tagLine('dlg', `${quote(d.message)} ${d.handled}`);
    });
}

function tabLines(events: TraceEvent[], base: string): string[] {
  return events
    .filter((e) => e.type === 'tab_open')
    .map((e) => {
      const d = e.data as { tabId: string; url: string };
      return tagLine('tab', `${d.tabId} → ${shortUrl(d.url, base)}`);
    });
}

function downloadLines(events: TraceEvent[]): string[] {
  return events
    .filter((e) => e.type === 'download')
    .map((e) => tagLine('dl', quote((e.data as { filename: string }).filename)));
}

function blockedLines(events: TraceEvent[]): string[] {
  return events
    .filter((e) => e.type === 'blocked_write')
    .map((e) => {
      const d = e.data as { method: string; url: string };
      return tagLine('blk', `${d.method} ${shortUrl(d.url)}`);
    });
}

function domLine(events: TraceEvent[]): string | undefined {
  let added = 0;
  let removed = 0;
  let attributes = 0;
  for (const event of events) {
    if (event.type !== 'dom_delta') continue;
    const d = event.data as { added: number; removed: number; attributes: number };
    added += d.added;
    removed += d.removed;
    attributes += d.attributes;
  }
  if (added === 0 && removed === 0 && attributes === 0) return undefined;
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`-${removed}`);
  const attrsPart = attributes > 0 ? ` ~${attributes} attrs` : '';
  return tagLine('dom', `${parts.join(' ')} nodes${attrsPart}`);
}

export function formatEffects(
  input: {
    action: ActionRecord;
    requests: RequestRecord[];
    events: TraceEvent[];
    hiddenBackground: number;
    hiddenUnattributed: number;
    all: boolean;
  },
  secrets: SecretRegistry,
): string {
  const { action, requests, events, hiddenBackground, hiddenUnattributed, all } = input;
  const base = action.urlBefore;
  const lines: string[] = [];

  if (action.summary?.navigatedTo) {
    lines.push(tagLine('nav', `→ ${shortUrl(action.summary.navigatedTo, base)}`));
  }

  const attributed = requests.filter((r) => r.bucket === 'attributed');
  const listed = attributed.filter((r) => LISTED_RESOURCE_TYPES.has(r.resourceType));
  const resourceTyped = attributed.filter((r) => !LISTED_RESOURCE_TYPES.has(r.resourceType));
  lines.push(...requestLines(listed, base, 'req'));
  const res = resourceLine(resourceTyped);
  if (res) lines.push(res);

  const cookies = cookieLine(events);
  if (cookies) lines.push(cookies);
  lines.push(...storageLines(events));
  lines.push(...consoleLines(events, secrets));
  lines.push(...dialogLines(events));
  lines.push(...tabLines(events, base));
  lines.push(...downloadLines(events));
  lines.push(...blockedLines(events));
  const dom = domLine(events);
  if (dom) lines.push(dom);

  if (all) {
    lines.push(...requestLines(requests.filter((r) => r.bucket === 'background'), base, 'bg'));
    lines.push(...requestLines(requests.filter((r) => r.bucket === 'unattributed'), base, 'unat'));
  } else if (hiddenBackground > 0 || hiddenUnattributed > 0) {
    lines.push(`${hiddenBackground} background hidden (--all) · ${hiddenUnattributed} unattributed`);
  }

  const text = lines.length > 0 ? lines.join('\n') : 'no effects';
  return secrets.mask(text);
}

function actionLabel(actionId: number | null, actionsById: Map<number, ActionRecord>, kind: unknown): string {
  if (actionId === null) return '';
  const action = actionsById.get(actionId);
  const target = action ? (action.targetName ?? action.ref ?? '') : '';
  return `#${actionId} ${String(kind)} ${quote(target)}`;
}

function bucketSuffix(bucket: TraceEvent['bucket']): string {
  if (bucket === 'background') return ' · background';
  if (bucket === 'unattributed') return ' · unattributed';
  return '';
}

function traceEventBody(
  event: TraceEvent,
  actionsById: Map<number, ActionRecord>,
  requests: Map<string, RequestRecord>,
  base: string | undefined,
  secrets: SecretRegistry,
): { source: string; details: string } {
  switch (event.type) {
    case 'action_start':
      return {
        source: String(event.data['source'] ?? ''),
        details: actionLabel(event.actionId, actionsById, event.data['kind']),
      };
    case 'action_end':
      return { source: String(event.data['source'] ?? ''), details: `── #${event.actionId} closed ──` };
    case 'request': {
      const r = event.requestId ? requests.get(event.requestId) : undefined;
      const initiator =
        r?.initiator.type === 'script' ? fileRef(r.initiator.url, r.initiator.line, true) : '';
      return { source: 'net', details: `${r?.method ?? ''} ${r ? shortUrl(r.url, base) : ''}${initiator}` };
    }
    case 'response': {
      const r = event.requestId ? requests.get(event.requestId) : undefined;
      return { source: 'net', details: `${r?.status ?? ''} ${r ? shortUrl(r.url, base) : ''}` };
    }
    case 'request_failed':
      return { source: 'net', details: `failed ${String(event.data['reason'] ?? '')}` };
    case 'redirect':
    case 'ws_open':
    case 'ws_close':
    case 'ws_frames':
      return { source: 'net', details: event.type };
    case 'navigation': {
      const d = event.data as { url: string; frame: string };
      return { source: 'page', details: `→ ${shortUrl(d.url, base)} (${d.frame})` };
    }
    case 'console': {
      const d = event.data as { level: string; text: string; url?: string; line?: number };
      return { source: 'console', details: `${d.level} ${quote(secrets.mask(d.text))}${fileRef(d.url, d.line)}` };
    }
    case 'exception': {
      const d = event.data as { text: string; url?: string; line?: number };
      return { source: 'console', details: `error ${quote(secrets.mask(d.text))}${fileRef(d.url, d.line)}` };
    }
    case 'dialog': {
      const d = event.data as { message: string; handled: string };
      return { source: 'page', details: `${quote(d.message)} ${d.handled}` };
    }
    case 'download':
      return { source: 'page', details: `download ${quote((event.data as { filename: string }).filename)}` };
    case 'tab_open': {
      const d = event.data as { tabId: string; url: string };
      return { source: 'page', details: `opened ${d.tabId} → ${shortUrl(d.url, base)}` };
    }
    case 'tab_close':
      return { source: 'page', details: 'closed tab' };
    case 'dom_delta': {
      const d = event.data as { added: number; removed: number; attributes: number };
      return { source: 'page', details: `+${d.added} -${d.removed} nodes` };
    }
    case 'cookie_diff': {
      const d = event.data as { added: string[]; changed: string[]; removed: string[] };
      return { source: 'cookie', details: `+${d.added.length} ~${d.changed.length} -${d.removed.length}` };
    }
    case 'storage_diff': {
      const d = event.data as { area: string; added: string[]; changed: string[]; removed: string[] };
      return { source: 'storage', details: `${d.area} +${d.added.length} ~${d.changed.length} -${d.removed.length}` };
    }
    case 'blocked_write': {
      const d = event.data as { method: string; url: string };
      return { source: 'guard', details: `${d.method} ${shortUrl(d.url)}` };
    }
    case 'blocked_state':
      return { source: 'state', details: `blocked: ${String((event.data as { reason: string }).reason)}` };
    case 'crash':
      return { source: 'state', details: `crash ${String((event.data as { target: string }).target)}` };
    default:
      return { source: '', details: event.type };
  }
}

export function formatTrace(
  input: { actions: ActionRecord[]; events: TraceEvent[]; requests: Map<string, RequestRecord>; base?: string },
  secrets: SecretRegistry,
): string {
  const { actions, events, requests, base } = input;
  const actionsById = new Map(actions.map((a) => [a.id, a]));
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const t0 = sorted[0]?.t ?? 0;

  return sorted
    .map((event) => {
      const time = `+${((event.t - t0) / 1000).toFixed(3)}`.padEnd(8);
      const { source, details } = traceEventBody(event, actionsById, requests, base, secrets);
      return `${time}${source.padEnd(9)}${details}${bucketSuffix(event.bucket)}`;
    })
    .join('\n');
}

const REQUEST_HEADER_ALLOW = new Set(['content-type', 'accept', 'authorization', 'cookie', 'origin', 'referer']);
const RESPONSE_HEADER_ALLOW = new Set(['content-type', 'content-length', 'location', 'set-cookie', 'cache-control']);

function pickHeaders(headers: Record<string, string>, allow: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (allow.has(lower) || lower.startsWith('x-')) out[name] = value;
  }
  return out;
}

function requestDurationMs(r: RequestRecord): number {
  const end = r.timing.endMs ?? r.timing.responseMs;
  return end !== undefined ? Math.round(end - r.timing.startMs) : 0;
}

function attributionLabel(r: RequestRecord): string {
  return r.actionId !== null ? `attributed #${r.actionId}` : (r.bucket ?? 'unattributed');
}

export function formatRequest(
  r: RequestRecord,
  opts: { body?: { text: string; truncated: boolean } | null; reveal: boolean },
  secrets: SecretRegistry,
): string {
  const statusPart = r.failed ? `failed ${r.failed}` : `${r.status ?? ''} ${r.statusText ?? ''}`.trim();
  const lines = [
    `${r.id} ${r.method} ${r.url} → ${statusPart} · ${r.resourceType} · ${requestDurationMs(r)} ms · ${attributionLabel(r)}`,
  ];

  if (r.initiator.type === 'script') {
    lines.push(`initiator script${fileRef(r.initiator.url, r.initiator.line)}`);
  }

  const requestHeaders = maskHeaders(pickHeaders(r.requestHeaders, REQUEST_HEADER_ALLOW), opts.reveal);
  for (const [name, value] of Object.entries(requestHeaders)) lines.push(`> ${name}: ${value}`);

  if (r.responseHeaders) {
    const responseHeaders = maskHeaders(pickHeaders(r.responseHeaders, RESPONSE_HEADER_ALLOW), opts.reveal);
    for (const [name, value] of Object.entries(responseHeaders)) lines.push(`< ${name}: ${value}`);
  }

  if (r.postData !== undefined) {
    const contentType = r.requestHeaders['content-type'] ?? r.requestHeaders['Content-Type'];
    lines.push(`postData: ${maskBody(r.postData, contentType, opts.reveal)}`);
  }

  if (opts.body) {
    lines.push(opts.body.truncated ? '--- body (truncated to 1 KB)' : '--- body');
    lines.push(opts.body.text);
  }

  const text = lines.join('\n');
  return opts.reveal ? text : secrets.mask(text);
}

function escapeSingleQuoted(value: string): string {
  return value.replaceAll("'", `'\\''`);
}

const CURL_SKIP_HEADERS = new Set(['host', 'content-length']);

export function toCurl(r: RequestRecord, reveal: boolean, secrets: SecretRegistry): string {
  const parts = [`curl '${escapeSingleQuoted(r.url)}'`];
  if (r.method !== 'GET') parts.push(`-X ${r.method}`);

  const headers = maskHeaders(r.requestHeaders, reveal);
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (CURL_SKIP_HEADERS.has(lower) || name.startsWith(':')) continue;
    parts.push(`-H '${escapeSingleQuoted(`${name}: ${value}`)}'`);
  }

  if (r.postData !== undefined) {
    const contentType = r.requestHeaders['content-type'] ?? r.requestHeaders['Content-Type'];
    parts.push(`--data-raw '${escapeSingleQuoted(maskBody(r.postData, contentType, reveal))}'`);
  }

  const text = parts.join(' ');
  return reveal ? text : secrets.mask(text);
}

export function formatConsole(events: TraceEvent[], secrets: SecretRegistry): string {
  return events
    .filter((e) => (e.type === 'console' && (e.data as { level: string }).level === 'error') || e.type === 'exception')
    .map((e) => {
      const d = e.data as { text: string; url?: string; line?: number };
      return `error ${quote(secrets.mask(d.text))}${fileRef(d.url, d.line)}`;
    })
    .join('\n');
}

export function formatCookies(cookies: CookieRecord[], reveal: boolean): string {
  return cookies
    .map((c) => {
      const value = reveal ? c.value : MASK;
      const flags = [c.httpOnly ? 'httpOnly' : '', c.secure ? 'secure' : ''].filter(Boolean);
      const flagsPart = flags.length > 0 ? ` ${flags.join(' ')}` : '';
      return `${c.name}=${value} ${c.domain} ${c.path}${flagsPart}`;
    })
    .join('\n');
}

export function formatStorage(
  entries: { area: 'local' | 'session'; key: string; value: string }[],
  reveal: boolean,
  secrets: SecretRegistry,
): string {
  const text = entries
    .map((e) => `${e.area} ${sanitize(e.key)}=${!reveal && isSensitiveFieldName(e.key) ? MASK : quote(e.value)}`)
    .join('\n');
  return reveal ? text : secrets.mask(text);
}

export function formatTabs(tabs: { id: string; url: string; title: string; active: boolean }[]): string {
  return tabs.map((t) => `${t.active ? '*' : ' '} ${t.id} ${quote(t.title)} ${t.url}`).join('\n');
}

export function formatDetail(d: {
  ref: string;
  role: string;
  name: string;
  tag?: string;
  href?: string;
  formMethod?: string;
  formAction?: string;
  inputType?: string;
  testId?: string;
  css?: string;
  disabled?: boolean;
}): string {
  const parts = [`[${d.ref}] ${d.role} ${quote(d.name)}`];
  if (d.tag) parts.push(`<${d.tag}>`);
  if (d.href) parts.push(`href ${sanitize(d.href)}`);
  if (d.formMethod || d.formAction) {
    const action = d.formAction !== undefined ? sanitize(d.formAction) : d.formAction;
    parts.push(`form ${[d.formMethod, action].filter(Boolean).join(' ')}`);
  }
  if (d.inputType) parts.push(`type ${d.inputType}`);
  if (d.css) parts.push(`css: ${d.css}`);
  if (d.testId) parts.push(`testid: ${d.testId}`);

  const text = parts.join(' · ');
  return d.disabled ? `${text} (disabled)` : text;
}
