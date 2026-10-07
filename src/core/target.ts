// What a person types as a place to open, turned into a URL the browser takes.
//
// `page.goto` only accepts absolute URLs: `example.com`, `./index.html` and
// `/home/me/site/index.html` all fail with "Cannot navigate to invalid URL",
// and `--allow-write localhost:3000` never matched the `localhost` a request
// reports as its host. Both are normalised here, in one place for the CLI,
// the MCP server and the engine.

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RastroError } from './types.ts';

/** `scheme:` followed by anything but a digit: `about:blank`, `data:...`,
 * `https://...`. `localhost:3000` is a host and port, not a scheme. */
const SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function looksLikePath(raw: string): boolean {
  return raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../') || raw === '~' || raw.startsWith('~/');
}

/** Hosts a dev server lives on, which speak plain http. */
function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '0.0.0.0' || h === '[::1]') return true;
  const ip = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (!ip) return false;
  const a = Number(ip[1]);
  const b = Number(ip[2]);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * Turns `raw` into an absolute URL:
 * - a URL with a scheme is kept as is;
 * - a file path (`/abs`, `./rel`, `../rel`, `~/x`, or a bare name that is an
 *   existing file under `cwd`) becomes a `file://` URL — relative paths only
 *   when `cwd` is given, since the daemon's own cwd means nothing to the caller;
 * - anything else is a host: `http://` for localhost and private addresses,
 *   `https://` otherwise.
 */
export function toNavigableUrl(raw: string, cwd?: string): string {
  const input = raw.trim();
  if (!input) throw new RastroError('empty url');
  if (SCHEME.test(input)) return input;

  if (looksLikePath(input) || (cwd !== undefined && isFile(resolve(cwd, input)))) {
    let path = input === '~' || input.startsWith('~/') ? homedir() + input.slice(1) : input;
    if (!isAbsolute(path)) {
      if (cwd === undefined) throw new RastroError(`relative path ${input}`, 'pass an absolute path or a file:// URL');
      path = resolve(cwd, path);
    }
    if (!existsSync(path)) throw new RastroError(`no such file: ${path}`);
    return pathToFileURL(path).href;
  }

  const authority = input.split(/[/?#]/, 1)[0] ?? '';
  const host = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':')[0]!;
  return `${isLocalHost(host) ? 'http' : 'https'}://${input}`;
}

/**
 * The bare host of an allowlist entry, the way `URL.hostname` reports a
 * request's: `http://localhost:3000/app`, `localhost:3000` and `LOCALHOST.`
 * are all `localhost`. `*` is kept as is.
 */
export function allowlistHost(raw: string): string {
  let entry = raw.trim().toLowerCase();
  if (entry === '*') return entry;
  if (entry.includes('://')) {
    try {
      entry = new URL(entry).hostname;
    } catch {
      return '';
    }
  } else {
    entry = entry.split(/[/?#]/, 1)[0] ?? '';
    entry = entry.startsWith('[') ? entry.slice(0, entry.indexOf(']') + 1) : (entry.split(':')[0] ?? '');
  }
  return entry.endsWith('.') ? entry.slice(0, -1) : entry;
}

/**
 * `host` matches the allowlist exactly or as a subdomain; `*` allows any
 * host. An empty host or an empty/blank allowlist entry never matches
 * anything (S10) — otherwise `host.endsWith('.' + '')` is true for every
 * host, silently turning `['']` into an allow-all.
 */
export function hostAllowed(host: string, allowlist: string[]): boolean {
  if (allowlist.includes('*')) return true;
  const normalizedHost = allowlistHost(host);
  if (!normalizedHost) return false;
  return allowlist.some((raw) => {
    if (!raw) return false;
    const allowed = allowlistHost(raw);
    if (!allowed || allowed === '*') return false;
    return normalizedHost === allowed || normalizedHost.endsWith(`.${allowed}`);
  });
}
