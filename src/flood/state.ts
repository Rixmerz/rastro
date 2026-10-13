// What makes two page states "the same screen" for a flood, and how an element
// is named so it survives a reload. Pure: the worker and the coordinator both
// use it, and tests drive it without a browser.

import { createHash } from 'node:crypto';
import type { ViewItem } from '../perception/view.ts';

/** Path segments that are ids rather than structure. */
const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{20,})$/i;

/** `https://shop.test/orders/123?page=2#x` → `shop.test/orders/{id}`. Query
 * values and the fragment do not create new states; hash routes (`#/cart`)
 * do, since a hash-routed app has nothing else to tell its screens apart. */
export function urlTemplate(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const path = templatePath(parsed.pathname);
  const route = parsed.hash.startsWith('#/') ? `#${templatePath(parsed.hash.slice(1))}` : '';
  return `${parsed.host}${path}${route}`;
}

export function templatePath(pathname: string): string {
  const segments = pathname.split('/').map((s) => (s !== '' && ID_SEGMENT.test(s) ? '{id}' : s));
  return segments.join('/') || '/';
}

/** An endpoint's template: method-free, with the query's names (not values). */
export function endpointTemplate(url: string): { host: string; path: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { host: '', path: url };
  }
  const names = [...new Set([...parsed.searchParams.keys()])].sort();
  const query = names.length > 0 ? `?${names.map((n) => `${n}=`).join('&')}` : '';
  return { host: parsed.host, path: `${templatePath(parsed.pathname)}${query}` };
}

/** Names are compared lowercased, whitespace collapsed and digits folded, so a
 * counter («Carrito (3)») does not make a new element on every visit. */
export function normalizeName(name: string): string {
  return name.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim().replace(/\d+/g, '#').slice(0, 80);
}

export interface FloodElement {
  /** `role|name|region|ordinal`; stable across reloads, unlike a ref. */
  key: string;
  role: string;
  name: string;
  region: string;
  url?: string;
  disabled?: boolean;
  /** The ref in the snapshot this element was read from; valid only there. */
  ref: string;
}

export function elementKeys(items: ViewItem[]): FloodElement[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = `${item.role}|${normalizeName(item.name)}|${item.region}`;
    const ordinal = seen.get(base) ?? 0;
    seen.set(base, ordinal + 1);
    const el: FloodElement = { key: `${base}|${String(ordinal)}`, role: item.role, name: item.name, region: item.region, ref: item.ref };
    if (item.url !== undefined) el.url = item.url;
    if (item.disabled) el.disabled = true;
    return el;
  });
}

/**
 * A state's identity: its URL template plus its structure. Controls count by
 * name; links count only by region and order of magnitude, so two product
 * pages with different related-product links are one state, while a page
 * that gained a form or a dialog is another.
 */
export function stateHash(url: string, elements: FloodElement[]): string {
  const controls: string[] = [];
  const links = new Map<string, number>();
  for (const el of elements) {
    if (el.role === 'link') links.set(el.region, (links.get(el.region) ?? 0) + 1);
    else controls.push(`${el.role}|${normalizeName(el.name)}|${el.region}`);
  }
  const linkSig = [...links.entries()].map(([region, n]) => `${region}:${String(Math.ceil(Math.log2(n + 1)))}`).sort();
  const input = [urlTemplate(url), ...controls.sort(), ...linkSig].join('\n');
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}
