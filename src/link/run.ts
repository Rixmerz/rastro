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
import { fill, fillDeep, isWriteRequest, type ExtractRule, type Recipe, type RecipeRequest, type Resolve } from './recipe.ts';

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

export async function runRecipe(recipe: Recipe, opts: HttpRunOptions): Promise<HttpRunResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const vars: Record<string, string> = { ...opts.params };
  const writes: WriteRecord[] = [];
  let currentUrl = '';
  // Where the last navigation or form landed: what a person would be looking
  // at, unlike the URL of a trailing script call.
  let landing: string | undefined;
  let sent = 0;

  const resolve: Resolve = (name) => (name.startsWith('cookie:') ? opts.jar.get(name.slice(7), currentUrl) : vars[name]);

  for (const req of recipe.requests) {
    try {
      currentUrl = buildUrl(req, resolve);
      const requestUrl = currentUrl;
      let method = req.method;
      let body = buildBody(req, resolve, opts);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers ?? {})) headers.set(name, fill(value, resolve));

      let first: Response | undefined;
      let res: Response;
      for (let hop = 0; ; hop++) {
        const cookie = opts.jar.header(currentUrl);
        if (cookie) headers.set('cookie', cookie);
        else headers.delete('cookie');
        const init: RequestInit = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) };
        if (body !== undefined) init.body = body;
        res = await doFetch(currentUrl, init);
        opts.jar.store(currentUrl, res.headers.getSetCookie());

        if (!first) {
          first = res;
          sent += 1;
          if (isWriteRequest(req)) {
            const write: WriteRecord = { method: req.method, path: bareOf(currentUrl), status: res.status };
            if (req.xhr) write.xhr = true;
            const location = res.headers.get('location');
            if (location) write.location = new URL(location, currentUrl).href;
            writes.push(write);
          }
        }

        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location && hop < MAX_REDIRECTS) {
          await res.arrayBuffer().catch(() => undefined);
          currentUrl = new URL(location, currentUrl).href;
          if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
            method = 'GET';
            body = undefined;
            headers.delete('content-type');
          }
          continue;
        }
        break;
      }

      const text = await res.text();
      if (!req.xhr) landing = currentUrl;
      const got = `${Math.floor(first.status / 100)}xx`;
      if (req.expect && got !== req.expect) {
        const where = first.headers.get('location');
        throw new Mismatch(`${req.id} ${req.method} ${bareOf(requestUrl)} answered ${first.status}${where ? ` → ${bareOf(new URL(where, requestUrl).href)}` : ''} where ${req.expect} was recorded`);
      }

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
  return { ok: true, requestsSent: sent, writes, finalUrl: landing ?? currentUrl };
}
