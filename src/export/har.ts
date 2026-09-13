// Pure HAR 1.2 serialization. No I/O: everything needed is passed in by the
// caller (the CLI/engine resolves bodies and masking before calling this).

import type { ActionRecord, RequestRecord } from '../core/types.ts';

const ACTIONS_WITH_OWN_PAGE = new Set(['open', 'goto', 'back', 'forward', 'reload']);

export interface HarInput {
  /** ISO of session start, t=0. */
  startedAt: string;
  creatorVersion: string;
  requests: RequestRecord[];
  actions: ActionRecord[];
  body?: (hash: string) => { text: string; encoding?: 'base64' } | undefined;
  mask?: (headers: Record<string, string>) => Record<string, string>;
}

function isoAt(startedAt: string, tMs: number): string {
  return new Date(new Date(startedAt).getTime() + tMs).toISOString();
}

function toHeaderArray(headers: Record<string, string>): { name: string; value: string }[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function queryStringOf(url: string): { name: string; value: string }[] {
  try {
    return [...new URL(url).searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function pageFor(action: ActionRecord): boolean {
  return ACTIONS_WITH_OWN_PAGE.has(action.kind) || (action.urlAfter !== undefined && action.urlAfter !== action.urlBefore);
}

function buildPages(input: HarInput): Record<string, unknown>[] {
  return input.actions.filter(pageFor).map((action) => ({
    id: `action_${action.id}`,
    startedDateTime: isoAt(input.startedAt, action.t0),
    title: action.urlAfter ?? action.urlBefore,
    pageTimings: {},
  }));
}

function timingsFor(req: RequestRecord): { send: number; wait: number; receive: number } {
  const { startMs, responseMs, endMs } = req.timing;
  const wait = responseMs !== undefined ? responseMs - startMs : -1;
  const receive = responseMs !== undefined && endMs !== undefined ? endMs - responseMs : -1;
  return { send: 0, wait, receive };
}

function totalTimeFor(req: RequestRecord): number {
  const end = req.timing.endMs ?? req.timing.responseMs;
  return end !== undefined ? end - req.timing.startMs : 0;
}

function buildEntry(req: RequestRecord, input: HarInput): Record<string, unknown> {
  const requestHeaders = input.mask ? input.mask(req.requestHeaders) : req.requestHeaders;
  const responseHeaders = req.responseHeaders ? (input.mask ? input.mask(req.responseHeaders) : req.responseHeaders) : {};

  const request: Record<string, unknown> = {
    method: req.method,
    url: req.url,
    httpVersion: 'HTTP/1.1',
    headers: toHeaderArray(requestHeaders),
    queryString: queryStringOf(req.url),
    cookies: [],
    headersSize: -1,
    bodySize: req.postData !== undefined ? req.postData.length : 0,
  };
  if (req.postData !== undefined) {
    request['postData'] = {
      mimeType: headerValue(requestHeaders, 'content-type') ?? 'application/octet-stream',
      text: req.postData,
    };
  }

  const resolvedBody = req.bodyHash !== undefined ? input.body?.(req.bodyHash) : undefined;
  const content: Record<string, unknown> = {
    size: req.bodySize ?? 0,
    mimeType: req.mimeType ?? '',
  };
  if (resolvedBody) {
    content['text'] = resolvedBody.text;
    if (resolvedBody.encoding) content['encoding'] = resolvedBody.encoding;
  }

  const response: Record<string, unknown> = {
    status: req.failed !== undefined ? 0 : (req.status ?? 0),
    statusText: req.statusText ?? '',
    httpVersion: 'HTTP/1.1',
    headers: toHeaderArray(responseHeaders),
    cookies: [],
    content,
    redirectURL: headerValue(responseHeaders, 'location') ?? '',
    headersSize: -1,
    bodySize: req.bodySize ?? -1,
  };

  const entry: Record<string, unknown> = {
    startedDateTime: isoAt(input.startedAt, req.t),
    time: totalTimeFor(req),
    request,
    response,
    cache: {},
    timings: timingsFor(req),
    _rastroId: req.id,
    _bucket: req.bucket,
    _initiator: req.initiator,
  };

  if (req.actionId !== null) {
    entry['pageref'] = `action_${req.actionId}`;
  }

  return entry;
}

export function toHar(input: HarInput): { log: Record<string, unknown> } {
  return {
    log: {
      version: '1.2',
      creator: { name: 'rastro', version: input.creatorVersion },
      pages: buildPages(input),
      entries: input.requests.map((req) => buildEntry(req, input)),
    },
  };
}
