// Compiles the requests a flow's run caused into an HTTP recipe. Pure: the
// caller hands in the run's requests, a way to read their response bodies,
// the parameter values the run used and the session's cookies, and gets a
// recipe back or a `NotLinkable` saying why not.
//
// The work is in the values. Each value a request sent is, in order: a
// parameter (bound to `{{param}}`), a value an earlier response handed out
// (turned into an extraction rule, checked against the recorded response), a
// cookie (read from the jar at run time), or a constant (kept, and flagged
// when it looks like a token nobody could trace).

import type { RequestRecord } from '../core/types.ts';
import type { ExtractRule, Recipe, RecipeOutput, RecipePart, RecipeRequest } from './recipe.ts';
import { isWriteRequest, stringifyRecipe } from './recipe.ts';
import { matchesRequestPattern } from '../flow/format.ts';

export class NotLinkable extends Error {}

export interface CompileInput {
  flow: string;
  flowHash: string;
  /** Every request attributed to the run's actions, any order. */
  requests: RequestRecord[];
  /** Response body as text, or null when not captured or not text. */
  body(request: RequestRecord): string | null;
  /** Every parameter value the run used, keyring ones included. */
  params: Record<string, string>;
  /** Parameters a caller supplies: the recipe's `params`. */
  callerParams: string[];
  /** Names of parameters whose value is a secret. */
  secretParams: string[];
  /** Upload parameter by the base name of the file the run attached. */
  uploads: Record<string, string>;
  /** Session cookies when the run ended. */
  cookies: { name: string; value: string }[];
  /** True when `text` contains a value the daemon knows to be secret. */
  containsSecret(text: string): boolean;
  /** The flow's `expect.requests` patterns: the writes its author said matter. */
  expected?: string[];
  /** The flow's `capture` steps: the responses the recipe must keep and read. */
  captures?: RecipeOutput[];
  /** The flow reads page text, which has no HTTP equivalent. */
  readsPage?: boolean;
}

const KEPT_TYPES = new Set(['document', 'xhr', 'fetch']);
const MIN_TRACE = 4;
const MIN_SUBSTRING = 3;
const TEXT_MIME = /html|json|text|javascript|xml/i;

interface Chain {
  head: RequestRecord;
  last: RequestRecord;
  hops: RequestRecord[];
}

interface Source {
  index: number;
  finalUrl: string;
  location?: string;
  body: string | null;
  json: unknown;
}

function seqOf(id: string): number {
  return Number(id.replace(/^\D+/, '')) || 0;
}

function headerOf(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

const INPUT_TAG = /<input\b[^>]*>/gi;
const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;

/** Attributes of every `<input>` in `html`, in document order. */
export function inputsOf(html: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const tag of html.match(INPUT_TAG) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(ATTR)) {
      attrs[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
    }
    out.push(attrs);
  }
  return out;
}

export function extractInput(html: string, name: string): string | undefined {
  return inputsOf(html).find((a) => a['name'] === name)?.['value'];
}

/** Dotted path with `[i]` for arrays: `data.items[0].id`. */
export function readJsonPath(root: unknown, path: string): unknown {
  let node = root;
  for (const token of path.match(/[^.[\]]+|\[\d+\]/g) ?? []) {
    if (node === null || typeof node !== 'object') return undefined;
    node = token.startsWith('[') ? (node as unknown[])[Number(token.slice(1, -1))] : (node as Record<string, unknown>)[token];
  }
  return node;
}

function findJsonPath(root: unknown, value: string, path = ''): string | undefined {
  if (typeof root === 'string' || typeof root === 'number') return String(root) === value && path ? path : undefined;
  if (Array.isArray(root)) {
    for (let i = 0; i < root.length; i++) {
      const hit = findJsonPath(root[i], value, `${path}[${i}]`);
      if (hit) return hit;
    }
    return undefined;
  }
  if (root !== null && typeof root === 'object') {
    for (const [k, v] of Object.entries(root)) {
      if (!/^[A-Za-z_$][\w$-]*$/.test(k)) continue;
      const hit = findJsonPath(v, value, path ? `${path}.${k}` : k);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** A regex whose first group captures `value` as the first match in `text`,
 * with just enough left context to be unambiguous. */
function buildRegex(text: string, value: string): string | undefined {
  const idx = text.indexOf(value);
  if (idx < 0) return undefined;
  const cls = /^\d+$/.test(value) ? '\\d+' : /^[A-Za-z0-9_-]+$/.test(value) ? '[A-Za-z0-9_-]+' : '[^"\'&<>\\s]+';
  if (!new RegExp(`^${cls}$`).test(value)) return undefined;
  for (const ctx of [12, 24, 48, 96]) {
    const left = text.slice(Math.max(0, idx - ctx), idx);
    const pattern = `${left ? escapeRe(left) : '^'}(${cls})`;
    if (new RegExp(pattern).exec(text)?.[1] === value) return pattern;
  }
  return undefined;
}

/** Worth tracing to an earlier response: has a digit, or is long and not a
 * phrase. Words, identifiers and labels are constants of the page. */
function looksDynamic(value: string): boolean {
  if (/\s/.test(value) && !/\d/.test(value)) return false;
  if (/\d/.test(value)) return true;
  return value.length >= 20 && /[a-z]/.test(value) && /[A-Z]/.test(value);
}

/** Long, random-looking, and not traced: likely a token that will be stale. */
function looksLikeToken(value: string): boolean {
  if (/^\d{10,13}$/.test(value)) return true;
  return value.length >= 16 && /\d/.test(value) && /^[A-Za-z0-9+/=_.-]+$/.test(value);
}

function identifier(key: string): string {
  const cleaned = key.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1').replace(/^_+$/, '');
  return cleaned || 'v';
}

interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  value: string;
}

export function parseMultipart(body: string, boundary: string): MultipartPart[] {
  const parts: MultipartPart[] = [];
  for (const segment of body.split(`--${boundary}`).slice(1)) {
    if (segment.startsWith('--')) break;
    const text = segment.replace(/^\r?\n/, '');
    const split = text.search(/\r?\n\r?\n/);
    if (split < 0) continue;
    const head = text.slice(0, split);
    const content = text.slice(split).replace(/^\r?\n\r?\n/, '').replace(/\r?\n$/, '');
    const disposition = /content-disposition:([^\r\n]*)/i.exec(head)?.[1] ?? '';
    const name = /\bname="([^"]*)"/i.exec(disposition)?.[1];
    if (name === undefined) continue;
    const part: MultipartPart = { name, value: content };
    const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1];
    if (filename !== undefined) part.filename = filename;
    const type = /content-type:\s*([^\r\n]*)/i.exec(head)?.[1];
    if (type) part.contentType = type.trim();
    parts.push(part);
  }
  return parts;
}

function buildChains(requests: RequestRecord[]): Chain[] {
  const sorted = [...requests].sort((a, b) => seqOf(a.id) - seqOf(b.id));
  const byId = new Map(sorted.map((r) => [r.id, r]));
  const chains = new Map<string, Chain>();
  const rootOf = (r: RequestRecord): RequestRecord => {
    let node = r;
    while (node.redirectedFrom !== undefined && byId.has(node.redirectedFrom)) node = byId.get(node.redirectedFrom)!;
    return node;
  };
  for (const r of sorted) {
    const root = rootOf(r);
    const chain = chains.get(root.id);
    if (chain) {
      chain.hops.push(r);
      chain.last = r;
    } else {
      chains.set(root.id, { head: root, last: r, hops: [r] });
    }
  }
  return [...chains.values()].filter(
    (c) => KEPT_TYPES.has(c.head.resourceType) && c.head.failed === undefined && c.last.failed === undefined && c.head.bucket !== 'background',
  );
}

function statusClass(status: number | undefined): string | undefined {
  return status === undefined ? undefined : `${Math.floor(status / 100)}xx`;
}

const KEEP_HEADERS = new Set(['accept', 'content-type', 'origin', 'referer', 'user-agent']);

export function compileRecipe(input: CompileInput): Recipe {
  if (input.readsPage) throw new NotLinkable('the flow reads page text (a read step), which needs a page; keep it in the browser or capture the response instead');
  const chains = buildChains(input.requests);
  if (chains.length === 0) throw new NotLinkable('the run caused no document, xhr or fetch request');

  const warnings: string[] = [];
  const tokenWarnings: { index: number; text: string }[] = [];
  const out: RecipeRequest[] = [];
  const extracts: Map<string, ExtractRule>[] = [];
  const sources: Source[] = [];
  const varByValue = new Map<string, string>();
  const usedNames = new Set(Object.keys(input.params));
  const paramEntries = Object.entries(input.params).filter(([, v]) => v.length > 0);

  const newVar = (key: string): string => {
    const base = identifier(key);
    let name = base;
    for (let n = 2; usedNames.has(name); n++) name = `${base}_${n}`;
    usedNames.add(name);
    return name;
  };

  const bindSubstrings = (value: string, encode?: (v: string) => string): string => {
    let out = value;
    for (const [name, v] of [...paramEntries].sort((a, b) => b[1].length - a[1].length)) {
      if (v.length < MIN_SUBSTRING) continue;
      out = out.split(v).join(`{{${name}}}`);
      if (encode && encode(v) !== v) out = out.split(encode(v)).join(`{{${name}}}`);
    }
    return out;
  };

  /** Where in an earlier response `value` came from, most recent first. A
   * plain word ("XMLHttpRequest", "core_output_load_template") shows up in
   * some earlier script or page too, but it is a constant, not something the
   * server handed out: only dynamic-looking values are traced, plus a value
   * sitting in an `<input>` named like the field (Moodle's sesskey has no digit). */
  const trace = (value: string, key: string, before: number): { index: number; rule: ExtractRule } | undefined => {
    const dynamic = looksDynamic(value);
    for (let j = before - 1; j >= 0; j--) {
      const src = sources[j]!;
      if (!dynamic) {
        if (src.body !== null && extractInput(src.body, key) === value) return { index: j, rule: { input: key } };
        continue;
      }
      if (src.json !== undefined) {
        const path = findJsonPath(src.json, value);
        if (path) return { index: j, rule: { json: path } };
      }
      if (src.body !== null) {
        const inputs = inputsOf(src.body).filter((a) => a['value'] === value && a['name']);
        const named = inputs.find((a) => a['name'] === key) ?? inputs[0];
        if (named && extractInput(src.body, named['name']!) === value) return { index: j, rule: { input: named['name']! } };
      }
      if (src.location?.includes(value)) {
        const regex = buildRegex(src.location, value);
        if (regex) return { index: j, rule: { regex, from: 'location' } };
      }
      try {
        const u = new URL(src.finalUrl);
        for (const [k, v] of u.searchParams) {
          if (v === value && u.searchParams.getAll(k).length === 1) return { index: j, rule: { query: k } };
        }
      } catch {
        // not a URL we can read a query from.
      }
      if (src.finalUrl.includes(value)) {
        const regex = buildRegex(src.finalUrl, value);
        if (regex) return { index: j, rule: { regex, from: 'url' } };
      }
      if (src.body !== null && src.body.includes(value)) {
        const regex = buildRegex(src.body, value);
        if (regex) return { index: j, rule: { regex, from: 'body' } };
      }
    }
    return undefined;
  };

  for (let i = 0; i < chains.length; i++) {
    const { head, last, hops } = chains[i]!;
    const id = `q${i + 1}`;
    const url = new URL(head.url);
    const contentType = headerOf(head.requestHeaders, 'content-type') ?? '';
    const fieldValues: string[] = [...url.searchParams.values()];

    let form: [string, string][] | undefined;
    let json: unknown;
    let multipart: MultipartPart[] | undefined;
    let raw: string | undefined;
    if (head.postData !== undefined && head.postData !== '') {
      if (/application\/x-www-form-urlencoded/i.test(contentType)) {
        form = [...new URLSearchParams(head.postData)];
        fieldValues.push(...form.map(([, v]) => v));
      } else if (/json/i.test(contentType)) {
        try {
          json = JSON.parse(head.postData);
        } catch {
          raw = head.postData;
        }
      } else if (/multipart\/form-data/i.test(contentType)) {
        const boundary = /boundary=("?)([^";]+)\1/i.exec(contentType)?.[2];
        if (!boundary) throw new NotLinkable(`${id}: multipart body without a boundary`);
        multipart = parseMultipart(head.postData, boundary);
        fieldValues.push(...multipart.filter((p) => p.filename === undefined).map((p) => p.value));
      } else {
        raw = head.postData;
      }
    } else if (/multipart\/form-data/i.test(contentType)) {
      throw new NotLinkable(`${id}: the browser did not expose the upload body, so it cannot be replayed`);
    }

    const extract = new Map<string, ExtractRule>();
    extracts.push(extract);

    const bindValue = (value: string, key: string): string => {
      if (value.length === 0) return value;
      const matching = paramEntries.filter(([, v]) => v === value).map(([name]) => name);
      if (matching.length > 0) {
        const ambiguousField = value.length < MIN_SUBSTRING && fieldValues.filter((v) => v === value).length > 1;
        if (ambiguousField) {
          warnings.push(`${id} ${key}: too short to tell apart from other fields with the same value; left as recorded, bind it to {{${matching[0]!}}} by hand if it is the param`);
          return value;
        }
        if (matching.length > 1) {
          warnings.push(`${id} ${key}: value matches params ${matching.join(', ')}; bound to ${matching[0]!}, check it`);
        }
        return `{{${matching[0]!}}}`;
      }
      const known = varByValue.get(value);
      if (known) return `{{${known}}}`;
      if (value.length >= MIN_TRACE) {
        const traced = trace(value, key, i);
        if (traced) {
          const name = newVar(key);
          extracts[traced.index]!.set(name, traced.rule);
          varByValue.set(value, name);
          return `{{${name}}}`;
        }
        const cookie = input.cookies.find((c) => c.value === value);
        if (cookie) return `{{cookie:${cookie.name}}}`;
      }
      const bound = bindSubstrings(value);
      if (bound === value && looksLikeToken(value)) {
        // Held until pruning: a warning about a request that is dropped anyway
        // would send someone to fix nothing.
        tokenWarnings.push({ index: i, text: `${id} ${key}: sends a constant that looks like a token and was not found in any earlier response` });
      }
      return bound;
    };

    const bindJson = (node: unknown, key: string): unknown => {
      if (typeof node === 'string') return bindValue(node, key);
      if (typeof node === 'number') {
        const bound = bindValue(String(node), key);
        const whole = /^\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}$/.exec(bound);
        return whole ? `{{${whole[1]!}|number}}` : node;
      }
      if (Array.isArray(node)) return node.map((v) => bindJson(v, key));
      if (node !== null && typeof node === 'object') {
        return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, bindJson(v, k)]));
      }
      return node;
    };

    const request: RecipeRequest = {
      id,
      method: head.method.toUpperCase(),
      url: `${url.origin}${bindSubstrings(url.pathname, encodeURIComponent)}`,
    };
    const query = [...url.searchParams].map(([name, value]) => ({ name, value: bindValue(value, name) }));
    if (query.length > 0) request.query = query;

    const headers: Record<string, string> = {};
    for (const [rawName, value] of Object.entries(head.requestHeaders)) {
      const name = rawName.toLowerCase();
      if (name.startsWith(':') || name.startsWith('sec-') || name === 'cookie' || name === 'content-length' || name === 'host') continue;
      if (name === 'content-type' && multipart) continue;
      if (name === 'authorization') {
        const bound = bindValue(value, name);
        if (bound === value) throw new NotLinkable(`${id}: sends an Authorization header that no earlier response produced`);
        headers[name] = bound;
      } else if (name.startsWith('x-')) {
        headers[name] = bindValue(value, name);
      } else if (KEEP_HEADERS.has(name)) {
        headers[name] = bindSubstrings(value, encodeURIComponent);
      }
    }
    if (Object.keys(headers).length > 0) request.headers = headers;

    if (form) request.form = form.map(([name, value]) => ({ name, value: bindValue(value, name) }));
    if (json !== undefined) request.json = bindJson(json, 'json');
    if (raw !== undefined) request.raw = bindSubstrings(raw);
    if (multipart) {
      request.multipart = multipart.map((p): RecipePart => {
        if (p.filename === undefined) return { name: p.name, value: bindValue(p.value, p.name) };
        const param = input.uploads[p.filename];
        if (!param) throw new NotLinkable(`${id}: uploads a file (${p.name}) that is not one of the flow's upload params`);
        const part: RecipePart = { name: p.name, file: `{{${param}}}` };
        if (p.contentType) part.contentType = p.contentType;
        return part;
      });
    }
    const expect = statusClass(head.status);
    if (expect) request.expect = expect;
    if (head.resourceType !== 'document') request.xhr = true;
    out.push(request);

    const body = input.body(last);
    let parsedJson: unknown;
    if (body !== null && /json/i.test(last.mimeType ?? '')) {
      try {
        parsedJson = JSON.parse(body);
      } catch {
        parsedJson = undefined;
      }
    }
    const source: Source = {
      index: i,
      finalUrl: last.url,
      body: body !== null && TEXT_MIME.test(last.mimeType ?? '') ? body : null,
      json: parsedJson,
    };
    // Absolute, the way the runner sees it, so a rule built here matches there.
    const location = headerOf(hops[0]?.responseHeaders, 'location');
    if (location) source.location = new URL(location, head.url).href;
    sources.push(source);
  }

  // Keep what the replay needs, walking dependencies back from what matters.
  //
  // What matters: form submissions (document writes), the writes the flow
  // names in `expect.requests`, script writes that send a file, the last request (a read routine's product), and
  // responses that set cookies. Page scripts also POST on their own — Moodle
  // loads templates and polls state through ~30 POSTs a page — and those go,
  // unless something that matters reads from them. When the flow names no
  // expected request, every write stays: dropping the one that matters would
  // make a replay report success having done nothing.
  // A capture names a response the replay must fetch again, read or write.
  const captured = (input.captures ?? []).map((c) => c.request.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, n: string) => input.params[n] ?? m));
  // Pruning still answers only to what the author declared in expect.requests.
  const expected = input.expected ?? [];
  const varsOf = (request: RecipeRequest): string[] => {
    const text = JSON.stringify([request.url, request.query, request.form, request.json, request.multipart, request.raw, request.headers]);
    return [...text.matchAll(/\{\{\s*([^}|\s]+)/g)].map((m) => m[1]!);
  };
  // A script POST that sends a file is doing the work (the upload itself).
  // A parameter alone says little: Moodle's state and template calls all send
  // the course id, and so does every Referer.
  const carriesFile = (request: RecipeRequest): boolean => request.multipart?.some((p) => p.file !== undefined) ?? false;

  const sourceOf = new Map<string, number>();
  extracts.forEach((extract, i) => {
    for (const name of extract.keys()) sourceOf.set(name, i);
  });

  const required = new Set<number>();
  const dropped = new Set<string>();
  for (let i = 0; i < out.length; i++) {
    const request = out[i]!;
    const chain = chains[i]!;
    const setsCookie = chain.hops.some((h) => headerOf(h.responseHeaders, 'set-cookie') !== undefined);
    const write = isWriteRequest(request);
    const named = expected.some((p) => matchesRequestPattern(p, { method: chain.head.method, url: chain.head.url, status: chain.head.status }));
    const isCaptured = captured.some((p) => matchesRequestPattern(p, { method: chain.head.method, url: chain.head.url, status: chain.head.status }));
    const matters =
      i === out.length - 1 ||
      setsCookie ||
      isCaptured ||
      (write && (chain.head.resourceType === 'document' || expected.length === 0 || named || carriesFile(request)));
    if (matters) required.add(i);
    else if (write) dropped.add(`${request.method} ${new URL(chain.head.url).pathname}`);
  }
  // Whatever a kept request reads from must be kept too, transitively.
  const queue = [...required];
  while (queue.length > 0) {
    const i = queue.pop()!;
    for (const name of varsOf(out[i]!)) {
      const source = sourceOf.get(name);
      if (source !== undefined && !required.has(source)) {
        required.add(source);
        queue.push(source);
        dropped.delete(`${out[source]!.method} ${new URL(chains[source]!.head.url).pathname}`);
      }
    }
  }

  const usedVars = new Set([...required].flatMap((i) => varsOf(out[i]!)));
  const kept: RecipeRequest[] = [];
  for (let i = 0; i < out.length; i++) {
    if (!required.has(i)) continue;
    const request = out[i]!;
    const extract = [...extracts[i]!].filter(([name]) => usedVars.has(name));
    if (extract.length > 0) request.extract = Object.fromEntries(extract);
    kept.push(request);
  }
  warnings.push(...tokenWarnings.filter((w) => required.has(w.index)).map((w) => w.text));
  if (dropped.size > 0) {
    warnings.push(`dropped page-script POSTs that send no file and are not in the flow's expect.requests: ${[...dropped].join(', ')}`);
  } else if (expected.length === 0 && out.some((r, i) => isWriteRequest(r) && chains[i]!.head.resourceType !== 'document')) {
    warnings.push('kept every page-script POST: add expect.requests to the step whose write matters and link again to drop the rest');
  }

  const recipe: Recipe = {
    flow: input.flow,
    flowHash: input.flowHash,
    params: input.callerParams,
    requests: kept,
  };
  if (input.captures && input.captures.length > 0) {
    for (const [k, pattern] of captured.entries()) {
      const hit = chains.some((c) => matchesRequestPattern(pattern, { method: c.head.method, url: c.head.url, status: c.head.status }));
      if (!hit) throw new NotLinkable(`capture ${input.captures[k]!.as}: no request of the run matched ${pattern}`);
    }
    recipe.outputs = input.captures;
  }
  if (warnings.length > 0) recipe.warnings = warnings;
  assertNoCredentials(recipe, input);
  return recipe;
}

/** The last line of defence before a recipe touches disk. */
export function assertNoCredentials(recipe: Recipe, input: Pick<CompileInput, 'cookies' | 'containsSecret' | 'params' | 'secretParams' | 'requests'>): void {
  const text = stringifyRecipe(recipe);
  const leaks = (value: string): boolean =>
    value.length > 0 && (text.includes(value) || text.includes(encodeURIComponent(value)));

  if (input.containsSecret(text)) throw new NotLinkable('the recipe would contain a secret value; nothing was written');
  for (const name of input.secretParams) {
    const value = input.params[name];
    if (value !== undefined && leaks(value)) throw new NotLinkable(`the recipe would contain the secret param ${name}; nothing was written`);
  }
  for (const cookie of input.cookies) {
    if (cookie.value.length >= 8 && leaks(cookie.value)) {
      throw new NotLinkable(`the recipe would contain the value of cookie ${cookie.name}; nothing was written`);
    }
  }
  for (const req of input.requests) {
    const auth = headerOf(req.requestHeaders, 'authorization');
    if (auth && auth.length >= 8 && leaks(auth)) throw new NotLinkable('the recipe would contain an Authorization value; nothing was written');
  }
}
