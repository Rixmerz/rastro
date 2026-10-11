// Replays an HTTP recipe with Node's fetch: no browser. Follows redirects by
// hand so every hop's Set-Cookie lands in the jar, checks each request's first
// hop against the status class recorded for it, and pulls the next request's
// values out of the responses. Any surprise stops the run and says whether a
// write had already gone out — the caller falls back to the browser only when
// none had.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { RastroError } from '../core/types.ts';
import type { WriteRecord } from '../routines/result.ts';
import { bareOf } from '../routines/result.ts';
import { extractInput, readJsonPath } from './compile.ts';
import type { CookieJar } from './jar.ts';
import { matchesRequestPattern } from '../flow/format.ts';
import { project, selectJson } from '../flow/json-path.ts';
import { fill, fillDeep, isWriteRequest, type ExtractRule, type Paginate, type Recipe, type RecipeRequest, type Resolve } from './recipe.ts';
import { nextPageUrl, pageItems, withItems } from './paginate.ts';

export interface HttpRunOptions {
  /** Parameter values, keyring ones already resolved. */
  params: Record<string, string>;
  jar: CookieJar;
  /** The upload sandbox: throws for a path outside the allowed dirs. */
  assertUploadAllowed(path: string): void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface HttpRunResult {
  ok: boolean;
  outputs?: Record<string, unknown>;
  requestsSent: number;
  writes: WriteRecord[];
  finalUrl?: string;
  failedRequest?: string;
  reason?: string;
  /** Failed before any write request went out: falling back is safe. */
  beforeWrite?: boolean;
}

const MAX_REDIRECTS = 10;

class Mismatch extends Error {}

function applyRule(rule: ExtractRule, res: { body: string; url: string; location?: string }): string | undefined {
  if ('json' in rule) {
    try {
      const value = readJsonPath(JSON.parse(res.body), rule.json);
      return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
    } catch {
      return undefined;
    }
  }
  if ('input' in rule) return extractInput(res.body, rule.input);
  if ('query' in rule) return new URL(res.url).searchParams.get(rule.query) ?? undefined;
  const text = rule.from === 'body' ? res.body : rule.from === 'url' ? res.url : (res.location ?? '');
  return new RegExp(rule.regex).exec(text)?.[1];
}

function buildBody(req: RecipeRequest, resolve: Resolve, opts: HttpRunOptions): BodyInit | undefined {
  if (req.form) {
    return new URLSearchParams(req.form.map((f) => [f.name, fill(f.value, resolve)]));
  }
  if (req.json !== undefined) return JSON.stringify(fillDeep(req.json, resolve));
  if (req.raw !== undefined) return fill(req.raw, resolve);
  if (req.multipart) {
    const form = new FormData();
    for (const part of req.multipart) {
      if (part.file !== undefined) {
        const path = fill(part.file, resolve);
        opts.assertUploadAllowed(path);
        const blob = new Blob([readFileSync(path)], part.contentType ? { type: part.contentType } : {});
        form.append(part.name, blob, part.filename ?? basename(path));
      } else {
        form.append(part.name, fill(part.value ?? '', resolve));
      }
    }
    return form;
  }
  return undefined;
}

function buildUrl(req: RecipeRequest, resolve: Resolve): string {
  const url = new URL(fill(req.url, resolve, encodeURIComponent));
  for (const q of req.query ?? []) url.searchParams.append(q.name, fill(q.value, resolve));
  return url.href;
}

interface Outgoing {
  method: string;
  url: string;
  headers: Headers;
  body: BodyInit | undefined;
}

/** Sends one request, following redirects by hand so every hop's Set-Cookie
 * reaches the jar. `first` is the first hop's response, `res` the last. */
async function send(doFetch: typeof fetch, opts: HttpRunOptions, out: Outgoing, onFirst: (first: Response) => void): Promise<{ first: Response; res: Response; url: string }> {
  let { method, url, body } = out;
  const headers = new Headers(out.headers);
  let first: Response | undefined;
  for (let hop = 0; ; hop++) {
    const cookie = opts.jar.header(url);
    if (cookie) headers.set('cookie', cookie);
    else headers.delete('cookie');
    const init: RequestInit = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) };
    if (body !== undefined) init.body = body;
    const res = await doFetch(url, init);
    opts.jar.store(url, res.headers.getSetCookie());
    if (!first) {
      first = res;
      onFirst(res);
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location && hop < MAX_REDIRECTS) {
      await res.arrayBuffer().catch(() => undefined);
      url = new URL(location, url).href;
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
        method = 'GET';
        body = undefined;
        headers.delete('content-type');
      }
      continue;
    }
    return { first, res, url };
  }
}

/** Fetches the pages after the first and returns the first page's body with
 * every page's items merged into its list. */
async function followPages(id: string, p: Paginate, url: string, firstBody: string, fetchPage: (url: string) => Promise<{ status: number; body: string }>): Promise<string> {
  let root: unknown;
  try {
    root = JSON.parse(firstBody);
  } catch {
    throw new Mismatch(`${id}: paginates but its response is not JSON`);
  }
  const firstItems = pageItems(root, p);
  if (!firstItems) throw new Mismatch(`${id}: paginates but ${p.items || 'the response'} is not a list`);
  const all = [...firstItems];
  let page = root;
  let lastLength = firstItems.length;
  const seen = new Set([url]);
  for (let n = 1; n < p.maxPages; n++) {
    const next = nextPageUrl(p, url, page, firstItems.length, lastLength);
    if (next === undefined || seen.has(next)) break;
    seen.add(next);
    const res = await fetchPage(next);
    if (res.status < 200 || res.status >= 300) throw new Mismatch(`${id}: page ${n + 1} (${bareOf(next)}) answered ${res.status}`);
    try {
      page = JSON.parse(res.body);
    } catch {
      throw new Mismatch(`${id}: page ${n + 1} is not JSON`);
    }
    const items = pageItems(page, p) ?? [];
    all.push(...items);
    lastLength = items.length;
    url = next;
  }
  return all.length === firstItems.length ? firstBody : JSON.stringify(withItems(root, p.items, all));
}

export async function runRecipe(recipe: Recipe, opts: HttpRunOptions): Promise<HttpRunResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const vars: Record<string, string> = { ...opts.params };
  const writes: WriteRecord[] = [];
  let currentUrl = '';
  // Where the last navigation or form landed: what a person would be looking
  // at, unlike the URL of a trailing script call.
  let landing: string | undefined;
  let sent = 0;

  // Every replayed response, for the recipe's captures at the end.
  const responses: { method: string; url: string; status: number; body: string }[] = [];
  const resolve: Resolve = (name) => (name.startsWith('cookie:') ? opts.jar.get(name.slice(7), currentUrl) : vars[name]);

  for (const req of recipe.requests) {
    try {
      currentUrl = buildUrl(req, resolve);
      const requestUrl = currentUrl;
      const method = req.method;
      const body = buildBody(req, resolve, opts);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers ?? {})) headers.set(name, fill(value, resolve));

      // Counted on the first hop, before any redirect: a write that went out
      // stays reported even when a later hop throws.
      const sent_ = await send(doFetch, opts, { method, url: currentUrl, headers, body }, (firstRes) => {
        sent += 1;
        if (!isWriteRequest(req)) return;
        const write: WriteRecord = { method: req.method, path: bareOf(requestUrl), status: firstRes.status };
        if (req.xhr) write.xhr = true;
        const location = firstRes.headers.get('location');
        if (location) write.location = new URL(location, requestUrl).href;
        writes.push(write);
      });
      const first = sent_.first;
      currentUrl = sent_.url;
      const res = sent_.res;
      let text = await res.text();
      if (!req.xhr) landing = currentUrl;
      const got = `${Math.floor(first.status / 100)}xx`;
      if (req.expect && got !== req.expect) {
        const where = first.headers.get('location');
        throw new Mismatch(`${req.id} ${req.method} ${bareOf(requestUrl)} answered ${first.status}${where ? ` → ${bareOf(new URL(where, requestUrl).href)}` : ''} where ${req.expect} was recorded`);
      }
      if (req.paginate) {
        text = await followPages(req.id, req.paginate, currentUrl, text, async (url) => {
          const page = await send(doFetch, opts, { method: 'GET', url, headers, body: undefined }, () => {
            sent += 1;
          });
          return { status: page.first.status, body: await page.res.text() };
        });
      }
      responses.push({ method: req.method, url: requestUrl, status: first.status, body: text });

      const location = first.headers.get('location');
      const response = location ? { body: text, url: currentUrl, location: new URL(location, requestUrl).href } : { body: text, url: currentUrl };
      for (const [name, rule] of Object.entries(req.extract ?? {})) {
        const value = applyRule(rule, response);
        if (value === undefined) throw new Mismatch(`${req.id}: could not extract ${name} from the response`);
        vars[name] = value;
      }
    } catch (err) {
      if (err instanceof RastroError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, requestsSent: sent, writes, finalUrl: landing ?? currentUrl, failedRequest: req.id, reason, beforeWrite: writes.length === 0 };
    }
  }
  const result: HttpRunResult = { ok: true, requestsSent: sent, writes, finalUrl: landing ?? currentUrl };
  if (recipe.outputs && recipe.outputs.length > 0) {
    const outputs: Record<string, unknown> = {};
    for (const spec of recipe.outputs) {
      const pattern = fill(spec.request, resolve);
      const match = responses.filter((r) => matchesRequestPattern(pattern, r)).at(-1);
      let value: unknown;
      try {
        value = match ? JSON.parse(match.body) : undefined;
      } catch {
        value = undefined;
      }
      if (value !== undefined && spec.json !== undefined) value = selectJson(value, spec.json);
      if (value === undefined) {
        return { ...result, ok: false, failedRequest: spec.as, reason: `capture ${spec.as}: no JSON from ${pattern} in the replay`, beforeWrite: writes.length === 0 };
      }
      outputs[spec.as] = spec.fields ? project(value, spec.fields) : value;
    }
    result.outputs = outputs;
  }
  return result;
}
