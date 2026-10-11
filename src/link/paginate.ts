// Pagination: a GET that answered one page of a list, generalised to the rest.
// `flow link` only sees the pages the run fetched, which is usually the first;
// this spots the usual ways an API asks for the next one (a cursor handed out
// in the response, a next URL, a page number, an offset) so the replay can
// fetch them all. Reads only: a write never paginates.

import { selectJson } from '../flow/json-path.ts';
import type { Paginate } from './recipe.ts';

export const DEFAULT_MAX_PAGES = 10;

const CURSOR_KEY = /^(next_?cursor|next_?page_?token|next_?token|end_?cursor|cursor|after)$/i;
const CURSOR_PARAM = /^(cursor|after|page_?token|next_?token|next_?cursor|continuation(_?token)?|starting_?after)$/i;
const NEXT_URL_KEY = /^(next|next_?url|next_?page_?url|next_?link|@odata\.nextLink)$/i;
const PAGE_PARAM = /^(page|p|pg|page_?num(ber)?|page_?no)$/i;
const OFFSET_PARAM = /^(offset|skip|start|from)$/i;
const LIMIT_PARAM = /^(limit|size|per_?page|page_?size|count|rows|take|max|max_?results)$/i;
const PATH_TOKEN = /[^.[\]]+|\[\d+\]/g;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function joinPath(base: string, key: string): string {
  return base ? `${base}.${key}` : key;
}

/** The longest non-empty array within three levels: the page's items. */
function findItems(json: unknown): string | undefined {
  if (Array.isArray(json)) return json.length > 0 ? '' : undefined;
  let best: { path: string; length: number } | undefined;
  const walk = (node: unknown, path: string, depth: number): void => {
    if (!isRecord(node) || depth > 3) return;
    for (const [k, v] of Object.entries(node)) {
      if (!/^[A-Za-z_$][\w$-]*$/.test(k)) continue;
      const p = joinPath(path, k);
      if (Array.isArray(v)) {
        if (v.length > 0 && (!best || v.length > best.length)) best = { path: p, length: v.length };
      } else {
        walk(v, p, depth + 1);
      }
    }
  };
  walk(json, '', 1);
  return best?.path;
}

/** The first key matching `pattern` within three levels, outside the items. */
function findKey(json: unknown, pattern: RegExp, items: string): { path: string; value: unknown } | undefined {
  let found: { path: string; value: unknown } | undefined;
  const walk = (node: unknown, path: string, depth: number): void => {
    if (found || !isRecord(node) || depth > 3) return;
    for (const [k, v] of Object.entries(node)) {
      const p = joinPath(path, k);
      if (p === items) continue;
      if (pattern.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        found = { path: p, value: v };
        return;
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (/^[A-Za-z_$][\w$-]*$/.test(k)) walk(v, joinPath(path, k), depth + 1);
    }
  };
  walk(json, '', 1);
  return found;
}

function intParam(url: URL, pattern: RegExp): { name: string; value: number } | undefined {
  for (const [name, value] of url.searchParams) {
    if (pattern.test(name) && /^\d+$/.test(value)) return { name, value: Number(value) };
  }
  return undefined;
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || value.startsWith('/') || value.startsWith('?');
}

/**
 * How the request at `url`, which answered `json`, would ask for its next
 * page, or undefined when nothing says it is a page of something longer.
 */
export function detectPagination(url: string, json: unknown): Paginate | undefined {
  const items = findItems(json);
  if (items === undefined) return undefined;
  const u = new URL(url);

  const nextUrl = findKey(json, NEXT_URL_KEY, items);
  if (nextUrl && typeof nextUrl.value === 'string' && looksLikeUrl(nextUrl.value)) {
    try {
      if (new URL(nextUrl.value, u).origin === u.origin) return { next: { url: nextUrl.path }, items, maxPages: DEFAULT_MAX_PAGES };
    } catch {
      // not a URL after all.
    }
  }

  const cursorParam = [...u.searchParams.keys()].find((k) => CURSOR_PARAM.test(k));
  const cursor = findKey(json, CURSOR_KEY, items);
  if (cursorParam && cursor) return { query: cursorParam, next: { json: cursor.path }, items, maxPages: DEFAULT_MAX_PAGES };

  const page = intParam(u, PAGE_PARAM);
  if (page) return { query: page.name, next: { step: 1 }, items, maxPages: DEFAULT_MAX_PAGES };

  const offset = intParam(u, OFFSET_PARAM);
  if (offset) {
    const limit = intParam(u, LIMIT_PARAM)?.value ?? (selectJson(json, items) as unknown[]).length;
    if (limit > 0) return { query: offset.name, next: { step: limit }, items, maxPages: DEFAULT_MAX_PAGES };
  }
  return undefined;
}

export function describePagination(p: Paginate): string {
  if ('url' in p.next) return `follows ${p.next.url} to the next page`;
  if ('json' in p.next) return `passes ${p.next.json} back as ${p.query!}`;
  return `steps ${p.query!} by ${p.next.step}`;
}

/** The items of one page, or undefined when the path holds no array. */
export function pageItems(json: unknown, p: Paginate): unknown[] | undefined {
  const items = selectJson(json, p.items);
  return Array.isArray(items) ? items : undefined;
}

/**
 * The URL of the page after `current`, or undefined when there is none.
 * `firstLength` and `lastLength` are the item counts of the first page and of
 * the page just read: a numeric step stops at an empty or short page, since
 * nothing else says the list ended.
 */
export function nextPageUrl(p: Paginate, current: string, page: unknown, firstLength: number, lastLength: number): string | undefined {
  if (lastLength === 0) return undefined;
  const url = new URL(current);
  if ('url' in p.next) {
    const value = selectJson(page, p.next.url);
    if (typeof value !== 'string' || value === '') return undefined;
    const next = new URL(value, url);
    return next.origin === url.origin && next.href !== url.href ? next.href : undefined;
  }
  if ('json' in p.next) {
    const value = selectJson(page, p.next.json);
    if ((typeof value !== 'string' && typeof value !== 'number') || String(value) === '') return undefined;
    if (url.searchParams.get(p.query!) === String(value)) return undefined;
    url.searchParams.set(p.query!, String(value));
    return url.href;
  }
  if (lastLength < firstLength) return undefined;
  const now = Number(url.searchParams.get(p.query!) ?? NaN);
  if (!Number.isFinite(now)) return undefined;
  url.searchParams.set(p.query!, String(now + p.next.step));
  return url.href;
}

/** `root` with the array at `path` replaced by `items`. */
export function withItems(root: unknown, path: string, items: unknown[]): unknown {
  const tokens = path.match(PATH_TOKEN) ?? [];
  const set = (node: unknown, i: number): unknown => {
    if (i === tokens.length) return items;
    const token = tokens[i]!;
    if (token.startsWith('[')) {
      const copy = Array.isArray(node) ? [...(node as unknown[])] : [];
      const index = Number(token.slice(1, -1));
      copy[index] = set(copy[index], i + 1);
      return copy;
    }
    const copy: Record<string, unknown> = isRecord(node) ? { ...node } : {};
    copy[token] = set(copy[token], i + 1);
    return copy;
  };
  return set(root, 0);
}
